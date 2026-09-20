import type {
  Clock,
  EventClaim,
  JobQueue,
  Principal,
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
  readonly botSecret: string | null;
  readonly configDigest: string;
  readonly clock?: Clock | undefined;
}

export interface QQWebhookResult {
  readonly status: number;
  readonly body: unknown;
  readonly enqueuedJobId?: string | undefined;
  readonly preloaded?:
    | {
        readonly verifiedEvent: VerifiedEvent;
        readonly claim: EventClaim;
      }
    | undefined;
}

const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

const HEX_PATTERN = /^[0-9a-f]{128}$/;

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

function hexEqualsConstantTime(expectedHex: string, providedHex: string): boolean {
  let diff = expectedHex.length ^ providedHex.length;
  const len = Math.max(expectedHex.length, providedHex.length);
  for (let i = 0; i < len; i++) {
    const a = expectedHex.charCodeAt(i) || 0;
    const b = providedHex.charCodeAt(i) || 0;
    diff |= a ^ b;
  }
  return diff === 0;
}

async function signHex(privateKey: CryptoKey, message: Uint8Array): Promise<string> {
  const sigBuffer = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message);
  return bytesToHex(new Uint8Array(sigBuffer));
}

export async function handleQQWebhook(
  input: QQWebhookInput,
  deps: QQWebhookDependencies,
  logger: RuntimeLogger,
): Promise<QQWebhookResult> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(input.rawBody)) as Record<string, unknown>;
  } catch {
    return { status: 400, body: { ret: -1, msg: 'bad request' } };
  }

  if (payload.op === 13) {
    const d = (payload.d ?? {}) as Record<string, unknown>;
    const plainToken = typeof d.plain_token === 'string' ? d.plain_token : '';
    const eventTs = typeof d.event_ts === 'string' ? d.event_ts : '';
    if (!plainToken || !eventTs) {
      return { status: 400, body: { ret: -1, msg: 'bad request' } };
    }
    if (!deps.botSecret) {
      logger.log(
        buildLogEntry({
          level: 'error',
          event: 'qq.webhook.challenge_failed',
          component: 'qq-webhook',
          environment: 'production',
          outcome: 'missing_credentials',
        }),
      );
      return { status: 500, body: { ret: -1, msg: 'missing credentials' } };
    }

    const privateKey = await privateKeyFromSecret(deps.botSecret);
    const sigHex = await signHex(privateKey, new TextEncoder().encode(eventTs + plainToken));

    return {
      status: 200,
      body: {
        plain_token: plainToken,
        signature: sigHex,
      },
    };
  }

  if (!input.signature || !input.timestamp || !deps.botSecret) {
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

  let valid = false;
  try {
    const providedHex = input.signature.toLowerCase();
    if (HEX_PATTERN.test(providedHex)) {
      const privateKey = await privateKeyFromSecret(deps.botSecret);
      const tsBytes = new TextEncoder().encode(input.timestamp);
      const rawBytes = new Uint8Array(input.rawBody);
      const msgBytes = new Uint8Array(tsBytes.length + rawBytes.length);
      msgBytes.set(tsBytes, 0);
      msgBytes.set(rawBytes, tsBytes.length);
      const expectedHex = await signHex(privateKey, msgBytes);
      valid = hexEqualsConstantTime(expectedHex, providedHex);
    }
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

  if (payload.op === 12) {
    return { status: 200, body: { ret: 0 } };
  }

  if (payload.op === 0) {
    const t = typeof payload.t === 'string' ? payload.t : '';
    const d = (payload.d ?? {}) as Record<string, unknown>;

    if (t === 'C2C_MSG_RECEIVE' || t === 'C2C_MSG_REJECT') {
      const userOpenid = typeof d.openid === 'string' ? d.openid : '';
      if (!userOpenid) {
        return { status: 400, body: { ret: -1, msg: 'bad request' } };
      }
      const eventId =
        typeof payload.id === 'string'
          ? payload.id
          : `${t}:${typeof d.timestamp === 'number' ? d.timestamp : input.timestamp}`;
      await deps.stateStore.setC2cActiveAuthorization(
        deps.botId,
        userOpenid,
        t === 'C2C_MSG_RECEIVE',
        eventId,
      );
      logger.log(
        buildLogEntry({
          level: 'info',
          event: 'qq.c2c.authorization_changed',
          component: 'qq-webhook',
          environment: 'production',
          outcome: t === 'C2C_MSG_RECEIVE' ? 'enabled' : 'disabled',
        }),
      );
      return { status: 200, body: { ret: 0, msg: 'ok' } };
    }

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
    const author = (d.author ?? {}) as Record<string, unknown>;
    const member = (d.member ?? {}) as Record<string, unknown>;
    const rawRole =
      (typeof author.member_role === 'string' && author.member_role.trim()) ||
      (typeof author.role === 'string' && author.role.trim()) ||
      (typeof member.role === 'string' && member.role.trim()) ||
      (Array.isArray(member.roles) &&
        typeof member.roles[0] === 'string' &&
        member.roles[0].trim()) ||
      (typeof d.member_role === 'string' && d.member_role.trim()) ||
      undefined;
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
    const mentions: Principal[] = [];
    if (scene !== 'c2c' && Array.isArray(d.mentions)) {
      const seenMentionIds = new Set<string>();
      for (const value of d.mentions) {
        if (!value || typeof value !== 'object') {
          continue;
        }
        const mention = value as Record<string, unknown>;
        const mentionedExternalId =
          (typeof mention.member_openid === 'string' && mention.member_openid.trim()) ||
          (typeof mention.user_openid === 'string' && mention.user_openid.trim()) ||
          (typeof mention.openid === 'string' && mention.openid.trim()) ||
          (typeof mention.id === 'string' && mention.id.trim()) ||
          '';
        if (
          !mentionedExternalId ||
          mentionedExternalId === deps.botId ||
          mentionedExternalId === senderExternalId ||
          seenMentionIds.has(mentionedExternalId)
        ) {
          continue;
        }
        seenMentionIds.add(mentionedExternalId);
        const mentionedName =
          (typeof mention.username === 'string' && mention.username.trim()) ||
          (typeof mention.name === 'string' && mention.name.trim()) ||
          undefined;
        mentions.push({
          scene,
          scopeId: externalId,
          externalId: mentionedExternalId,
          ...(mentionedName ? { name: mentionedName } : {}),
        });
      }
    }

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
        name:
          typeof author.username === 'string' && author.username.trim()
            ? author.username.trim()
            : typeof author.name === 'string' && author.name.trim()
              ? author.name.trim()
              : undefined,
        ...(rawRole ? { role: rawRole } : {}),
      },
      ...(mentions.length > 0 ? { mentions } : {}),
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

      return {
        status: 200,
        body: { ret: 0, msg: 'ok' },
        enqueuedJobId: claim.jobId,
        preloaded: { verifiedEvent, claim },
      };
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
