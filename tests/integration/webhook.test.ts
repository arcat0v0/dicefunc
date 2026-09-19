import { env } from 'cloudflare:test';
import { D1StateStore, handleQQWebhook } from '@dicefunc/adapters';
import type { JobQueue, LogEvent, RuntimeLogger } from '@dicefunc/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../apps/worker/src/bindings.js';
import { createHttpApp } from '../../apps/worker/src/http.js';
import type { WorkerDependencies } from '../../apps/worker/src/index.js';
import { applyInitialSchema } from './helper.js';

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b !== undefined) {
      hex += b.toString(16).padStart(2, '0');
    }
  }
  return hex;
}

const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function seedFromSecret(secret: string): Uint8Array {
  let seed = new TextEncoder().encode(secret);
  while (seed.length < 32) {
    const doubled = new Uint8Array(seed.length * 2);
    doubled.set(seed, 0);
    doubled.set(seed, seed.length);
    seed = doubled;
  }
  return seed.slice(0, 32);
}

async function privateKeyFromSecret(secret: string): Promise<CryptoKey> {
  const seed = seedFromSecret(secret);
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX, 0);
  pkcs8.set(seed, PKCS8_PREFIX.length);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

async function signPayload(
  privateKey: CryptoKey,
  timestamp: string,
  rawBody: Uint8Array,
): Promise<string> {
  const tsBytes = new TextEncoder().encode(timestamp);
  const msgBytes = new Uint8Array(tsBytes.length + rawBody.length);
  msgBytes.set(tsBytes, 0);
  msgBytes.set(rawBody, tsBytes.length);

  const sigBuffer = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, msgBytes);
  return bytesToHex(new Uint8Array(sigBuffer));
}

class RecordingJobQueue implements JobQueue {
  readonly enqueued: Array<{ jobId: string; type: 'command'; schemaVersion: number }> = [];

  async enqueueCommand(cmd: {
    jobId: string;
    type: 'command';
    schemaVersion: number;
  }): Promise<void> {
    this.enqueued.push(cmd);
  }

  async enqueueArchive(): Promise<void> {}
}

class SilentLogger implements RuntimeLogger {
  log(_entry: LogEvent): boolean {
    return true;
  }
  child(_fields: Partial<LogEvent>): RuntimeLogger {
    return this;
  }
}

