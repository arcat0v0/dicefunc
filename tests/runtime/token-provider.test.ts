import { QQTokenProvider, type TokenStorage } from '@dicefunc/adapters';
import { describe, expect, it } from 'vitest';

describe('QQTokenProvider with storage caching', () => {
  it('fetches from network and populates storage on cache miss', async () => {
    const memory = new Map<string, string>();
    const storage: TokenStorage = {
      get: async (k: string) => memory.get(k) ?? null,
      put: async (k: string, v: string) => {
        memory.set(k, v);
      },
      delete: async (k: string) => {
        memory.delete(k);
      },
    };
    let fetchCount = 0;
    const fakeHttp = async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          access_token: 'tok_network_123',
          expires_in: 7200,
        }),
        { status: 200 },
      );
    };

    const provider = new QQTokenProvider({
      appId: 'test_app_1',
      clientSecret: 'secret_1',
      httpClient: fakeHttp,
      storage,
    });

    const token = await provider.getAccessToken();
    expect(token).toBe('tok_network_123');
    expect(fetchCount).toBe(1);

    expect(memory.has('qq:token:test_app_1')).toBe(true);

    const provider2 = new QQTokenProvider({
      appId: 'test_app_1',
      clientSecret: 'secret_1',
      httpClient: fakeHttp,
      storage,
    });

    const token2 = await provider2.getAccessToken();
    expect(token2).toBe('tok_network_123');
    expect(fetchCount).toBe(1);
  });

  it('invalidates both in-memory and persistent storage cache', async () => {
    const memory = new Map<string, string>();
    const storage: TokenStorage = {
      get: async (k: string) => memory.get(k) ?? null,
      put: async (k: string, v: string) => {
        memory.set(k, v);
      },
      delete: async (k: string) => {
        memory.delete(k);
      },
    };
    let count = 0;
    const fakeHttp = async () => {
      count++;
      return new Response(
        JSON.stringify({
          access_token: `tok_${count}`,
          expires_in: 7200,
        }),
        { status: 200 },
      );
    };

    const provider = new QQTokenProvider({
      appId: 'test_app_2',
      clientSecret: 'secret_2',
      httpClient: fakeHttp,
      storage,
    });

    await provider.getAccessToken();
    expect(memory.has('qq:token:test_app_2')).toBe(true);

    provider.invalidate();
    expect(memory.has('qq:token:test_app_2')).toBe(false);

    const tokenAfter = await provider.getAccessToken();
    expect(tokenAfter).toBe('tok_2');
    expect(count).toBe(2);
  });
});
