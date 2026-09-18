export interface DiceExpression {
  readonly type: 'expression';
  readonly value: string;
  readonly keepDrop?: KeepDropType;
  readonly keepCount?: number;
  readonly reason?: string;
}

export type KeepDropType = 'kl' | 'kh' | 'dl' | 'dh';

export interface DiceRollResult {
  readonly expression: string;
  readonly diceFaces: number[];
  readonly total: number;
  readonly individualRolls: number[];
  readonly reason?: string;
}

export interface DiceEvaluator {
  evaluate(expression: string, randomSource: RandomSource): DiceRollResult;
}

export interface RandomSource {
  integer(minInclusive: number, maxInclusive: number): number;
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
    }
  };
}

export function rollDice(
  faces: number,
  count: number,
  randomSource: RandomSource
): number[] {
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push(randomSource.integer(1, faces));
  }
  return rolls.sort((a, b) => a - b);
}

export function applyKeepDrop(
  rolls: number[],
  keepDropType: KeepDropType,
  count: number
): number[] {
  switch (keepDropType) {
    case 'kl':
      return rolls.slice(0, count);
    case 'kh':
      return rolls.slice(-count);
    case 'dl':
      return rolls.slice(-count);
    case 'dh':
      return rolls.slice(0, count);
    default:
      return rolls;
  }
}
