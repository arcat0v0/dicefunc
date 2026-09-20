import { resultCheckBase } from './house-rules.js';

export interface SkillGrowthCheckResult {
  readonly skillName: string;
  readonly oldValue: number;
  readonly rollTotal: number;
  readonly success: boolean;
  readonly successRank: number;
  readonly increment: number;
  readonly newValue: number;
}

export function decideSkillGrowth(input: {
  readonly skillName: string;
  readonly oldValue: number;
  readonly rollTotal: number;
  readonly ruleId?: string | undefined;
  readonly increment: number;
}): SkillGrowthCheckResult {
  const ruleId = input.ruleId ?? '0';
  const rollTotal = input.rollTotal;

  const growth = rollTotal > 95 || rollTotal > input.oldValue;
  const { successRank } = resultCheckBase(ruleId, rollTotal, input.oldValue);

  const success = growth;
  const displayRank = success ? -1 : successRank;
  const increment = success ? Math.max(0, input.increment) : 0;

  return {
    skillName: input.skillName,
    oldValue: input.oldValue,
    rollTotal,
    success,
    successRank: displayRank,
    increment,
    newValue: input.oldValue + increment,
  };
}
