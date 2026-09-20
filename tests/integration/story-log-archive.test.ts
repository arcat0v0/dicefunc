import { env } from 'cloudflare:test';
import { D1StateStore, R2ArchiveStore } from '@dicefunc/adapters';
import { CommandExecutor, DefaultEventHandler, createDefaultCommandRegistry } from '@dicefunc/core';
import type {
  DeliveryOutcome,
  JobQueue,
  LogEvent,
  PreparedReply,
  QueueMessage,
  RuntimeLogger,
  VerifiedEvent,
} from '@dicefunc/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../apps/worker/src/bindings.js';
import { createHttpApp } from '../../apps/worker/src/http.js';
import type { WorkerDependencies } from '../../apps/worker/src/index.js';
import { queue } from '../../apps/worker/src/queue.js';
import { applyInitialSchema } from './helper.js';

class RecordingJobQueue implements JobQueue {
  readonly archives: QueueMessage[] = [];

  async enqueueCommand(): Promise<void> {}

  async enqueueArchive(message: QueueMessage): Promise<void> {
    this.archives.push(message);
  }
}

class SilentLogger implements RuntimeLogger {
  log(_entry: LogEvent): boolean {
    return true;
  }

  child(_fields: Partial<LogEvent>): RuntimeLogger {
    return this;
  }
}