describe('QQ Webhook handler integration', () => {
  let store: D1StateStore;
  let privateKey: CryptoKey;
  const botSecret = 'WebhookTestSecret01';
  const logger = new SilentLogger();
  const botId = 'bot_webhook_test';
  const configDigest = 'digest_webhook_test';

  beforeAll(async () => {
    await applyInitialSchema(env.DB);
    store = new D1StateStore(env.DB);
    privateKey = await privateKeyFromSecret(botSecret);
  });

  it('processes op:0 GROUP_AT_MESSAGE_CREATE, writes DB, and enqueues command', async () => {
    const queue = new RecordingJobQueue();
    const timestamp = '1710000000';
    const payloadObj = {
      op: 0,
      id: 'evt_group_at_1',
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'msg_group_at_1',
        group_openid: 'group_test_openid_1',
        content: '.r 1d100',
        author: {
          member_openid: 'member_test_openid_1',
          user_openid: 'user_test_openid_1',
        },
      },
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
    const signature = await signPayload(privateKey, timestamp, bodyBytes);

    const result = await handleQQWebhook(
      {
        rawBody: bodyBytes.buffer,
        signature,
        timestamp,
      },
      {
        stateStore: store,
        queue,
        botId,
        botSecret,
        configDigest,
      },
      logger,
    );

    expect(result.status).toBe(200);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.type).toBe('command');
    expect(queue.enqueued[0]?.schemaVersion).toBe(1);

    const eventRow = await env.DB.prepare(
      'SELECT id, event_id, status FROM received_events WHERE bot_id = ?1 AND event_id = ?2',
    )
      .bind(botId, 'evt_group_at_1')
      .first<{ id: string; event_id: string; status: string }>();
    expect(eventRow?.event_id).toBe('evt_group_at_1');

    const jobRow = await env.DB.prepare(
      'SELECT id, type, status FROM jobs WHERE bot_id = ?1 AND id = ?2',
    )
      .bind(botId, queue.enqueued[0]?.jobId)
      .first<{ id: string; type: string; status: string }>();
    expect(jobRow?.type).toBe('command');

    const convRow = await env.DB.prepare(
      'SELECT scene, external_id FROM conversations WHERE bot_id = ?1 AND scene = ?2 AND external_id = ?3',
    )
      .bind(botId, 'groupAt', 'group_test_openid_1')
      .first<{ scene: string; external_id: string }>();
    expect(convRow?.scene).toBe('groupAt');
  });

  it('acknowledges while background command execution remains pending', async () => {
    const jobQueue = new RecordingJobQueue();
    const runtimeStore = new D1StateStore(env.DB);
    const send = vi.fn();
    const dependencies = {
      stateStore: runtimeStore,
      jobQueue,
      logger,
      eventHandler: {
        executeClaimed: vi.fn(() => new Promise(() => {})),
      },
      tokenProvider: {
        getAccessToken: vi.fn(async () => 'test_token'),
      },
      replySender: { send },
    } as unknown as WorkerDependencies;
    const workerEnv = {
      DB: env.DB,
      QQ_APP_ID: 'bot_webhook_queue_owned',
      QQ_APP_SECRET: botSecret,
      ENVIRONMENT: 'test',
    } as unknown as Env;
    const payload = {
      op: 0,
      id: 'evt_webhook_queue_owned',
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'msg_webhook_queue_owned',
        content: '.r 1d100',
        author: {
          user_openid: 'user_webhook_queue_owned',
        },
      },
    };
    const timestamp = '1710000099';
    const bodyBytes = new TextEncoder().encode(JSON.stringify(payload));
    const signature = await signPayload(privateKey, timestamp, bodyBytes);
    const waitUntil = vi.fn();
    const app = createHttpApp(dependencies);

    const response = await app.fetch(
      new Request('https://worker.test/webhooks/qq', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-Ed25519': signature,
          'X-Signature-Timestamp': timestamp,
        },
        body: bodyBytes,
      }),
      workerEnv,
      { waitUntil } as never,
    );

    expect(response.status).toBe(200);
    expect(jobQueue.enqueued).toHaveLength(1);
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();

    const beforeQueue = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM outgoing_messages WHERE bot_id = ?1',
    )
      .bind(workerEnv.QQ_APP_ID)
      .first<{ n: number }>();
    expect(Number(beforeQueue?.n)).toBe(0);
  });

  it('maps C2C_MESSAGE_CREATE to c2c scene and external_id correctly', async () => {
    const queue = new RecordingJobQueue();
    const timestamp = '1710000001';
    const payloadObj = {
      op: 0,
      id: 'evt_c2c_1',
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'msg_c2c_1',
        content: '.help',
        author: {
          user_openid: 'user_c2c_openid_1',
        },
      },
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
    const signature = await signPayload(privateKey, timestamp, bodyBytes);

    const result = await handleQQWebhook(
      {
        rawBody: bodyBytes.buffer,
        signature,
        timestamp,
      },
      {
        stateStore: store,
        queue,
        botId,
        botSecret,
        configDigest,
      },
      logger,
    );

    expect(result.status).toBe(200);

    const convRow = await env.DB.prepare(
      'SELECT scene, external_id FROM conversations WHERE bot_id = ?1 AND scene = ?2 AND external_id = ?3',
    )
      .bind(botId, 'c2c', 'user_c2c_openid_1')
      .first<{ scene: string; external_id: string }>();
    expect(convRow?.scene).toBe('c2c');
    expect(convRow?.external_id).toBe('user_c2c_openid_1');
  });

  it('returns 401 when body is tampered', async () => {
    const queue = new RecordingJobQueue();
    const timestamp = '1710000002';
    const originalBytes = new TextEncoder().encode(JSON.stringify({ op: 0, test: 'original' }));
    const signature = await signPayload(privateKey, timestamp, originalBytes);

    const tamperedBytes = new TextEncoder().encode(JSON.stringify({ op: 0, test: 'tampered' }));

    const result = await handleQQWebhook(
      {
        rawBody: tamperedBytes.buffer,
        signature,
        timestamp,
      },
      {
        stateStore: store,
        queue,
        botId,
        botSecret,
        configDigest,
      },
      logger,
    );

    expect(result.status).toBe(401);
  });

  it('returns 401 when headers are missing', async () => {
    const queue = new RecordingJobQueue();
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ op: 0 }));

    const resultNoSig = await handleQQWebhook(
      {
        rawBody: bodyBytes.buffer,
        timestamp: '1710000003',
      },
      {
        stateStore: store,
        queue,
        botId,
        botSecret,
        configDigest,
      },
      logger,
    );
    expect(resultNoSig.status).toBe(401);

    const resultNoTs = await handleQQWebhook(
      {
        rawBody: bodyBytes.buffer,
        signature: 'abcdef',
      },
      {
        stateStore: store,
        queue,
        botId,
        botSecret,
        configDigest,
      },
      logger,
    );
    expect(resultNoTs.status).toBe(401);
  });

  it('answers op:13 challenge per official vector, without requiring signature headers', async () => {
    const queue = new RecordingJobQueue();
    const bodyBytes = new TextEncoder().encode(
      JSON.stringify({
        op: 13,
        d: { plain_token: 'Arq0D5A61EgUu4OxUvOp', event_ts: '1725442341' },
      }),
    );

    const result = await handleQQWebhook(
      { rawBody: bodyBytes.buffer },
      {
        stateStore: store,
        queue,
        botId,
        botSecret: 'DG5g3B4j9X2KOErG',
        configDigest,
      },
      logger,
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      plain_token: 'Arq0D5A61EgUu4OxUvOp',
      signature:
        '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706',
    });
  });

  it('accepts an event signed per the official timestamp+body scheme', async () => {
    const queue = new RecordingJobQueue();
    const docSecret = 'naOC0ocQE3shWLAfffVLB1rhYPG7';
    const timestamp = '1725442341';
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ op: 12 }));
    const docKey = await privateKeyFromSecret(docSecret);
    const signature = await signPayload(docKey, timestamp, bodyBytes);

    const result = await handleQQWebhook(
      { rawBody: bodyBytes.buffer, signature, timestamp },
      {
        stateStore: store,
        queue,
        botId,
        botSecret: docSecret,
        configDigest,
      },
      logger,
    );

    expect(result.status).toBe(200);
  });

  it('returns 400 for op:13 with missing challenge fields', async () => {
    const queue = new RecordingJobQueue();
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ op: 13, d: {} }));

    const result = await handleQQWebhook(
      { rawBody: bodyBytes.buffer },
      {
        stateStore: store,
        queue,
        botId,
        botSecret,
        configDigest,
      },
      logger,
    );

    expect(result.status).toBe(400);
  });
});
