import type { Clock } from '@dicefunc/core';
import { systemClock } from '@dicefunc/core';

export interface QQTokenProviderOptions {
  readonly appId: string;
  readonly clientSecret: string;
  readonly tokenUrl?: string;
  readonly httpClient?: (url: string, init: RequestInit) => Promise<Response>;
  readonly clock?: Clock;
}

export class QQTokenProvider {
  private readonly appId: string;
  private readonly clientSecret: string;
  private readonly tokenUrl: string;
  private readonly httpClient: (url: string, init: RequestInit) => Promise<Response>;
  private readonly clock: Clock;
  private cachedToken: string | null = null;
  private expiresAtMs = 0;

  constructor(options: QQTokenProviderOptions) {
    this.appId = options.appId;
    this.clientSecret = options.clientSecret;
    this.tokenUrl = options.tokenUrl ?? 'https://bots.qq.com/app/getAppAccessToken';
    this.httpClient = options.httpClient ?? globalThis.fetch.bind(globalThis);
    this.clock = options.clock ?? systemClock;
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const now = this.clock.now().getTime();
    if (!forceRefresh && this.cachedToken !== null && now < this.expiresAtMs) {
      return this.cachedToken;
    }

    const response = await this.httpClient(this.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch QQ access token: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number | string;
    };

    if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
      throw new Error('QQ token response missing access_token');
    }

    const expiresInSec =
      typeof data.expires_in === 'number'
        ? data.expires_in
        : typeof data.expires_in === 'string'
          ? Number.parseInt(data.expires_in, 10)
          : 7200;

    const safeDurationSec = Math.max(0, expiresInSec - 300);
    this.cachedToken = data.access_token;
    this.expiresAtMs = this.clock.now().getTime() + safeDurationSec * 1000;

    return this.cachedToken;
  }

  invalidate(): void {
    this.cachedToken = null;
    this.expiresAtMs = 0;
  }
}
