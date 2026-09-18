import { describe, it, expect } from 'vitest';
import { createWebCryptoRandomSource } from '../../../packages/core/src/ports/random-source';

describe('WebCrypto Random Source', () => {
  const randomSource = createWebCryptoRandomSource();
  
  it('should generate integers within range', () => {
    const min = 1;
    const max = 100;
    
    for (let i = 0; i < 100; i++) {
      const result = randomSource.integer(min, max);
      expect(result).toBeGreaterThanOrEqual(min);
      expect(result).toBeLessThanOrEqual(max);
      expect(Number.isInteger(result)).toBe(true);
    }
  });
  
  it('should not have bias in distribution', async () => {
    const counts = new Map<number, number>();
    const min = 1;
    const max = 10;
    const iterations = 10000;
    
    for (let i = 0; i < iterations; i++) {
      const result = randomSource.integer(min, max);
      counts.set(result, (counts.get(result) || 0) + 1);
    }
    
    // Check that all values appear with reasonable frequency
    for (const [value, count] of counts.entries()) {
      expect(count).toBeGreaterThan(iterations / (max - min + 1) * 0.5);
      expect(count).toBeLessThan(iterations / (max - min + 1) * 1.5);
    }
  });
  
  it('should generate bytes', () => {
    const bytes = randomSource.bytes(32);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
  });
});
