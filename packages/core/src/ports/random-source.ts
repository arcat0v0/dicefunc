export interface RandomSource {
  integer(minInclusive: number, maxInclusive: number): number;
  bytes(length: number): Uint8Array;
}

export function createWebCryptoRandomSource(): RandomSource {
  return {
    integer(minInclusive: number, maxInclusive: number): number {
      const range = maxInclusive - minInclusive + 1;
      const maxRange = Math.floor(0xffffffff / range) * range;
      
      let result: number;
      do {
        const bytes = new Uint32Array(1);
        crypto.getRandomValues(bytes);
        result = bytes[0];
      } while (result >= maxRange);
      
      return minInclusive + (result % range);
    },
    
    bytes(length: number): Uint8Array {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      return bytes;
    }
  };
}

export function deriveSeed(baseSeed: string, purpose: string, salt?: string): string {
  const data = `${baseSeed}:${purpose}:${salt || ''}`;
  const encoder = new TextEncoder();
  const encoded = encoder.encode(data);
  
  return crypto.subtle.digest('SHA-256', encoded)
    .then(hash => Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join(''));
}
