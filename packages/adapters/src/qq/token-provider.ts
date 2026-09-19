import type { Clock } from '@dicefunc/core';
import { systemClock } from '@dicefunc/core';

export interface TokenStorage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}

export interface QQTokenProviderOptions {
  readonly appId: string;
  readonly clientSecret: string;
  readonly tokenUrl?: string;
  readonly httpClient?: (url: string, init: RequestInit) => Promise<Response>;
  readonly clock?: Clock;
  readonly storage?: TokenStorage;
}

export class QQTokenProvider {
  private readonly appId: string;
  private readonly clientSecret: string;
  private readonly tokenUrl: string;
  private readonly httpClient: (url: string, init: RequestInit) => Promise<Response>;
  private readonly clock: Clock;
  private readonly storage?: TokenStorage | undefined;
  private cachedToken: string | null = null;
  private expiresAtMs = 0;

  constructor(options: QQTokenProviderOptions) {
    this.appId = options.appId;
    this.clientSecret = options.clientSecret;
    this.tokenUrl = options.tokenUrl ?? 'https://bots.qq.com/app/getAppAccessToken';
    this.httpClient = options.httpClient ?? globalThis.fetch.bind(globalThis);
    this.clock = options.clock ?? systemClock;
    this.storage = options.storage;
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const now = this.clock.now().getTime();
    if (!forceRefresh && this.cachedToken !== null && now < this.expiresAtMs) {
      return this.cachedToken;
    }

    const storageKey = `qq:token:${this.appId}`;
    if (!forceRefresh && this.storage) {
      try {
        const stored = await this.storage.get(storageKey);
        if (stored) {
          const parsed = JSON.parse(stored) as { token?: string; expiresAtMs?: number };
          if (
            typeof parsed.token === 'string' &&
            typeof parsed.expiresAtMs === 'number' &&
            now < parsed.expiresAtMs
          ) {
            this.cachedToken = parsed.token;
            this.expiresAtMs = parsed.expiresAtMs;
            return this.cachedToken;
          }
        }
      } catch {
        // Fall through to network fetch on storage read error
      }
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

    if (this.storage) {
      try {
        await this.storage.put(
          storageKey,
          JSON.stringify({ token: this.cachedToken, expiresAtMs: this.expiresAtMs }),
          { expirationTtl: safeDurationSec },
        );
      } catch {
        // Non-fatal if storage write fails
      }
    }

    return this.cachedToken;
  }

  invalidate(): void {
    this.cachedToken = null;
    this.expiresAtMs = 0;
    if (this.storage?.delete) {
      this.storage.delete(`qq:token:${this.appId}`).catch(() => {});
    }
  }
}
