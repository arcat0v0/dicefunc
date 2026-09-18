import { createSeededRandomSource, createWebCryptoRandomSource, deriveSeed } from '@dicefunc/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('RandomSource boundary and rejection sampling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles range of 1 without calling crypto.getRandomValues', async () => {
    const rng = createWebCryptoRandomSource();
    const spy = vi.spyOn(crypto, 'getRandomValues');
    const result = await rng.integer(7, 7);
    expect(result).toBe(7);
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws RangeError when minInclusive exceeds maxInclusive', () => {
    const rng = createWebCryptoRandomSource();
    expect(() => rng.integer(10, 5)).toThrow(RangeError);
  });

  it('rejects biased values above maxRange and samples until valid', async () => {
    const rng = createWebCryptoRandomSource();
    let callCount = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array: ArrayBufferView) => {
      const u32 = array as Uint32Array;
      callCount++;
      if (callCount === 1) {
        u32[0] = 0xffffffff;
      } else {
        u32[0] = 2;
      }
      return array;
    });

    const val = await rng.integer(1, 3);
    expect(callCount).toBe(2);
    expect(val).toBe(3);
  });

  it('generates random bytes of requested length', async () => {
    const rng = createWebCryptoRandomSource();
    const bytes = await rng.bytes(16);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(16);
  });
});

describe('createSeededRandomSource deterministic sequences', () => {
  it('produces identical sequences for identical seed and purpose', async () => {
    const r1 = await createSeededRandomSource('common-seed', 'test-purpose');
    const r2 = await createSeededRandomSource('common-seed', 'test-purpose');

    const seq1 = [await r1.integer(1, 100), await r1.integer(1, 100), await r1.integer(1, 100)];

    const seq2 = [await r2.integer(1, 100), await r2.integer(1, 100), await r2.integer(1, 100)];

    expect(seq1).toEqual(seq2);

    const bytes1 = await r1.bytes(8);
    const bytes2 = await r2.bytes(8);
    expect(bytes1).toEqual(bytes2);
  });

  it('produces different sequences for different seeds or purposes', async () => {
    const base = await createSeededRandomSource('seed-a', 'purpose-a');
    const diffSeed = await createSeededRandomSource('seed-b', 'purpose-a');
    const diffPurpose = await createSeededRandomSource('seed-a', 'purpose-b');

    const baseSeq = [
      await base.integer(1, 100000),
      await base.integer(1, 100000),
      await base.integer(1, 100000),
    ];

    const diffSeedSeq = [
      await diffSeed.integer(1, 100000),
      await diffSeed.integer(1, 100000),
      await diffSeed.integer(1, 100000),
    ];

    const diffPurposeSeq = [
      await diffPurpose.integer(1, 100000),
      await diffPurpose.integer(1, 100000),
      await diffPurpose.integer(1, 100000),
    ];

    expect(baseSeq).not.toEqual(diffSeedSeq);
    expect(baseSeq).not.toEqual(diffPurposeSeq);
  });
});

describe('deriveSeed', () => {
  it('returns a string identifier', async () => {
    const seed = await deriveSeed('initial-seed', 'test');
    expect(typeof seed).toBe('string');
    expect(seed.length).toBeGreaterThan(0);
  });

  it('produces distinct seeds for distinct purposes', async () => {
    const s1 = await deriveSeed('initial-seed', 'purpose-one');
    const s2 = await deriveSeed('initial-seed', 'purpose-two');
    expect(s1).not.toBe(s2);
  });
});
