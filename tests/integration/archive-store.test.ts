import { env } from 'cloudflare:test';
import { R2ArchiveStore } from '@dicefunc/adapters';
import { describe, expect, it } from 'vitest';

describe('R2ArchiveStore integration', () => {
  it('completes normal roundtrip put, head, and read verification', async () => {
    const store = new R2ArchiveStore(env.STORY_LOG_BUCKET);
    const body = new TextEncoder().encode('Log roundtrip content line 1\nLine 2');
    const digest = 'sha256_valid_digest_123';
    const key = 'logs/roundtrip_test.txt';

    const receipt = await store.put({
      key,
      body,
      format: 'txt',
      digest,
    });

    expect(receipt.key).toBe(key);
    expect(receipt.bytes).toBe(body.byteLength);
    expect(receipt.digest).toBe(digest);
    expect(receipt.format).toBe('txt');

    const exists = await store.head(receipt);
    expect(exists).toBe(true);

    const content = await store.read(receipt);
    expect(content).not.toBeNull();
    expect(content?.digest).toBe(digest);
    expect(content?.format).toBe('txt');

    const retrievedText = await new Response(content?.body).text();
    expect(retrievedText).toBe('Log roundtrip content line 1\nLine 2');
  });

  it('fails verification and throws on put when head size does not match', async () => {
    const corruptedBucket = {
      put: (key: string, value: R2PutValueType, options?: R2PutOptions) =>
        env.STORY_LOG_BUCKET.put(key, value, options),
      head: async (key: string) => {
        const headObj = await env.STORY_LOG_BUCKET.head(key);
        if (!headObj) return null;
        return {
          ...headObj,
          size: headObj.size + 100,
        };
      },
    } as unknown as R2Bucket;
    const store = new R2ArchiveStore(corruptedBucket);
    const body = new TextEncoder().encode('Content for corrupted size test');

    await expect(
      store.put({
        key: 'logs/corrupted_size.txt',
        body,
        format: 'txt',
        digest: 'sha256_corrupt_test',
      }),
    ).rejects.toThrow(/R2 put verification failed/);
  });

  it('returns null when read digest does not match recorded digest', async () => {
    const store = new R2ArchiveStore(env.STORY_LOG_BUCKET);
    const body = new TextEncoder().encode('Content for digest mismatch test');
    const actualDigest = 'actual_digest_val';
    const key = 'logs/digest_mismatch.txt';

    const receipt = await store.put({
      key,
      body,
      format: 'txt',
      digest: actualDigest,
    });

    const tamperedReceipt = {
      ...receipt,
      digest: 'tampered_different_digest',
    };

    const content = await store.read(tamperedReceipt);
    expect(content).toBeNull();
  });
});
