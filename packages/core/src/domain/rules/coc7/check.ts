import type { RandomSource } from '../../../ports/random-source.js';
import type { CharacterSheet } from '../../character/sheet.js';

export type CocSuccessLevel = 'critical' | 'extreme' | 'hard' | 'regular' | 'failure' | 'fumble';

export interface CocCheckResult {
  readonly success: boolean;
  readonly level: CocSuccessLevel;
  readonly skillName: string;
  readonly targetValue: number;
  readonly rollTotal: number;
  readonly rolls: readonly number[];
  readonly criticalSuccess?: boolean | undefined;
  readonly fumble?: boolean | undefined;
}

export interface HouseRules {
  readonly baseDifficulty?: number | undefined;
  readonly difficultyModifiers?: Record<string, number> | undefined;
  readonly dgModifier?: number | undefined;
  readonly maxRollForSuccess?: number | undefined;
  readonly sanityLossMultiplier?: number | undefined;
}

export interface CocCheckContext {
  readonly character?: CharacterSheet | undefined;
  readonly skillName: string;
  readonly targetValue?: number | undefined;
  readonly modifier?: number | undefined;
  readonly bonusDice?: number | undefined;
  readonly houseRules?: HouseRules | undefined;
}

export async function performCocCheck(
  context: CocCheckContext,
  random: RandomSource,
): Promise<CocCheckResult> {
  let baseTarget: number;
  if (context.targetValue !== undefined) {
    baseTarget = context.targetValue;
  } else if (context.character) {
    const attr = context.character.attributes[context.skillName];
    if (attr === undefined) {
      throw new Error(`Skill ${context.skillName} not found on character`);
    }
    baseTarget = attr;
  } else {
    throw new Error('Neither targetValue nor character was provided for COC check');
  }

  let adjustedTarget = baseTarget + (context.modifier ?? 0);
  if (context.houseRules?.baseDifficulty !== undefined && context.houseRules.baseDifficulty > 1) {
    adjustedTarget = Math.floor(adjustedTarget / context.houseRules.baseDifficulty);
  }
  if (context.houseRules?.dgModifier !== undefined) {
    adjustedTarget += context.houseRules.dgModifier;
  }

  let rollTotal: number;
  const rolls: number[] = [];

  const bonusDice = context.bonusDice ?? 0;
  if (bonusDice !== 0) {
    const extraCount = Math.min(Math.abs(bonusDice), 2);
    const unit = await random.integer(0, 9);
    const outcomes: number[] = [];
    for (let i = 0; i <= extraCount; i++) {
      const tens = await random.integer(0, 9);
      const total = tens === 0 && unit === 0 ? 100 : tens * 10 + unit;
      outcomes.push(total);
      rolls.push(total);
    }
    rollTotal = bonusDice > 0 ? Math.min(...outcomes) : Math.max(...outcomes);
  } else {
    rollTotal = await random.integer(1, 100);
    rolls.push(rollTotal);
  }

  const isFumble = adjustedTarget < 50 ? rollTotal >= 96 : rollTotal === 100;
  let level: CocSuccessLevel;

  if (rollTotal === 1) {
    level = 'critical';
  } else if (isFumble) {
    level = 'fumble';
  } else if (rollTotal <= Math.floor(adjustedTarget / 5)) {
    level = 'extreme';
  } else if (rollTotal <= Math.floor(adjustedTarget / 2)) {
    level = 'hard';
  } else if (rollTotal <= adjustedTarget) {
    level = 'regular';
  } else {
    level = 'failure';
  }

  const success = level !== 'failure' && level !== 'fumble';
  const result: {
    success: boolean;
    level: CocSuccessLevel;
    skillName: string;
    targetValue: number;
    rollTotal: number;
    rolls: readonly number[];
    criticalSuccess?: boolean | undefined;
    fumble?: boolean | undefined;
  } = {
    success,
    level,
    skillName: context.skillName,
    targetValue: adjustedTarget,
    rollTotal,
    rolls: Object.freeze(rolls),
  };

  if (level === 'critical') {
    result.criticalSuccess = true;
  }
  if (level === 'fumble') {
    result.fumble = true;
  }

  return result;
}
