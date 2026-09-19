import type { RandomSource } from '../../../ports/random-source.js';

export interface Dnd5eCardAttributes {
  readonly str: number;
  readonly dex: number;
  readonly con: number;
  readonly int: number;
  readonly wis: number;
  readonly cha: number;
  readonly total: number;
}

async function roll4d6DropLowest(random: RandomSource): Promise<number> {
  const rolls: number[] = [];
  for (let i = 0; i < 4; i++) {
    rolls.push(await random.integer(1, 6));
  }
  rolls.sort((a, b) => a - b);
  return (rolls[1] ?? 0) + (rolls[2] ?? 0) + (rolls[3] ?? 0);
}

export async function generateDnd5eCard(random: RandomSource): Promise<Dnd5eCardAttributes> {
  const str = await roll4d6DropLowest(random);
  const dex = await roll4d6DropLowest(random);
  const con = await roll4d6DropLowest(random);
  const int = await roll4d6DropLowest(random);
  const wis = await roll4d6DropLowest(random);
  const cha = await roll4d6DropLowest(random);
  const total = str + dex + con + int + wis + cha;

  return {
    str,
    dex,
    con,
    int,
    wis,
    cha,
    total,
  };
}

export interface Dnd5eFreeAllocationCard {
  readonly numbers: readonly number[];
  readonly total: number;
}

export async function generateDnd5eFreeCard(
  random: RandomSource,
): Promise<Dnd5eFreeAllocationCard> {
  const numbers: number[] = [];
  let total = 0;
  for (let i = 0; i < 6; i++) {
    const n = await roll4d6DropLowest(random);
    numbers.push(n);
    total += n;
  }
  numbers.sort((a, b) => b - a);
  return { numbers, total };
}

export function formatDnd5eFreeCard(
  actorName: string,
  cards: readonly Dnd5eFreeAllocationCard[],
): string {
  const lines = cards.map((c) => `[${c.numbers.join(', ')}] = ${c.total}`);
  return `<${actorName}>使用自由分配的DND5E人物作成:\n${lines.join('\n')}`;
}

export function formatDnd5ePresetCard(
  actorName: string,
  cards: readonly Dnd5eCardAttributes[],
): string {
  const lines = cards.map(
    (c) =>
      `力量:${c.str} 体质:${c.con} 敏捷:${c.dex} 智力:${c.int} 感知:${c.wis} 魅力:${c.cha} 共计:${c.total}`,
  );
  return `<${actorName}>使用预设模板的DND5E人物作成:\n${lines.join('\n')}`;
}
