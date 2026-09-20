import type { CocSuccessLevel } from './check.js';

export type CocDifficulty = 'regular' | 'hard' | 'extreme' | 'critical';

export interface ParsedCocCheck {
  readonly repeat: number;
  readonly bonusDice: number;
  readonly difficulty: CocDifficulty;
  readonly requiredLevel: number;
  readonly skillName: string;
  readonly explicitTarget?: number | undefined;
  readonly modifier: number;
  readonly reason: string;
}

export type CocCheckParseResult =
  | { readonly success: true; readonly value: ParsedCocCheck }
  | { readonly success: false; readonly error: string };

const DIFFICULTY_PREFIXES: readonly {
  readonly text: string;
  readonly difficulty: CocDifficulty;
  readonly requiredLevel: number;
}[] = [
  { text: '大成功', difficulty: 'critical', requiredLevel: 4 },
  { text: '困难', difficulty: 'hard', requiredLevel: 2 },
  { text: '困難', difficulty: 'hard', requiredLevel: 2 },
  { text: '极难', difficulty: 'extreme', requiredLevel: 3 },
  { text: '極難', difficulty: 'extreme', requiredLevel: 3 },
  { text: '常规', difficulty: 'regular', requiredLevel: 1 },
  { text: '常規', difficulty: 'regular', requiredLevel: 1 },
];

export function parseCocCheckArgs(args: readonly string[]): CocCheckParseResult {
  const tokens = args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
  if (tokens.length === 0) {
    return { success: false, error: 'missing check expression' };
  }

  let repeat = 1;
  let bonusDice = 0;
  let difficulty: CocDifficulty = 'regular';
  let requiredLevel = 1;

  const repeatMatch = tokens[0]?.match(/^(\d+)[#＃](.*)$/u);
  if (repeatMatch) {
    repeat = Number.parseInt(repeatMatch[1] ?? '1', 10);
    if (repeat < 1 || repeat > 10) {
      return { success: false, error: 'repeat count must be between 1 and 10' };
    }
    const rest = repeatMatch[2]?.trim() ?? '';
    if (rest) {
      tokens[0] = rest;
    } else {
      tokens.shift();
    }
  }

  const readBonusDice = (): void => {
    const match = tokens[0]?.match(/^([bBpP])(\d*)(.*)$/u);
    if (!match) {
      return;
    }
    const count = match[2] ? Number.parseInt(match[2], 10) : 1;
    bonusDice = match[1]?.toLowerCase() === 'b' ? count : -count;
    const rest = match[3]?.trim() ?? '';
    if (rest) {
      tokens[0] = rest;
    } else {
      tokens.shift();
    }
  };

  readBonusDice();
  for (const prefix of DIFFICULTY_PREFIXES) {
    const first = tokens[0];
    if (!first?.startsWith(prefix.text)) {
      continue;
    }
    difficulty = prefix.difficulty;
    requiredLevel = prefix.requiredLevel;
    const rest = first.slice(prefix.text.length).trim();
    if (rest) {
      tokens[0] = rest;
    } else {
      tokens.shift();
    }
    break;
  }
  if (bonusDice === 0) {
    readBonusDice();
  }

  const subject = tokens.shift();
  if (!subject) {
    return { success: false, error: 'missing skill or target' };
  }

  let skillName = '检定';
  let explicitTarget: number | undefined;
  let modifier = 0;

  if (/^\d+$/u.test(subject)) {
    explicitTarget = Number.parseInt(subject, 10);
  } else {
    const modifierMatch = subject.match(/^(.+?)([+-])(\d+)$/u);
    const targetMatch = subject.match(/^([^\d]+?)(\d+)$/u);
    if (modifierMatch?.[1] && modifierMatch[2] && modifierMatch[3]) {
      skillName = modifierMatch[1].trim();
      const amount = Number.parseInt(modifierMatch[3], 10);
      modifier = modifierMatch[2] === '-' ? -amount : amount;
    } else if (targetMatch?.[1] && targetMatch[2]) {
      skillName = targetMatch[1].trim();
      explicitTarget = Number.parseInt(targetMatch[2], 10);
    } else {
      skillName = subject;
    }
  }

  if (explicitTarget === undefined && tokens[0] && /^\d+$/u.test(tokens[0])) {
    explicitTarget = Number.parseInt(tokens.shift() ?? '', 10);
  }
  if (
    !skillName ||
    (explicitTarget !== undefined && (explicitTarget < 0 || explicitTarget > 999))
  ) {
    return { success: false, error: 'invalid skill or target' };
  }

  return {
    success: true,
    value: {
      repeat,
      bonusDice,
      difficulty,
      requiredLevel,
      skillName,
      ...(explicitTarget !== undefined ? { explicitTarget } : {}),
      modifier,
      reason: tokens.join(' ').trim(),
    },
  };
}

export function cocSuccessRank(level: CocSuccessLevel): number {
  switch (level) {
    case 'critical':
      return 4;
    case 'extreme':
      return 3;
    case 'hard':
      return 2;
    case 'regular':
      return 1;
    case 'failure':
      return -1;
    case 'fumble':
      return -2;
  }
}
