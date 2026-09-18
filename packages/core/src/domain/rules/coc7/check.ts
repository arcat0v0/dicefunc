import { CharacterSheet } from '../../character/sheet';

export interface CocCheckResult {
  readonly success: boolean;
  readonly skillName: string;
  readonly targetValue: number;
  readonly rollTotal: number;
  readonly criticalSuccess?: boolean;
  readonly failureReason?: FailureReason;
}

export type FailureReason = 
  | 'exceeded'
  | 'sanity_loss'
  | 'sanity_frenzy';

export interface CocCheckContext {
  readonly character: CharacterSheet;
  readonly skillName: string;
  readonly modifier: number;
  readonly houseRules: HouseRules;
  readonly isDodge: boolean;
}

export interface HouseRules {
  readonly baseDifficulty: number;
  readonly difficultyModifiers: Record<string, number>;
  readonly dgModifier: number;
  readonly maxRollForSuccess: number;
  readonly sanityLossMultiplier: number;
}

export function performCocCheck(
  context: CocCheckContext
): CocCheckResult {
  const skillValue = getSkillValue(context.character, context.skillName);
  const adjustedTarget = calculateAdjustedTarget(skillValue, context.modifier, context.houseRules);
  
  return {
    success: false,
    skillName: context.skillName,
    targetValue: adjustedTarget,
    rollTotal: 0,
  };
}

function getSkillValue(character: CharacterSheet, skillName: string): number {
  const attr = character.attributes[skillName];
  if (attr?.type === 'number') {
    return attr.value;
  }
  throw new Error(`Skill ${skillName} not found or not a number`);
}

function calculateAdjustedTarget(
  baseValue: number,
  modifier: number,
  houseRules: HouseRules
): number {
  let target = baseValue + modifier;
  
  if (houseRules.baseDifficulty !== 1) {
    target = Math.floor(target / houseRules.baseDifficulty);
  }
  
  target += houseRules.dgModifier;
  return target;
}
