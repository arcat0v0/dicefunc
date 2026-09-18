export interface RandomSource {
  integer(minInclusive: number, maxInclusive: number): Promise<number>;
  bytes(length: number): Promise<Uint8Array>;
}

export function createWebCryptoRandomSource(): RandomSource {
  return {
    integer(minInclusive: number, maxInclusive: number): Promise<number> {
      const range = maxInclusive - minInclusive + 1;
      if (range <= 0) {
        throw new RangeError(`Invalid range: ${minInclusive} to ${maxInclusive}`);
      }
      if (range === 1) {
        return Promise.resolve(minInclusive);
      }
      const maxRange = Math.floor(0x100000000 / range) * range;
      const buf = new Uint32Array(1);
      let val: number;
      do {
        crypto.getRandomValues(buf);
        val = buf[0] ?? 0;
      } while (val >= maxRange);
      return Promise.resolve(minInclusive + (val % range));
    },

    bytes(length: number): Promise<Uint8Array> {
      const buf = new Uint8Array(length);
      crypto.getRandomValues(buf);
      return Promise.resolve(buf);
    },
  };
}

export async function deriveSeed(
  baseSeed: string,
  purpose: string,
  salt?: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const saltStr = salt ?? '';
  const payload = `${baseSeed.length}:${baseSeed}:${purpose.length}:${purpose}:${saltStr.length}:${saltStr}`;
  const data = encoder.encode(payload);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  let binary = '';
  for (let i = 0; i < hashArray.length; i++) {
    binary += String.fromCharCode(hashArray[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createSeededRandomSource(
  seed: string,
  purpose: string,
): Promise<RandomSource> {
  const prefix = new TextEncoder().encode(`${seed.length}:${seed}:${purpose.length}:${purpose}:`);
  let counter = 0;
  let pool: Uint8Array = new Uint8Array(0);
  let poolOffset = 0;

  async function nextBlock(): Promise<Uint8Array> {
    const counterBytes = new TextEncoder().encode((counter++).toString(10));
    const input = new Uint8Array(prefix.length + counterBytes.length);
    input.set(prefix, 0);
    input.set(counterBytes, prefix.length);
    const hash = await crypto.subtle.digest('SHA-256', input);
    return new Uint8Array(hash as ArrayBuffer);
  }

  async function getBytes(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      if (poolOffset >= pool.length) {
        pool = await nextBlock();
        poolOffset = 0;
      }
      const available = pool.length - poolOffset;
      const needed = length - filled;
      const take = Math.min(available, needed);
      result.set(pool.subarray(poolOffset, poolOffset + take), filled);
      poolOffset += take;
      filled += take;
    }
    return result;
  }

  return {
    async integer(minInclusive: number, maxInclusive: number): Promise<number> {
      const range = maxInclusive - minInclusive + 1;
      if (range <= 0) {
        throw new RangeError(`Invalid range: ${minInclusive} to ${maxInclusive}`);
      }
      if (range === 1) {
        return minInclusive;
      }
      const maxRange = Math.floor(0x100000000 / range) * range;
      let val: number;
      do {
        const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = await getBytes(4);
        val = ((b0 << 24) >>> 0) + (b1 << 16) + (b2 << 8) + b3;
      } while (val >= maxRange);
      return minInclusive + (val % range);
    },

    async bytes(length: number): Promise<Uint8Array> {
      return getBytes(length);
    },
  };
}
