import type { RandomSource } from '../../../ports/random-source.js';
import { resultCheckBase } from './house-rules.js';

export interface CocSanityCheckResult {
  readonly rollTotal: number;
  readonly targetValue: number;
  readonly successRank: number;
  readonly success: boolean;
  readonly sanOld: number;
  readonly sanNew: number;
  readonly sanLoss: number;
  readonly temporaryMadness: boolean;
  readonly permanentMadness: boolean;
}

export interface CocSanityCheckInput {
  readonly sanValue: number;
  readonly successLoss?: number | undefined;
  readonly failLoss?: number | undefined;
}

export async function performSanityCheck(
  input: CocSanityCheckInput,
  random: RandomSource,
  ruleId = '0',
): Promise<CocSanityCheckResult> {
  const rollTotal = await random.integer(1, 100);
  const { successRank } = resultCheckBase(ruleId, rollTotal, input.sanValue);
  const success = successRank > 0;

  const lossExprValue = success ? (input.successLoss ?? 0) : (input.failLoss ?? 0);
  const sanLoss = Math.max(0, lossExprValue);
  const sanNew = Math.max(0, input.sanValue - sanLoss);

  return {
    rollTotal,
    targetValue: input.sanValue,
    successRank,
    success,
    sanOld: input.sanValue,
    sanNew,
    sanLoss,
    temporaryMadness: sanLoss >= 5 && sanNew > 0,
    permanentMadness: sanNew === 0,
  };
}
