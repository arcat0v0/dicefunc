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

  const sumStrSiz = str + siz;
  let db = '0';
  let bld = 0;
  if (sumStrSiz < 65) {
    db = '-2';
    bld = -2;
  } else if (sumStrSiz < 85) {
    db = '-1';
    bld = -1;
  } else if (sumStrSiz < 125) {
    db = '0';
    bld = 0;
  } else if (sumStrSiz < 165) {
    db = '+1d4';
    bld = 1;
  } else if (sumStrSiz < 205) {
    db = '+1d6';
    bld = 2;
  } else {
    db = '+2d6';
    bld = 3;
  }

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

export function formatCoc7CardBody(card: Coc7CardAttributes): string {
  return (
    `力量:${card.str} 敏捷:${card.dex} 意志:${card.pow}\n` +
    `体质:${card.con} 外貌:${card.app} 教育:${card.edu}\n` +
    `体型:${card.siz} 智力:${card.int} 幸运:${card.luk}\n` +
    `HP:${card.hp} <DB:${card.db}> [${card.baseTotal}/${card.totalWithLuck}]`
  );
}

export function formatCoc7CardSingle(actorName: string, card: Coc7CardAttributes): string {
  return `<${actorName}>的七版COC人物作成:\n${formatCoc7CardBody(card)}`;
}

export function formatCoc7CardBatch(
  actorName: string,
  cards: readonly Coc7CardAttributes[],
): string {
  const cardTexts = cards.map((c) => formatCoc7CardBody(c));
  return `<${actorName}>的七版COC人物作成:\n${cardTexts.join('\n\n')}`;
}
