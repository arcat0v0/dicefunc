import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import migration001 from '../../migrations/001_initial_schema.sql?raw';
import migration002 from '../../migrations/002_outgoing_message_payload.sql?raw';
import migration003 from '../../migrations/003_hidden_roll_bindings.sql?raw';
import migration004 from '../../migrations/004_sender_role.sql?raw';
import migration005 from '../../migrations/005_story_log_item_uniqueness.sql?raw';
import migration006 from '../../migrations/006_sealdice_story_log.sql?raw';

async function applyMigration(sql: string): Promise<void> {
  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => env.DB.prepare(statement));
  await env.DB.batch(statements);
}

it('migrates existing story log items to the SealDice-compatible record shape', async () => {
  await applyMigration(migration001);
  await applyMigration(migration002);
  await applyMigration(migration003);
  await applyMigration(migration004);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO conversations (id, bot_id, scene, external_id)
      VALUES ('conv_migration_005', 'bot_migration_005', 'groupAt', 'group_migration_005')
    `),
    env.DB.prepare(`
      INSERT INTO story_logs (id, bot_id, conversation_id, name, status)
      VALUES ('log_migration_005', 'bot_migration_005', 'conv_migration_005', '测试', 'recording')
    `),
    env.DB.prepare(`
      INSERT INTO story_log_items (
        id, bot_id, log_id, sequence_number, direction, source_id, text, delivery_status
      ) VALUES (
        'item_migration_005_1', 'bot_migration_005', 'log_migration_005', 1,
        'inbound', 'user_migration_005', 'first', 'sent'
      )
    `),
  ]);

  await applyMigration(migration005);
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE story_log_items
      SET chunk_id = 'chunk_migration_005'
      WHERE id = 'item_migration_005_1'
    `),
    env.DB.prepare(`
      INSERT INTO log_archives (
        id, bot_id, log_id, snapshot_cursor, format, object_key, digest, status
      ) VALUES (
        'archive_migration_005', 'bot_migration_005', 'log_migration_005', 1,
        'json', 'archives/archive_migration_005.manifest.json', 'old_digest', 'uploading'
      )
    `),
    env.DB.prepare(`
      INSERT INTO story_chunks (
        id, bot_id, log_id, first_seq, last_seq, object_key, sha256, bytes
      ) VALUES (
        'chunk_migration_005', 'bot_migration_005', 'log_migration_005', 1, 1,
        'log_migration_005/1-1.jsonl', 'old_digest', 100
      )
    `),
    env.DB.prepare(`
      INSERT INTO jobs (
        id, bot_id, type, resource_id, status, attempts, max_attempts,
        next_attempt_at, deadline, fencing_token
      ) VALUES (
        'job_archive_migration_005', 'bot_migration_005', 'archive-chunk',
        'archive_migration_005', 'processing', 2, 5, datetime('now'),
        datetime('now', '+1 day'), '2'
      )
    `),
  ]);
  await applyMigration(migration006);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO story_log_items (
        id, bot_id, log_id, sequence_number, sequence_part, direction,
        source_id, nickname, im_user_id, uniform_id, message_time, text,
        is_dice, raw_msg_id, delivery_status
      ) VALUES (
        'item_migration_005_2', 'bot_migration_005', 'log_migration_005', 2, 0,
        'inbound', 'user_migration_005', '调查员', 'user_migration_005',
        'user_migration_005', 1789862400, 'second', 0, 'message_2', 'sent'
      )
    `),
    env.DB.prepare(`
      INSERT INTO story_log_items (
        id, bot_id, log_id, sequence_number, sequence_part, direction,
        source_id, nickname, im_user_id, uniform_id, message_time, text,
        is_dice, raw_msg_id, delivery_status
      ) VALUES (
        'item_migration_005_3', 'bot_migration_005', 'log_migration_005', 2, 1,
        'outbound', 'bot_migration_005', '守秘海豹', 'bot_migration_005',
        'bot_migration_005', 1789862401, 'reply', 1, 'reply_2', 'sent'
      )
    `),
  ]);

  const rows = await env.DB.prepare(`
    SELECT sequence_number, sequence_part, source_id, nickname, im_user_id,
           uniform_id, message_time, is_dice, text
    FROM story_log_items
    WHERE bot_id = 'bot_migration_005'
    ORDER BY sequence_number, sequence_part
  `).all<{
    sequence_number: number;
    sequence_part: number;
    source_id: string;
    nickname: string;
    im_user_id: string;
    uniform_id: string;
    message_time: number;
    is_dice: number;
    text: string;
  }>();

  expect(rows.results).toHaveLength(3);
  expect(rows.results[0]).toMatchObject({
    sequence_number: 1,
    sequence_part: 0,
    source_id: 'user_migration_005',
    nickname: 'user_migration_005',
    im_user_id: 'user_migration_005',
    uniform_id: 'user_migration_005',
    is_dice: 0,
    text: 'first',
  });
  expect(rows.results.slice(1)).toEqual([
    {
      sequence_number: 2,
      sequence_part: 0,
      source_id: 'user_migration_005',
      nickname: '调查员',
      im_user_id: 'user_migration_005',
      uniform_id: 'user_migration_005',
      message_time: 1789862400,
      is_dice: 0,
      text: 'second',
    },
    {
      sequence_number: 2,
      sequence_part: 1,
      source_id: 'bot_migration_005',
      nickname: '守秘海豹',
      im_user_id: 'bot_migration_005',
      uniform_id: 'bot_migration_005',
      message_time: 1789862401,
      is_dice: 1,
      text: 'reply',
    },
  ]);

  const cutover = await env.DB.prepare(`
    SELECT
      (SELECT format FROM log_archives WHERE id = 'archive_migration_005') AS format,
      (SELECT status FROM log_archives WHERE id = 'archive_migration_005') AS archive_status,
      (SELECT status FROM jobs WHERE id = 'job_archive_migration_005') AS job_status,
      (SELECT chunk_id FROM story_log_items WHERE id = 'item_migration_005_1') AS chunk_id,
      (SELECT COUNT(*) FROM story_chunks WHERE log_id = 'log_migration_005') AS chunk_count
  `).first<{
    format: string;
    archive_status: string;
    job_status: string;
    chunk_id: string | null;
    chunk_count: number;
  }>();
  expect(cutover).toEqual({
    format: 'txt',
    archive_status: 'pending',
    job_status: 'pending',
    chunk_id: null,
    chunk_count: 0,
  });
});
