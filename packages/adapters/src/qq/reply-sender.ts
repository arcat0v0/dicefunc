import type {
  Clock,
  DeliveryOutcome,
  PreparedReply,
  ReplySender,
  RuntimeLogger,
} from '@dicefunc/core';
import { buildLogEntry, systemClock } from '@dicefunc/core';
import type { QQTokenProvider } from './token-provider.js';

export interface QQReplySenderOptions {
  readonly tokenProvider: QQTokenProvider;
  readonly baseUrl?: string;
  readonly httpClient?: (url: string, init: RequestInit) => Promise<Response>;
  readonly clock?: Clock;
  readonly logger?: RuntimeLogger;
  readonly environment?: string;
}

export class QQReplySender implements ReplySender {
  private readonly tokenProvider: QQTokenProvider;
  private readonly baseUrl: string;
  private readonly httpClient: (url: string, init: RequestInit) => Promise<Response>;
  private readonly clock: Clock;
  private readonly logger: RuntimeLogger | undefined;
  private readonly environment: string;

  constructor(options: QQReplySenderOptions) {
    this.tokenProvider = options.tokenProvider;
    this.baseUrl = (options.baseUrl ?? 'https://api.sgroup.qq.com').replace(/\/+$/, '');
    this.httpClient = options.httpClient ?? globalThis.fetch.bind(globalThis);
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger;
    this.environment = options.environment ?? 'production';
  }

  async send(reply: PreparedReply): Promise<DeliveryOutcome> {
    if (this.clock.now().getTime() > reply.deadline.getTime()) {
      return { status: 'expired' };
    }

    const url =
      reply.scene === 'c2c'
        ? `${this.baseUrl}/v2/users/${encodeURIComponent(reply.targetId)}/messages`
        : `${this.baseUrl}/v2/groups/${encodeURIComponent(reply.targetId)}/messages`;

    const payload = {
      content: reply.text,
      msg_type: 0,
      msg_id: reply.originMessageId,
      msg_seq: reply.msgSeq,
    };

    return await this.sendAttempt(url, payload, reply, false);
  }

  private async sendAttempt(
    url: string,
    payload: { content: string; msg_type: number; msg_id: string; msg_seq: number },
    reply: PreparedReply,
    hasRetriedAuth: boolean,
  ): Promise<DeliveryOutcome> {
    let token: string;
    try {
      token = await this.tokenProvider.getAccessToken(hasRetriedAuth);
    } catch {
      if (this.clock.now().getTime() > reply.deadline.getTime()) {
        return { status: 'expired' };
      }
      return { status: 'retryable', errorCode: 'TOKEN_FETCH_ERROR' };
    }

    let response: Response;
    try {
      response = await this.httpClient(url, {
        method: 'POST',
        headers: {
          Authorization: `QQBot ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch {
      if (this.clock.now().getTime() > reply.deadline.getTime()) {
        return { status: 'expired' };
      }
      return { status: 'retryable', errorCode: 'NETWORK_ERROR' };
    }

    if (response.status === 200 || response.status === 201) {
      const data = (await response.json().catch(() => ({}))) as { id?: string };
      const platformMessageId = typeof data.id === 'string' ? data.id : '';
      if (this.logger) {
        this.logger.log(
          buildLogEntry({
            level: 'info',
            event: 'qq.reply.sent',
            component: 'reply-sender',
            environment: this.environment,
            executionId: reply.executionId,
            outcome: 'sent',
            httpStatus: response.status,
          }),
        );
      }
      return {
        status: 'sent',
        platformMessageId,
      };
    }

    if (response.status === 401 && !hasRetriedAuth) {
      this.tokenProvider.invalidate();
      if (this.clock.now().getTime() > reply.deadline.getTime()) {
        return { status: 'expired' };
      }
      return await this.sendAttempt(url, payload, reply, true);
    }

    if (response.status === 400 || response.status === 403 || response.status === 404) {
      const errorCode = `HTTP_${response.status}`;
      if (this.logger) {
        this.logger.log(
          buildLogEntry({
            level: 'error',
            event: 'qq.reply.failed',
            component: 'reply-sender',
            environment: this.environment,
            executionId: reply.executionId,
            outcome: 'failed',
            errorCode,
            httpStatus: response.status,
          }),
        );
      }
      return {
        status: 'failed',
        errorCode,
      };
    }

    if (response.status === 429 || response.status >= 500) {
      if (this.clock.now().getTime() > reply.deadline.getTime()) {
        return { status: 'expired' };
      }
      const errorCode = `HTTP_${response.status}`;
      if (this.logger) {
        this.logger.log(
          buildLogEntry({
            level: 'warn',
            event: 'qq.reply.retry',
            component: 'reply-sender',
            environment: this.environment,
            executionId: reply.executionId,
            outcome: 'retryable',
            errorCode,
            httpStatus: response.status,
          }),
        );
      }
      return {
        status: 'retryable',
        errorCode,
      };
    }

    return {
      status: 'failed',
      errorCode: `HTTP_${response.status}`,
    };
  }
}
