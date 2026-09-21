import type { RandomSource } from '../../../ports/random-source.js';

export interface Coc7CardAttributes {
  readonly str: number;
  readonly con: number;
  readonly siz: number;
  readonly dex: number;
  readonly app: number;
  readonly int: number;
  readonly pow: number;
  readonly edu: number;
  readonly luk: number;
  readonly hp: number;
  readonly mp: number;
  readonly san: number;
  readonly mov: number;
  readonly bld: number;
  readonly db: string;
  readonly baseTotal: number;
  readonly totalWithLuck: number;
}

export type Coc7DamageBonus =
  | {
      readonly kind: 'constant';
      readonly value: number;
      readonly build: number;
    }
  | {
      readonly kind: 'dice';
      readonly count: number;
      readonly faces: 4 | 6;
      readonly build: number;
    };

export function calculateCoc7DamageBonus(strength: number, size: number): Coc7DamageBonus {
  const total = strength + size;
  if (total < 65) {
    return { kind: 'constant', value: -2, build: -2 };
  }
  if (total < 85) {
    return { kind: 'constant', value: -1, build: -1 };
  }
  if (total < 125) {
    return { kind: 'constant', value: 0, build: 0 };
  }
  if (total < 165) {
    return { kind: 'dice', count: 1, faces: 4, build: 1 };
  }
  if (total < 205) {
    return { kind: 'dice', count: 1, faces: 6, build: 2 };
  }
  const count = Math.floor((total - 205) / 80) + 2;
  return { kind: 'dice', count, faces: 6, build: count + 1 };
}

async function rollSum(random: RandomSource, count: number, sides: number): Promise<number> {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += await random.integer(1, sides);
  }
  return sum;
}

export async function generateCoc7Card(random: RandomSource): Promise<Coc7CardAttributes> {
  const str = (await rollSum(random, 3, 6)) * 5;
  const con = (await rollSum(random, 3, 6)) * 5;
  const pow = (await rollSum(random, 3, 6)) * 5;
  const dex = (await rollSum(random, 3, 6)) * 5;
  const app = (await rollSum(random, 3, 6)) * 5;
  const luk = (await rollSum(random, 3, 6)) * 5;

  const siz = ((await rollSum(random, 2, 6)) + 6) * 5;
  const int = ((await rollSum(random, 2, 6)) + 6) * 5;
  const edu = ((await rollSum(random, 2, 6)) + 6) * 5;

  const hp = Math.floor((con + siz) / 10);
  const mp = Math.floor(pow / 5);
  const san = pow;

  const damageBonus = calculateCoc7DamageBonus(str, siz);
  const db =
    damageBonus.kind === 'constant'
      ? String(damageBonus.value)
      : `+${damageBonus.count}d${damageBonus.faces}`;
  const bld = damageBonus.build;

  let mov = 8;
  if (dex > siz && str > siz) {
    mov = 10;
  } else if (dex < siz && str < siz) {
    mov = 8;
  } else {
    mov = 9;
  }

  const baseTotal = str + con + siz + dex + app + int + pow + edu;
  const totalWithLuck = baseTotal + luk;

  return {
    str,
    con,
    siz,
    dex,
    app,
    int,
    pow,
    edu,
    luk,
    hp,
    mp,
    san,
    mov,
    bld,
    db,
    baseTotal,
    totalWithLuck,
  };
}
