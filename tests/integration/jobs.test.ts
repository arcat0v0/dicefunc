import { env } from 'cloudflare:test';
import { D1StateStore } from '@dicefunc/adapters';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyInitialSchema } from './helper.js';

describe('Jobs lifecycle and fencing integration', () => {
  let store: D1StateStore;

  beforeAll(async () => {
    await applyInitialSchema(env.DB);
    store = new D1StateStore(env.DB);
  });

  it('acquires job atomically, allows re-acquire after lease expires with incremented fencing, and rejects old fencing tokens', async () => {
    const botId = 'bot_test_jobs';
    const jobId = 'job_test_fence_1';

    await env.DB.prepare(`
      INSERT INTO jobs (
        id, bot_id, type, resource_id, status, attempts, max_attempts,
        next_attempt_at, deadline, fencing_token, created_at, updated_at
      ) VALUES (
        ?1, ?2, 'command', 'res_1', 'pending', 0, 3,
        datetime('now', '-10 seconds'), datetime('now', '+300 seconds'), '0',
        datetime('now'), datetime('now')
      )
    `)
      .bind(jobId, botId)
      .run();

    const lease1 = await store.acquireJob(botId, jobId, 10);
    expect(lease1).not.toBeNull();
    expect(lease1?.fencingToken).toBe(1);

    const lease2 = await store.acquireJob(botId, jobId, 10);
    expect(lease2).toBeNull();

    await env.DB.prepare(
      "UPDATE jobs SET lease_expires_at = datetime('now', '-5 seconds') WHERE bot_id = ?1 AND id = ?2",
    )
      .bind(botId, jobId)
      .run();

    const lease3 = await store.acquireJob(botId, jobId, 10);
    expect(lease3).not.toBeNull();
    expect(lease3?.fencingToken).toBe(2);

    const oldComplete = await store.completeJob(botId, jobId, 1, 'completed');
    expect(oldComplete).toBe(false);

    const newComplete = await store.completeJob(botId, jobId, 2, 'completed');
    expect(newComplete).toBe(true);

    const finalRow = await env.DB.prepare(
      'SELECT status, fencing_token FROM jobs WHERE bot_id = ?1 AND id = ?2',
    )
      .bind(botId, jobId)
      .first<{ status: string; fencing_token: string }>();
    expect(finalRow?.status).toBe('completed');
    expect(Number.parseInt(finalRow?.fencing_token ?? '0', 10)).toBe(2);
  });
});
