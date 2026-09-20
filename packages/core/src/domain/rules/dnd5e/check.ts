export const DND_ABILITY_NAMES = ['力量', '敏捷', '体质', '智力', '感知', '魅力'] as const;

export const DND_SKILL_PARENTS: Readonly<Record<string, (typeof DND_ABILITY_NAMES)[number]>> = {
  运动: '力量',
  体操: '敏捷',
  巧手: '敏捷',
  隐匿: '敏捷',
  调查: '智力',
  奥秘: '智力',
  历史: '智力',
  自然: '智力',
  宗教: '智力',
  察觉: '感知',
  洞悉: '感知',
  驯兽: '感知',
  医药: '感知',
  求生: '感知',
  游说: '魅力',
  欺瞒: '魅力',
  威吓: '魅力',
  表演: '魅力',
};

export interface ParsedDndCheck {
  readonly repeat: number;
  readonly advantage: -1 | 0 | 1;
  readonly name: string;
  readonly extraModifier?: string | undefined;
  readonly dc?: number | undefined;
  readonly reason: string;
}

export type DndCheckParseResult =
  | { readonly success: true; readonly value: ParsedDndCheck }
  | { readonly success: false; readonly error: string };

export function parseDndCheckArgs(args: readonly string[]): DndCheckParseResult {
  const tokens = [...args];
  let repeat = 1;
  const repeatMatch = tokens[0]?.match(/^(\d+)[#＃](.*)$/u);
  if (repeatMatch) {
    repeat = Number.parseInt(repeatMatch[1] ?? '1', 10);
    if (repeat < 1 || repeat > 10) {
      return { success: false, error: '检定次数必须在 1 到 10 之间' };
    }
    const attached = repeatMatch[2]?.trim();
    if (attached) {
      tokens[0] = attached;
    } else {
      tokens.shift();
    }
  }

  let advantage: -1 | 0 | 1 = 0;
  if (/^(优势|優勢)$/u.test(tokens[0] ?? '')) {
    advantage = 1;
    tokens.shift();
  } else if (/^(劣势|劣勢)$/u.test(tokens[0] ?? '')) {
    advantage = -1;
    tokens.shift();
  }

  const expression = tokens.shift() ?? '';
  const expressionMatch = expression.match(/^([\p{L}_]+?)([+-].+)?$/u);
  const name = expressionMatch?.[1]?.trim() ?? '';
  if (!name) {
    return { success: false, error: '缺少属性、技能或豁免名称' };
  }
  const extraModifier = expressionMatch?.[2]?.trim();
  let dc: number | undefined;
  if (/^\d+$/u.test(tokens[0] ?? '')) {
    dc = Number.parseInt(tokens.shift() ?? '', 10);
  }
  return {
    success: true,
    value: {
      repeat,
      advantage,
      name,
      ...(extraModifier ? { extraModifier } : {}),
      ...(dc !== undefined ? { dc } : {}),
      reason: tokens.join(' ').trim(),
    },
  };
}

export interface DndCheckModifier {
  readonly name: string;
  readonly modifier: number;
  readonly ability?: string | undefined;
  readonly abilityModifier?: number | undefined;
  readonly base?: number | undefined;
  readonly proficiencyBonus?: number | undefined;
  readonly proficiencyFactor?: number | undefined;
}

export function dndAbilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function resolveDndCheckModifier(
  attributes: Readonly<Record<string, number>>,
  name: string,
): DndCheckModifier | undefined {
  const proficiencyBonus = attributes.熟练 ?? 0;
  if (name.endsWith('豁免')) {
    const ability = name.slice(0, -2);
    const score = attributes[ability];
    if (score === undefined) {
      return undefined;
    }
    const abilityModifier = dndAbilityModifier(score + (attributes[`Buff_${ability}`] ?? 0));
    const proficiencyFactor =
      (attributes[`${ability}豁免熟练`] ?? 0) + (attributes[`Buff_${ability}豁免熟练`] ?? 0);
    return {
      name,
      modifier: Math.floor(abilityModifier + proficiencyBonus * proficiencyFactor),
      ability,
      abilityModifier,
      proficiencyBonus,
      proficiencyFactor,
    };
  }

  if ((DND_ABILITY_NAMES as readonly string[]).includes(name)) {
    const score = attributes[name];
    if (score === undefined) {
      return undefined;
    }
    const abilityModifier = dndAbilityModifier(score + (attributes[`Buff_${name}`] ?? 0));
    return {
      name,
      modifier: abilityModifier,
      ability: name,
      abilityModifier,
    };
  }

  const ability = DND_SKILL_PARENTS[name];
  if (ability) {
    const score = attributes[ability];
    if (score === undefined) {
      return undefined;
    }
    const abilityModifier = dndAbilityModifier(score + (attributes[`Buff_${ability}`] ?? 0));
    const base = (attributes[name] ?? 0) + (attributes[`Buff_${name}`] ?? 0);
    const proficiencyFactor =
      (attributes[`${name}熟练`] ?? 0) + (attributes[`Buff_${name}熟练`] ?? 0);
    return {
      name,
      modifier: Math.floor(abilityModifier + base + proficiencyBonus * proficiencyFactor),
      ability,
      abilityModifier,
      base,
      proficiencyBonus,
      proficiencyFactor,
    };
  }

  const modifier = attributes[name];
  if (modifier === undefined) {
    return undefined;
  }
  return { name, modifier: modifier + (attributes[`Buff_${name}`] ?? 0) };
}
