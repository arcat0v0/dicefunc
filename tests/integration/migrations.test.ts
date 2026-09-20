import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import migration001 from '../../migrations/001_initial_schema.sql?raw';
import migration002 from '../../migrations/002_outgoing_message_payload.sql?raw';
import migration003 from '../../migrations/003_hidden_roll_bindings.sql?raw';
import migration004 from '../../migrations/004_sender_role.sql?raw';
import migration005 from '../../migrations/005_story_log_item_uniqueness.sql?raw';

async function applyMigration(sql: string): Promise<void> {
  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => env.DB.prepare(statement));
  await env.DB.batch(statements);
}

it('preserves existing story log items while allowing later items from the same source', async () => {
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

  await env.DB.prepare(`
    INSERT INTO story_log_items (
      id, bot_id, log_id, sequence_number, direction, source_id, text, delivery_status
    ) VALUES (
      'item_migration_005_2', 'bot_migration_005', 'log_migration_005', 2,
      'inbound', 'user_migration_005', 'second', 'sent'
    )
  `).run();

  const rows = await env.DB.prepare(`
    SELECT sequence_number, source_id, text
    FROM story_log_items
    WHERE bot_id = 'bot_migration_005'
    ORDER BY sequence_number
  `).all<{ sequence_number: number; source_id: string; text: string }>();

  expect(rows.results).toEqual([
    { sequence_number: 1, source_id: 'user_migration_005', text: 'first' },
    { sequence_number: 2, source_id: 'user_migration_005', text: 'second' },
  ]);
});