function makeMessage(jobId: string, type: 'command' | 'archive-chunk') {
  return {
    body: { jobId, type, schemaVersion: 1 },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe('Story log archive download integration', () => {
  let store: D1StateStore;

  beforeAll(async () => {
    await applyInitialSchema(env.DB);
    store = new D1StateStore(env.DB);
  });

  it('archives a closed log and serves it through a short-lived signed link', async () => {
    const botId = 'bot_story_archive';
    const groupId = 'group_story_archive';
    const userId = 'user_story_archive';
    const jobQueue = new RecordingJobQueue();
    const logger = new SilentLogger();
    const archiveStore = new R2ArchiveStore(env.STORY_LOG_BUCKET);
    const replies: PreparedReply[] = [];
    const eventHandler = new DefaultEventHandler(
      store,
      new CommandExecutor(createDefaultCommandRegistry()),
      undefined,
      undefined,
      undefined,
      'https://worker.test',
    );
    const dependencies = {
      stateStore: store,
      jobQueue,
      archiveStore,
      logger,
      eventHandler,
      replySender: {
        async send(reply: PreparedReply): Promise<DeliveryOutcome> {
          replies.push(reply);
          return { status: 'sent', platformMessageId: `platform_${replies.length}` };
        },
      },
      tokenProvider: {
        getAccessToken: async () => 'test_token',
      },
    } as unknown as WorkerDependencies;
    const workerEnv = {
      DB: env.DB,
      STORY_LOG_BUCKET: env.STORY_LOG_BUCKET,
      QQ_APP_ID: botId,
      QQ_APP_SECRET: 'test_secret',
      BOT_TIMEZONE: 'UTC',
      ENVIRONMENT: 'test',
    } as unknown as Env;

    let eventNumber = 0;
    const processCommand = async (suffix: string, text: string): Promise<void> => {
      eventNumber += 1;
      const event: VerifiedEvent = {
        botId,
        scene: 'groupAt',
        eventId: `evt_story_archive_${suffix}`,
        messageId: `msg_story_archive_${suffix}`,
        externalId: groupId,
        timestamp: new Date(`2026-09-20T00:00:0${eventNumber}Z`),
        text,
        sender: {
          scene: 'groupAt',
          scopeId: groupId,
          externalId: userId,
          name: '调查员',
          role: 'owner',
        },
      };
      const claim = await store.claimEvent(event, 'digest_story_archive');
      const message = makeMessage(claim.jobId, 'command');
      await queue({ messages: [message] } as never, workerEnv, {} as never, dependencies);
      expect(message.ack).toHaveBeenCalled();
    };

    await processCommand('new', '.log new 测试');
    await processCommand('roll', '.r 1d6');
    await processCommand('end', '.log end');

    expect(jobQueue.archives).toHaveLength(1);
    const archiveJob = jobQueue.archives[0];
    expect(archiveJob?.type).toBe('archive-chunk');
    const archiveMessage = makeMessage(archiveJob?.jobId ?? '', 'archive-chunk');
    await queue({ messages: [archiveMessage] } as never, workerEnv, {} as never, dependencies);
    expect(archiveMessage.ack).toHaveBeenCalled();

    const archive = await env.DB.prepare(`
      SELECT id, status, format, digest
      FROM log_archives
      WHERE bot_id = ?1
      LIMIT 1
    `)
      .bind(botId)
      .first<{ id: string; status: string; format: string; digest: string }>();
    expect(archive?.status).toBe('ready');
    expect(archive?.format).toBe('txt');
    expect(archive?.digest).toMatch(/^[a-f0-9]{64}$/);

    await processCommand('export', '.log export');
    const exportReply = replies.at(-1)?.text ?? '';
    expect(exportReply).toContain('下载链接（15 分钟内有效）');
    const downloadUrl = exportReply.split('\n').at(-1) ?? '';
    expect(downloadUrl).toMatch(
      /^https:\/\/worker\.test\/archives\/archive_log_.+\?token=[A-Za-z0-9_-]{43}$/,
    );

    const app = createHttpApp(dependencies);
    const unauthorizedResponse = await app.fetch(
      new Request(`https://worker.test/archives/${archive?.id ?? ''}`),
      workerEnv,
      {} as never,
    );
    expect(unauthorizedResponse.status).toBe(404);
    const response = await app.fetch(new Request(downloadUrl), workerEnv, {} as never);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-disposition')).toContain('.txt');
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const body = await response.text();
    expect(replies).toHaveLength(4);
    expect(body).toMatch(
      /^Dicefunc\(bot_story_archive\) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n已创建并开启跑团日志「测试」。\n\n/,
    );
    expect(body).toContain('调查员(user_story_archive) 2026-09-20 00:00:02\n.r 1d6\n\n');
    expect(body).toContain(`\n${replies[1]?.text}\n\n`);
    expect(body).toContain('调查员(user_story_archive) 2026-09-20 00:00:03\n.log end\n\n');
    expect(body).not.toContain('.log new 测试');
    expect(body).not.toContain(replies[2]?.text ?? '跑团日志「测试」已关闭');

    const audit = await env.DB.prepare(`
      SELECT action, result
      FROM log_audit_events
      WHERE bot_id = ?1 AND resource_id = ?2 AND action = 'archive.download'
      LIMIT 1
    `)
      .bind(botId, archive?.id ?? '')
      .first<{ action: string; result: string }>();
    expect(audit).toEqual({ action: 'archive.download', result: 'success' });
  });

  it('creates a recoverable archive for a log closed before archive support', async () => {
    const botId = 'bot_story_archive_legacy';
    const groupId = 'group_story_archive_legacy';
    const userId = 'user_story_archive_legacy';
    const conversationId = `conv_${botId}_groupAt_${groupId}`;
    const logId = 'log_story_archive_legacy';
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO conversations (id, bot_id, scene, external_id)
        VALUES (?1, ?2, 'groupAt', ?3)
      `).bind(conversationId, botId, groupId),
      env.DB.prepare(`
        INSERT INTO story_logs (id, bot_id, conversation_id, name, status, revision, cursor)
        VALUES (?1, ?2, ?3, '旧日志', 'closed', 2, 0)
      `).bind(logId, botId, conversationId),
      env.DB.prepare(`
        INSERT INTO story_log_items (
          id, bot_id, log_id, sequence_number, direction, source_id, text, delivery_status
        )
        VALUES (
          'item_story_archive_legacy', ?1, ?2, 1, 'inbound',
          'message_story_archive_legacy', '旧记录', 'sent'
        )
      `).bind(botId, logId),
    ]);

    const jobQueue = new RecordingJobQueue();
    const dependencies = {
      stateStore: store,
      jobQueue,
      archiveStore: new R2ArchiveStore(env.STORY_LOG_BUCKET),
      logger: new SilentLogger(),
      eventHandler: new DefaultEventHandler(
        store,
        new CommandExecutor(createDefaultCommandRegistry()),
        undefined,
        undefined,
        undefined,
        'https://worker.test',
      ),
      replySender: {
        async send(): Promise<DeliveryOutcome> {
          return { status: 'sent', platformMessageId: 'platform_legacy_export' };
        },
      },
      tokenProvider: {
        getAccessToken: async () => 'test_token',
      },
    } as unknown as WorkerDependencies;
    const workerEnv = {
      DB: env.DB,
      STORY_LOG_BUCKET: env.STORY_LOG_BUCKET,
      QQ_APP_ID: botId,
      ENVIRONMENT: 'test',
    } as unknown as Env;
    const event: VerifiedEvent = {
      botId,
      scene: 'groupAt',
      eventId: 'evt_story_archive_legacy_export',
      messageId: 'msg_story_archive_legacy_export',
      externalId: groupId,
      timestamp: new Date(),
      text: '.log export',
      sender: {
        scene: 'groupAt',
        scopeId: groupId,
        externalId: userId,
        role: 'owner',
      },
    };
    const claim = await store.claimEvent(event, 'digest_story_archive_legacy');
    const commandMessage = makeMessage(claim.jobId, 'command');
    await queue({ messages: [commandMessage] } as never, workerEnv, {} as never, dependencies);
    expect(commandMessage.ack).toHaveBeenCalled();
    expect(jobQueue.archives).toHaveLength(1);

    const archiveJob = jobQueue.archives[0];
    const archiveMessage = makeMessage(archiveJob?.jobId ?? '', 'archive-chunk');
    await queue({ messages: [archiveMessage] } as never, workerEnv, {} as never, dependencies);
    expect(archiveMessage.ack).toHaveBeenCalled();
    const archive = await env.DB.prepare(`
      SELECT status
      FROM log_archives
      WHERE bot_id = ?1 AND log_id = ?2
      LIMIT 1
    `)
      .bind(botId, logId)
      .first<{ status: string }>();
    expect(archive?.status).toBe('ready');
  });
  it('continues a large archive across bounded queue deliveries', async () => {
    const botId = 'bot_story_archive_paged';
    const conversationId = 'conv_story_archive_paged';
    const logId = 'log_story_archive_paged';
    const archiveId = 'archive_story_archive_paged';
    const jobId = 'job_archive_story_archive_paged';
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO conversations (id, bot_id, scene, external_id)
        VALUES (?1, ?2, 'groupAt', 'group_story_archive_paged')
      `).bind(conversationId, botId),
      env.DB.prepare(`
        INSERT INTO story_logs (id, bot_id, conversation_id, name, status, revision, cursor)
        VALUES (?1, ?2, ?3, '分页日志', 'closed', 2, 0)
      `).bind(logId, botId, conversationId),
      env.DB.prepare(`
        INSERT INTO log_archives (
          id, bot_id, log_id, snapshot_cursor, format, object_key, digest, status
        )
        VALUES (?1, ?2, ?3, 101, 'json', ?4, '', 'pending')
      `).bind(archiveId, botId, logId, `archives/${archiveId}.manifest.json`),
      env.DB.prepare(`
        INSERT INTO jobs (
          id, bot_id, type, resource_id, status, attempts, max_attempts,
          next_attempt_at, deadline, fencing_token
        )
        VALUES (
          ?1, ?2, 'archive-chunk', ?3, 'pending', 0, 5,
          datetime('now'), datetime('now', '+1 day'), '0'
        )
      `).bind(jobId, botId, archiveId),
    ]);
    const itemStatements = Array.from({ length: 101 }, (_, index) => {
      const sequence = index + 1;
      return env.DB.prepare(`
        INSERT INTO story_log_items (
          id, bot_id, log_id, sequence_number, direction, source_id, text, delivery_status
        )
        VALUES (?1, ?2, ?3, ?4, 'inbound', ?5, ?6, 'sent')
      `).bind(
        `item_story_archive_paged_${sequence}`,
        botId,
        logId,
        sequence,
        `message_story_archive_paged_${sequence}`,
        `记录 ${sequence}`,
      );
    });
    await env.DB.batch(itemStatements.slice(0, 60));
    await env.DB.batch(itemStatements.slice(60));

    const jobQueue = new RecordingJobQueue();
    const dependencies = {
      stateStore: store,
      jobQueue,
      archiveStore: new R2ArchiveStore(env.STORY_LOG_BUCKET),
      logger: new SilentLogger(),
    } as unknown as WorkerDependencies;
    const workerEnv = {
      DB: env.DB,
      STORY_LOG_BUCKET: env.STORY_LOG_BUCKET,
      QQ_APP_ID: botId,
      ENVIRONMENT: 'test',
    } as unknown as Env;

    const firstMessage = makeMessage(jobId, 'archive-chunk');
    await queue({ messages: [firstMessage] } as never, workerEnv, {} as never, dependencies);
    expect(firstMessage.ack).toHaveBeenCalled();
    expect(jobQueue.archives).toEqual([{ jobId, type: 'archive-chunk', schemaVersion: 1 }]);
    expect((await store.getJob(botId, jobId))?.status).toBe('pending');

    const secondMessage = makeMessage(jobId, 'archive-chunk');
    await queue({ messages: [secondMessage] } as never, workerEnv, {} as never, dependencies);
    expect(secondMessage.ack).toHaveBeenCalled();
    expect((await store.getJob(botId, jobId))?.status).toBe('completed');

    const chunks = await env.DB.prepare(`
      SELECT first_seq, last_seq
      FROM story_chunks
      WHERE bot_id = ?1 AND log_id = ?2
      ORDER BY first_seq
    `)
      .bind(botId, logId)
      .all<{ first_seq: number; last_seq: number }>();
    expect(chunks.results).toEqual([
      { first_seq: 1, last_seq: 100 },
      { first_seq: 101, last_seq: 101 },
    ]);
    const archive = await env.DB.prepare(`
      SELECT status
      FROM log_archives
      WHERE bot_id = ?1 AND id = ?2
    `)
      .bind(botId, archiveId)
      .first<{ status: string }>();
    expect(archive?.status).toBe('ready');
  });
});
