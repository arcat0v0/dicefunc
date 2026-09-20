import { QQReplySender, type QQTokenProvider } from '@dicefunc/adapters';
import type { PreparedReply } from '@dicefunc/core';
import { describe, expect, it } from 'vitest';

describe('QQReplySender integration', () => {
  const fakeTokenProvider = {
    getAccessToken: async (_forceRefresh?: boolean) => 'mock_token_abc',
    invalidate: () => {},
  } as unknown as QQTokenProvider;

  it('routes group messages to /v2/groups/{openid}/messages with msg_id and msg_seq', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    let capturedAuth = '';

    const fakeHttpClient = async (url: string, init: RequestInit): Promise<Response> => {
      capturedUrl = url;
      capturedAuth = (init.headers as Record<string, string>)?.Authorization ?? '';
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 'platform_msg_group_1' }), { status: 200 });
    };

    const sender = new QQReplySender({
      tokenProvider: fakeTokenProvider,
      httpClient: fakeHttpClient,
    });

    const reply: PreparedReply = {
      executionId: 'exec_group_1',
      part: 1,
      msgSeq: 42,
      scene: 'groupAt',
      targetId: 'group_target_openid_123',
      originMessageId: 'origin_group_msg_789',
      templateKey: 'r.success',
      text: 'Dice roll: 1d100 = 85',
      deadline: new Date(Date.now() + 60000),
    };

    const outcome = await sender.send(reply);
    expect(outcome.status).toBe('sent');
    expect(capturedUrl).toBe(
      'https://api.sgroup.qq.com/v2/groups/group_target_openid_123/messages',
    );
    expect(capturedAuth).toBe('QQBot mock_token_abc');
    expect(capturedBody.content).toBe('Dice roll: 1d100 = 85');
    expect(capturedBody.msg_type).toBe(0);
    expect(capturedBody.msg_id).toBe('origin_group_msg_789');
    expect(capturedBody.msg_seq).toBe(42);
  });

  it('routes C2C messages to /v2/users/{openid}/messages', async () => {
    let capturedUrl = '';

    const fakeHttpClient = async (url: string): Promise<Response> => {
      capturedUrl = url;
      return new Response(JSON.stringify({ id: 'platform_msg_c2c_1' }), { status: 200 });
    };

    const sender = new QQReplySender({
      tokenProvider: fakeTokenProvider,
      httpClient: fakeHttpClient,
    });

    const reply: PreparedReply = {
      executionId: 'exec_c2c_1',
      part: 1,
      msgSeq: 1,
      scene: 'c2c',
      targetId: 'user_target_openid_456',
      originMessageId: 'origin_c2c_msg_101',
      templateKey: 'help.info',
      text: 'Help text',
      deadline: new Date(Date.now() + 60000),
    };

    const outcome = await sender.send(reply);
    expect(outcome.status).toBe('sent');
    expect(capturedUrl).toBe('https://api.sgroup.qq.com/v2/users/user_target_openid_456/messages');
  });

  it('sends active C2C messages without a passive msg_id or msg_seq', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fakeHttpClient = async (_url: string, init: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 'platform_msg_c2c_active' }), { status: 200 });
    };
    const sender = new QQReplySender({
      tokenProvider: fakeTokenProvider,
      httpClient: fakeHttpClient,
    });
    const reply: PreparedReply = {
      executionId: 'exec_c2c_active',
      part: 1,
      msgSeq: 1,
      scene: 'c2c',
      targetId: 'user_target_openid_active',
      templateKey: 'dice.hidden.roll',
      text: '1d20 = [20] = 20',
      deadline: new Date(Date.now() + 60000),
      deliveryMode: 'active',
    };

    const outcome = await sender.send(reply);

    expect(outcome.status).toBe('sent');
    expect(capturedBody).toEqual({
      content: '1d20 = [20] = 20',
      msg_type: 0,
    });
  });

  it('classifies 429 as retryable', async () => {
    const fakeHttpClient = async (): Promise<Response> =>
      new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 });

    const sender = new QQReplySender({
      tokenProvider: fakeTokenProvider,
      httpClient: fakeHttpClient,
    });

    const reply: PreparedReply = {
      executionId: 'exec_429_1',
      part: 1,
      msgSeq: 1,
      scene: 'groupAt',
      targetId: 'group_429',
      originMessageId: 'msg_429',
      templateKey: 'reply',
      text: 'hello',
      deadline: new Date(Date.now() + 60000),
    };

    const outcome = await sender.send(reply);
    expect(outcome.status).toBe('retryable');
    expect(outcome.errorCode).toBe('HTTP_429');
  });

  it('bounds a stalled QQ request and reports a retryable timeout', async () => {
    const fakeHttpClient = async (_url: string, init: RequestInit): Promise<Response> => {
      const signal = init.signal;
      if (!signal) {
        throw new Error('missing request timeout signal');
      }
      return await new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };

    const sender = new QQReplySender({
      tokenProvider: fakeTokenProvider,
      httpClient: fakeHttpClient,
      requestTimeoutMs: 5,
    });
    const reply: PreparedReply = {
      executionId: 'exec_timeout_1',
      part: 1,
      msgSeq: 1,
      scene: 'groupAt',
      targetId: 'group_timeout',
      originMessageId: 'msg_timeout',
      templateKey: 'reply',
      text: 'hello',
      deadline: new Date(Date.now() + 60000),
    };

    const outcome = await sender.send(reply);

    expect(outcome.status).toBe('retryable');
    expect(outcome.errorCode).toBe('QQ_REQUEST_TIMEOUT');
  });

  it('classifies 400 as failed', async () => {
    const fakeHttpClient = async (): Promise<Response> =>
      new Response(JSON.stringify({ message: 'bad request' }), { status: 400 });

    const sender = new QQReplySender({
      tokenProvider: fakeTokenProvider,
      httpClient: fakeHttpClient,
    });

    const reply: PreparedReply = {
      executionId: 'exec_400_1',
      part: 1,
      msgSeq: 1,
      scene: 'groupAt',
      targetId: 'group_400',
      originMessageId: 'msg_400',
      templateKey: 'reply',
      text: 'hello',
      deadline: new Date(Date.now() + 60000),
    };

    const outcome = await sender.send(reply);
    expect(outcome.status).toBe('failed');
    expect(outcome.errorCode).toBe('HTTP_400');
  });

  it('returns expired when deadline has passed without sending network request', async () => {
    let httpCalled = false;
    const fakeHttpClient = async (): Promise<Response> => {
      httpCalled = true;
      return new Response('{}', { status: 200 });
    };

    const sender = new QQReplySender({
      tokenProvider: fakeTokenProvider,
      httpClient: fakeHttpClient,
    });

    const reply: PreparedReply = {
      executionId: 'exec_expired_1',
      part: 1,
      msgSeq: 1,
      scene: 'groupAt',
      targetId: 'group_expired',
      originMessageId: 'msg_expired',
      templateKey: 'reply',
      text: 'hello',
      deadline: new Date(Date.now() - 5000),
    };

    const outcome = await sender.send(reply);
    expect(outcome.status).toBe('expired');
    expect(httpCalled).toBe(false);
  });
});
