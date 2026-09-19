import { env } from 'cloudflare:test';
import { D1StateStore } from '@dicefunc/adapters';
import { CommandExecutor, DefaultEventHandler, createDefaultCommandRegistry } from '@dicefunc/core';
import type { DeliveryOutcome, PreparedReply, VerifiedEvent } from '@dicefunc/core';
import { type Mock, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../apps/worker/src/bindings.js';
import { queue } from '../../apps/worker/src/queue.js';
import { applyInitialSchema } from './helper.js';

type FakeMessage = {
  body: { jobId: string; type: 'command'; schemaVersion: number };
  ack: Mock;
  retry: Mock;
};

function makeMessage(jobId: string): FakeMessage {
  return {
    body: { jobId, type: 'command', schemaVersion: 1 },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

async function runQueue(
  msg: FakeMessage,
  botId: string,
  store: D1StateStore,
  send: (reply: PreparedReply) => Promise<DeliveryOutcome>,
): Promise<void> {
  const eventHandler = new DefaultEventHandler(
    store,
    new CommandExecutor(createDefaultCommandRegistry()),
  );
  const deps = {
    stateStore: store,
    eventHandler,
    replySender: { send },
    tokenProvider: {
      getAccessToken: async () => 'test_token',
    },
  };
  const envLike = { DB: env.DB, QQ_APP_ID: botId, ENVIRONMENT: 'test' } as unknown as Env;
  const batch = { messages: [msg] };
  await queue(batch as never, envLike, {} as never, deps as never);
}

function makeEvent(botId: string, suffix: string): VerifiedEvent {
  return {
    botId,
    scene: 'groupAt',
    eventId: `evt_delivery_${suffix}`,
    messageId: `msg_delivery_${suffix}`,
    externalId: `group_delivery_${suffix}`,
    timestamp: new Date(),
    text: '.r 1d100',
    sender: {
      scene: 'groupAt',
      scopeId: `group_delivery_${suffix}`,
      externalId: `user_delivery_${suffix}`,
    },
  };
}

describe('Queue consumer reply delivery integration', () => {
  let store: D1StateStore;

  beforeAll(async () => {
    await applyInitialSchema(env.DB);
    store = new D1StateStore(env.DB);
  });

  it('executes a claimed command and delivers the frozen reply to QQ', async () => {
    const botId = 'bot_delivery_happy';
    const claim = await store.claimEvent(makeEvent(botId, '1'), 'digest_delivery');

    const sent: PreparedReply[] = [];
    const msg = makeMessage(claim.jobId);
    await runQueue(msg, botId, store, async (reply) => {
      sent.push(reply);
      return { status: 'sent', platformMessageId: 'plat_msg_1' };
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text.length).toBeGreaterThan(0);
    expect(sent[0]?.targetId).toBe('group_delivery_1');
    expect(sent[0]?.scene).toBe('groupAt');
    expect(sent[0]?.originMessageId).toBe('msg_delivery_1');

    const outbox = await env.DB.prepare(
      'SELECT status, platform_message_id FROM outgoing_messages WHERE bot_id = ?1',
    )
      .bind(botId)
      .first<{ status: string; platform_message_id: string }>();
    expect(outbox?.status).toBe('sent');
    expect(outbox?.platform_message_id).toBe('plat_msg_1');

    const job = await env.DB.prepare('SELECT status FROM jobs WHERE bot_id = ?1 AND id = ?2')
      .bind(botId, claim.jobId)
      .first<{ status: string }>();
    expect(job?.status).toBe('completed');
    expect(msg.ack).toHaveBeenCalled();
  });

  it('keeps the queue message when background dispatch holds the job lease', async () => {
    const botId = 'bot_delivery_background_lease';
    const claim = await store.claimEvent(makeEvent(botId, 'background_lease'), 'digest_delivery');
    const lease = await store.acquireJob(botId, claim.jobId, 60);
    expect(lease).not.toBeNull();

    const msg = makeMessage(claim.jobId);
    await runQueue(msg, botId, store, async () => ({
      status: 'sent',
      platformMessageId: 'unused',
    }));

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('keeps reply pending on retryable outcome and resumes delivery without re-rolling', async () => {
    const botId = 'bot_delivery_retry';
    const claim = await store.claimEvent(makeEvent(botId, '2'), 'digest_delivery');

    const msg1 = makeMessage(claim.jobId);
    await runQueue(msg1, botId, store, async () => ({
      status: 'retryable',
      errorCode: 'HTTP_500',
    }));

    expect(msg1.retry).toHaveBeenCalled();
    expect(msg1.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(msg1.ack).not.toHaveBeenCalled();
    const pending = await env.DB.prepare('SELECT status FROM outgoing_messages WHERE bot_id = ?1')
      .bind(botId)
      .first<{ status: string }>();
    expect(pending?.status).toBe('pending');

    await env.DB.prepare(
      "UPDATE jobs SET next_attempt_at = datetime('now', '-1 seconds') WHERE bot_id = ?1 AND id = ?2",
    )
      .bind(botId, claim.jobId)
      .run();

    const sent: PreparedReply[] = [];
    const msg2 = makeMessage(claim.jobId);
    await runQueue(msg2, botId, store, async (reply) => {
      sent.push(reply);
      return { status: 'sent', platformMessageId: 'plat_msg_2' };
    });

    expect(sent).toHaveLength(1);
    expect(msg2.ack).toHaveBeenCalled();

    const resultCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM command_results WHERE bot_id = ?1',
    )
      .bind(botId)
      .first<{ n: number }>();
    expect(Number(resultCount?.n)).toBe(1);

    const outbox = await env.DB.prepare('SELECT status FROM outgoing_messages WHERE bot_id = ?1')
      .bind(botId)
      .first<{ status: string }>();
    expect(outbox?.status).toBe('sent');
  });
});
