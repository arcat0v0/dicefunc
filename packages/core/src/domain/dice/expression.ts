import type { RandomSource } from '../../ports/random-source.js';

export type KeepDropType = 'kl' | 'kh' | 'dl' | 'dh';

export interface DiceRollResult {
  readonly expression: string;
  readonly faces: number;
  readonly count: number;
  readonly rolls: readonly number[];
  readonly keptRolls: readonly number[];
  readonly total: number;
  readonly reason?: string | undefined;
  readonly keepDrop?: KeepDropType | undefined;
  readonly keepCount?: number | undefined;
  readonly modifier?: number | undefined;
}

export async function rollDice(
  sides: number,
  count: number,
  random: RandomSource,
): Promise<number[]> {
  if (sides <= 0 || count <= 0) {
    return [];
  }
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push(await random.integer(1, sides));
  }
  return rolls;
}

export function applyKeepDrop(
  rolls: readonly number[],
  keepDropType: KeepDropType,
  count: number,
): number[] {
  if (count <= 0) {
    if (keepDropType === 'kl' || keepDropType === 'kh') {
      return [];
    }
    return [...rolls];
  }

  const sorted = [...rolls].sort((a, b) => a - b);
  const total = sorted.length;

  if (count >= total) {
    if (keepDropType === 'kl' || keepDropType === 'kh') {
      return sorted;
    }
    return [];
  }

  switch (keepDropType) {
    case 'kl':
      return sorted.slice(0, count);
    case 'kh':
      return sorted.slice(total - count);
    case 'dl':
      return sorted.slice(count);
    case 'dh':
      return sorted.slice(0, total - count);
  }
}
