import type {
  Clock,
  JobQueue,
  RuntimeLogger,
  SceneType,
  StateStore,
  VerifiedEvent,
} from '@dicefunc/core';
import { buildLogEntry } from '@dicefunc/core';

export interface QQWebhookInput {
  readonly rawBody: ArrayBuffer;
  readonly signature?: string | undefined;
  readonly timestamp?: string | undefined;
}

export interface QQWebhookDependencies {
  readonly stateStore: StateStore;
  readonly queue: JobQueue;
  readonly botId: string;
  readonly publicKeyHex: string | null;
  readonly privateKeyHex: string | null;
  readonly configDigest: string;
  readonly clock?: Clock | undefined;
}

export interface QQWebhookResult {
  readonly status: number;
  readonly body: unknown;
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

export async function handleQQWebhook(
  input: QQWebhookInput,
  deps: QQWebhookDependencies,
  logger: RuntimeLogger,
): Promise<QQWebhookResult> {
  if (!input.signature || !input.timestamp || !deps.publicKeyHex) {
    logger.log(
      buildLogEntry({
        level: 'warn',
        event: 'qq.webhook.unauthorized',
        component: 'qq-webhook',
        environment: 'production',
        outcome: 'missing_credentials',
      }),
    );
    return { status: 401, body: { ret: -1, msg: 'unauthorized' } };
  }

  const pubKeyBytes = hexToBytes(deps.publicKeyHex);
  const sigBytes = hexToBytes(input.signature);
  const tsBytes = new TextEncoder().encode(input.timestamp);
  const rawBytes = new Uint8Array(input.rawBody);
  const msgBytes = new Uint8Array(tsBytes.length + rawBytes.length);
  msgBytes.set(tsBytes, 0);
  msgBytes.set(rawBytes, tsBytes.length);

  let valid = false;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      pubKeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify({ name: 'Ed25519' }, cryptoKey, sigBytes, msgBytes);
  } catch {
    valid = false;
  }

  if (!valid) {
    logger.log(
      buildLogEntry({
        level: 'warn',
        event: 'qq.webhook.invalid_signature',
        component: 'qq-webhook',
        environment: 'production',
        outcome: 'invalid_signature',
      }),
    );
    return { status: 401, body: { ret: -1, msg: 'invalid signature' } };
  }

  let payload: Record<string, unknown>;
  try {
    const decoded = new TextDecoder().decode(input.rawBody);
    payload = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return { status: 400, body: { ret: -1, msg: 'bad request' } };
  }

  if (payload.op === 13) {
    const d = payload.d as { plain_token?: string } | undefined;
    const plainToken = d?.plain_token;
    if (typeof plainToken !== 'string' || !deps.privateKeyHex) {
      logger.log(
        buildLogEntry({
          level: 'error',
          event: 'qq.webhook.challenge_failed',
          component: 'qq-webhook',
          environment: 'production',
          outcome: 'missing_private_key',
        }),
      );
      return { status: 500, body: { ret: -1, msg: 'missing private key' } };
    }

    const rawPrivBytes = hexToBytes(deps.privateKeyHex);
    let pkcs8Bytes: Uint8Array;
    if (rawPrivBytes.length === 32) {
      const prefix = new Uint8Array([
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
      ]);
      pkcs8Bytes = new Uint8Array(prefix.length + 32);
      pkcs8Bytes.set(prefix);
      pkcs8Bytes.set(rawPrivBytes, prefix.length);
    } else {
      pkcs8Bytes = rawPrivBytes;
    }

    const privKey = await crypto.subtle.importKey('pkcs8', pkcs8Bytes, { name: 'Ed25519' }, false, [
      'sign',
    ]);
    const sigBuffer = await crypto.subtle.sign(
      { name: 'Ed25519' },
      privKey,
      new TextEncoder().encode(plainToken),
    );
    const sigHex = bytesToHex(new Uint8Array(sigBuffer));

    return {
      status: 200,
      body: {
        plain_token: plainToken,
        signature: sigHex,
      },
    };
  }

  if (payload.op === 12) {
    return { status: 200, body: { ret: 0 } };
  }

  if (payload.op === 0) {
    const t = typeof payload.t === 'string' ? payload.t : '';
    let scene: SceneType;
    if (t === 'GROUP_AT_MESSAGE_CREATE') {
      scene = 'groupAt';
    } else if (t === 'GROUP_MESSAGE_CREATE') {
      scene = 'groupAll';
    } else if (t === 'C2C_MESSAGE_CREATE') {
      scene = 'c2c';
    } else {
      return { status: 200, body: { ret: 0 } };
    }

    const d = (payload.d ?? {}) as Record<string, unknown>;
    const author = (d.author ?? {}) as Record<string, unknown>;

    const eventId =
      typeof payload.id === 'string' ? payload.id : typeof d.id === 'string' ? d.id : '';

    const messageId = typeof d.id === 'string' ? d.id : eventId;

    let externalId: string;
    let senderExternalId: string;
    let senderScopeId: string;

    if (scene === 'c2c') {
      externalId = typeof author.user_openid === 'string' ? author.user_openid : '';
      senderExternalId = externalId;
      senderScopeId = externalId;
    } else {
      externalId = typeof d.group_openid === 'string' ? d.group_openid : '';
      const memberOpenid =
        typeof author.member_openid === 'string' ? author.member_openid : undefined;
      const userOpenid = typeof author.user_openid === 'string' ? author.user_openid : '';
      senderExternalId = memberOpenid ?? userOpenid;
      senderScopeId = externalId;
    }

    const text = typeof d.content === 'string' ? d.content : '';

    let timestamp: Date;
    if (typeof d.timestamp === 'string' || typeof d.timestamp === 'number') {
      timestamp = new Date(d.timestamp);
    } else if (deps.clock) {
      timestamp = deps.clock.now();
    } else {
      timestamp = new Date();
    }

    const verifiedEvent: VerifiedEvent = {
      botId: deps.botId,
      scene,
      eventId,
      messageId,
      externalId,
      timestamp,
      text,
      sender: {
        scene,
        scopeId: senderScopeId,
        externalId: senderExternalId,
      },
    };

    const claim = await deps.stateStore.claimEvent(verifiedEvent, deps.configDigest);
    if (claim.alreadyProcessed) {
      return { status: 200, body: { ret: 0, msg: 'ack' } };
    }

    try {
      await deps.queue.enqueueCommand({
        jobId: claim.jobId,
        type: 'command',
        schemaVersion: 1,
      });

      logger.log(
        buildLogEntry({
          level: 'info',
          event: 'qq.webhook.enqueued',
          component: 'qq-webhook',
          environment: 'production',
          jobId: claim.jobId,
          outcome: 'enqueued',
        }),
      );

      return { status: 200, body: { ret: 0, msg: 'ok' } };
    } catch {
      logger.log(
        buildLogEntry({
          level: 'error',
          event: 'qq.webhook.enqueue_failed',
          component: 'qq-webhook',
          environment: 'production',
          jobId: claim.jobId,
          outcome: 'enqueue_failed',
          errorCode: 'QUEUE_ERROR',
        }),
      );
      return { status: 500, body: { ret: -1, msg: 'queue error' } };
    }
  }

  return { status: 200, body: { ret: 0 } };
}
