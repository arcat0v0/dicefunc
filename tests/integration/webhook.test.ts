import { env } from 'cloudflare:test';
import { D1StateStore, handleQQWebhook } from '@dicefunc/adapters';
import type { JobQueue, LogEvent, RuntimeLogger } from '@dicefunc/core';
import { beforeAll, describe, expect, it } from 'vitest';
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

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const len = clean.length;
  const bytes = new Uint8Array(Math.floor(len / 2));
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = Number.parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
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
  let keyPair: CryptoKeyPair;
  let publicKeyHex: string;
  let privateKeyHex: string;
  const logger = new SilentLogger();
  const botId = 'bot_webhook_test';
  const configDigest = 'digest_webhook_test';

  beforeAll(async () => {
    await applyInitialSchema(env.DB);
    store = new D1StateStore(env.DB);

    keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;

    const pubBuffer = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    publicKeyHex = bytesToHex(new Uint8Array(pubBuffer));

    const privBuffer = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    privateKeyHex = bytesToHex(new Uint8Array(privBuffer));
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
    const signature = await signPayload(keyPair.privateKey, timestamp, bodyBytes);

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
        publicKeyHex,
        privateKeyHex,
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
    const signature = await signPayload(keyPair.privateKey, timestamp, bodyBytes);

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
        publicKeyHex,
        privateKeyHex,
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
    const signature = await signPayload(keyPair.privateKey, timestamp, originalBytes);

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
        publicKeyHex,
        privateKeyHex,
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
        publicKeyHex,
        privateKeyHex,
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
        publicKeyHex,
        privateKeyHex,
        configDigest,
      },
      logger,
    );
    expect(resultNoTs.status).toBe(401);
  });

  it('handles op:13 challenge and returns verifiable signature over plain_token', async () => {
    const queue = new RecordingJobQueue();
    const timestamp = '1710000004';
    const plainToken = 'challenge_test_token_abc';
    const payloadObj = {
      op: 13,
      d: {
        plain_token: plainToken,
      },
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
    const signature = await signPayload(keyPair.privateKey, timestamp, bodyBytes);

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
        publicKeyHex,
        privateKeyHex,
        configDigest,
      },
      logger,
    );

    expect(result.status).toBe(200);
    const body = result.body as { plain_token: string; signature: string };
    expect(body.plain_token).toBe(plainToken);
    expect(typeof body.signature).toBe('string');

    const challengeSigBytes = hexToBytes(body.signature);
    const verified = await crypto.subtle.verify(
      { name: 'Ed25519' },
      keyPair.publicKey,
      challengeSigBytes,
      new TextEncoder().encode(plainToken),
    );
    expect(verified).toBe(true);
  });
});
