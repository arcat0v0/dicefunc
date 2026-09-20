import { env } from 'cloudflare:test';
import { D1StateStore } from '@dicefunc/adapters';
import {
  CommandExecutor,
  DefaultEventHandler,
  createDefaultCommandRegistry,
  hashHiddenRollLinkToken,
} from '@dicefunc/core';
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

  it('binds group and C2C principals before delivering a hidden roll', async () => {
    const botId = 'bot_delivery_hidden_bound';
    const userId = 'user_delivery_hidden_bound';
    await store.setC2cActiveAuthorization(botId, userId, true, 'evt_hidden_auth_enabled');

    const c2cEvent: VerifiedEvent = {
      ...makeEvent(botId, 'hidden_c2c_bind'),
      scene: 'c2c',
      externalId: userId,
      text: '.rhbind',
      sender: {
        scene: 'c2c',
        scopeId: userId,
        externalId: userId,
      },
    };
    const c2cClaim = await store.claimEvent(c2cEvent, 'digest_delivery');
    const c2cReplies: PreparedReply[] = [];
    await runQueue(makeMessage(c2cClaim.jobId), botId, store, async (reply) => {
      c2cReplies.push(reply);
      return { status: 'sent', platformMessageId: 'plat_msg_hidden_token' };
    });
    const token = c2cReplies[0]?.text.match(/绑定令牌：([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toHaveLength(43);

    if (!token) {
      throw new Error('hidden-roll link token was not generated');
    }
    const groupBindEvent = {
      ...makeEvent(botId, 'hidden_group_bound'),
      text: `.rhbind ${token}`,
    };
    const bindClaim = await store.claimEvent(groupBindEvent, 'digest_delivery');
    const bindReplies: PreparedReply[] = [];
    await runQueue(makeMessage(bindClaim.jobId), botId, store, async (reply) => {
      bindReplies.push(reply);
      return { status: 'sent', platformMessageId: 'plat_msg_hidden_binding' };
    });
    expect(bindReplies[0]?.text).toContain('绑定成功');
    expect(
      await store.findHiddenRollLinkChallenge(
        botId,
        await hashHiddenRollLinkToken(token),
        new Date(),
      ),
    ).toBeNull();

    const groupRollEvent: VerifiedEvent = {
      ...groupBindEvent,
      eventId: 'evt_delivery_hidden_group_roll',
      messageId: 'msg_delivery_hidden_group_roll',
      text: '.rh d20 秘密行动',
    };
    const rollClaim = await store.claimEvent(groupRollEvent, 'digest_delivery');
    const delivered: PreparedReply[] = [];
    const rollMessage = makeMessage(rollClaim.jobId);
    await runQueue(rollMessage, botId, store, async (reply) => {
      delivered.push(reply);
      return { status: 'sent', platformMessageId: `plat_msg_hidden_${reply.part}` };
    });

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatchObject({
      scene: 'c2c',
      targetId: userId,
      templateKey: 'dice.hidden.roll',
      deliveryMode: 'active',
    });
    expect(delivered[0]?.originMessageId).toBeUndefined();
    expect(delivered[0]?.text).toMatch(/^1d20 = \[\d+\] = \d+ 秘密行动$/);
    expect(delivered[1]).toMatchObject({
      scene: 'groupAt',
      targetId: 'group_delivery_hidden_group_bound',
      templateKey: 'dice.hidden.group_sent',
      text: '暗骰已完成，结果已私聊发送。',
    });

    const outbox = await env.DB.prepare(
      'SELECT part, status FROM outgoing_messages WHERE bot_id = ?1 AND execution_id = ?2 ORDER BY part',
    )
      .bind(botId, `exec_${groupRollEvent.eventId}`)
      .all<{ part: number; status: string }>();
    expect(outbox.results).toEqual([
      { part: 1, status: 'sent' },
      { part: 2, status: 'sent' },
      { part: 3, status: 'skipped' },
    ]);
    expect(rollMessage.ack).toHaveBeenCalled();

    const unbindEvent: VerifiedEvent = {
      ...groupBindEvent,
      eventId: 'evt_delivery_hidden_group_unbind',
      messageId: 'msg_delivery_hidden_group_unbind',
      text: '.rhbind off',
    };
    const unbindClaim = await store.claimEvent(unbindEvent, 'digest_delivery');
    const unbindReplies: PreparedReply[] = [];
    await runQueue(makeMessage(unbindClaim.jobId), botId, store, async (reply) => {
      unbindReplies.push(reply);
      return { status: 'sent', platformMessageId: 'plat_msg_hidden_unbound' };
    });
    expect(unbindReplies[0]?.text).toBe('已解除本群暗骰私聊绑定。');

    const binding = await env.DB.prepare(
      'SELECT status, version FROM hidden_roll_bindings WHERE bot_id = ?1',
    )
      .bind(botId)
      .first<{ status: string; version: number }>();
    expect(binding).toEqual({ status: 'revoked', version: 2 });
  });

  it('reports active C2C delivery failure without exposing the hidden result', async () => {
    const botId = 'bot_delivery_hidden_failure';
    const userId = 'user_delivery_hidden_failure';
    const groupEvent = {
      ...makeEvent(botId, 'hidden_failure'),
      text: '.rh d20 秘密行动',
    };
    const groupPrincipalId = `prin_${botId}_groupAt_${groupEvent.externalId}_${groupEvent.sender.externalId}`;
    await store.setC2cActiveAuthorization(botId, userId, true, 'evt_hidden_failure_auth');
    await env.DB.prepare(`
      INSERT INTO hidden_roll_bindings (
        id, bot_id, group_scope_id, group_principal_id, c2c_principal_id,
        user_openid, status, version, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', 1, datetime('now'), datetime('now'))
    `)
      .bind(
        'binding_hidden_failure',
        botId,
        groupEvent.externalId,
        groupPrincipalId,
        'c2c_principal_hidden_failure',
        userId,
      )
      .run();

    const claim = await store.claimEvent(groupEvent, 'digest_delivery');
    const attempted: PreparedReply[] = [];
    const msg = makeMessage(claim.jobId);
    await runQueue(msg, botId, store, async (reply) => {
      attempted.push(reply);
      if (reply.deliveryMode === 'active') {
        return { status: 'failed', errorCode: 'HTTP_403' };
      }
      return { status: 'sent', platformMessageId: 'plat_msg_hidden_failure_notice' };
    });

    const outbox = await env.DB.prepare(
      'SELECT part, status FROM outgoing_messages WHERE bot_id = ?1 ORDER BY part',
    )
      .bind(botId)
      .all<{ part: number; status: string }>();
    expect(outbox.results).toEqual([
      { part: 1, status: 'failed' },
      { part: 2, status: 'skipped' },
      { part: 3, status: 'sent' },
    ]);
    expect(attempted).toHaveLength(2);
    expect(attempted[0]?.text).toMatch(/^1d20 = \[\d+\] = \d+ 秘密行动$/);
    expect(attempted[1]).toMatchObject({
      scene: 'groupAt',
      templateKey: 'dice.hidden.group_failed',
      text: '暗骰结果私聊发送失败，结果未在群内公开。请检查主动消息授权后重试。',
    });
    expect(attempted[1]?.text).not.toContain('[');

    expect(msg.ack).toHaveBeenCalled();
  });

  it('delivers C2C hidden-roll results only to the current C2C principal', async () => {
    const botId = 'bot_delivery_hidden_c2c';
    const userId = 'user_delivery_hidden_c2c';
    const event: VerifiedEvent = {
      ...makeEvent(botId, 'hidden_c2c'),
      scene: 'c2c',
      externalId: userId,
      text: '.rh d20 秘密行动',
      sender: {
        scene: 'c2c',
        scopeId: userId,
        externalId: userId,
      },
    };
    const claim = await store.claimEvent(event, 'digest_delivery');

    const sent: PreparedReply[] = [];
    const msg = makeMessage(claim.jobId);
    await runQueue(msg, botId, store, async (reply) => {
      sent.push(reply);
      return { status: 'sent', platformMessageId: 'plat_msg_hidden_c2c' };
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      scene: 'c2c',
      targetId: userId,
      templateKey: 'dice.hidden.roll',
    });
    expect(sent[0]?.text).toMatch(/^1d20 = \[\d+\] = \d+ 秘密行动$/);

    const result = await env.DB.prepare(
      'SELECT result_type, result_data FROM command_results WHERE bot_id = ?1',
    )
      .bind(botId)
      .first<{ result_type: string; result_data: string }>();
    expect(result?.result_type).toBe('dice_roll');
    expect(JSON.parse(result?.result_data ?? '{}')).toMatchObject({ hidden: true });
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
