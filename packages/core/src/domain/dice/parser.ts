import type { KeepDropType } from './expression.js';

export class ExpressionBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionBudgetError';
  }
}

export interface ParsedDiceExpression {
  readonly type: 'dice';
  readonly faces: number;
  readonly count: number;
  readonly keepDrop?: KeepDropType | undefined;
  readonly keepCount?: number | undefined;
  readonly modifier?: number | undefined;
  readonly repeat: number;
  readonly reason?: string | undefined;
}

export interface ParseResult {
  readonly success: boolean;
  readonly expression?: ParsedDiceExpression | undefined;
  readonly error?: string | undefined;
}

const DICE_REGEX =
  /^(\d+)?d(\d+)?(?:(kh|kl|dh|dl)(\d+))?(?:\s*([+-])\s*(\d+))?(?:\s*(?:x|\*)\s*(\d+))?(?:\s+(.+))?$/i;

export function parseDiceExpression(expression: string, defaultSides = 100): ParseResult {
  const byteLength = new TextEncoder().encode(expression).length;
  if (byteLength > 2048) {
    throw new ExpressionBudgetError('Expression input exceeds 2KiB limit');
  }

  const trimmed = expression.trim();
  if (!trimmed) {
    return {
      success: false,
      error: 'Empty dice expression',
    };
  }

  const match = trimmed.match(DICE_REGEX);
  if (!match) {
    return {
      success: false,
      error: `Invalid dice expression: ${expression}`,
    };
  }

  const countStr = match[1];
  const facesStr = match[2];
  const keepDropOp = match[3];
  const keepCountStr = match[4];
  const sign = match[5];
  const modValueStr = match[6];
  const repeatStr = match[7];
  const reasonRaw = match[8];

  const count = countStr !== undefined ? Number.parseInt(countStr, 10) : 1;
  const faces = facesStr !== undefined ? Number.parseInt(facesStr, 10) : defaultSides;
  const repeat = repeatStr !== undefined ? Number.parseInt(repeatStr, 10) : 1;

  if (Number.isNaN(count) || count <= 0) {
    return {
      success: false,
      error: `Invalid count: ${countStr ?? ''}`,
    };
  }

  if (Number.isNaN(faces) || faces <= 0) {
    return {
      success: false,
      error: `Invalid faces: ${facesStr ?? ''}`,
    };
  }

  if (Number.isNaN(repeat) || repeat <= 0) {
    return {
      success: false,
      error: `Invalid repeat count: ${repeatStr ?? ''}`,
    };
  }

  if (count > 100) {
    throw new ExpressionBudgetError(`Dice count ${count} exceeds maximum of 100`);
  }

  if (repeat > 10) {
    throw new ExpressionBudgetError(`Repeat count ${repeat} exceeds maximum of 10`);
  }

  const totalDice = count * repeat;
  if (totalDice > 1000) {
    throw new ExpressionBudgetError(`Total dice ${totalDice} exceeds maximum of 1000 per command`);
  }

  let keepDrop: KeepDropType | undefined;
  let keepCount: number | undefined;

  if (keepDropOp) {
    keepDrop = keepDropOp.toLowerCase() as KeepDropType;
    if (keepCountStr !== undefined) {
      keepCount = Number.parseInt(keepCountStr, 10);
      if (Number.isNaN(keepCount) || keepCount <= 0) {
        return {
          success: false,
          error: `Invalid keep/drop count: ${keepCountStr}`,
        };
      }
    } else {
      keepCount = 1;
    }
  }

  let modifier: number | undefined;
  if (sign && modValueStr !== undefined) {
    const val = Number.parseInt(modValueStr, 10);
    if (Number.isNaN(val)) {
      return {
        success: false,
        error: `Invalid modifier: ${modValueStr}`,
      };
    }
    modifier = sign === '-' ? -val : val;
  }

  const reason = reasonRaw?.trim() ? reasonRaw.trim() : undefined;

  const parsed: {
    type: 'dice';
    faces: number;
    count: number;
    repeat: number;
    keepDrop?: KeepDropType | undefined;
    keepCount?: number | undefined;
    modifier?: number | undefined;
    reason?: string | undefined;
  } = {
    type: 'dice',
    faces,
    count,
    repeat,
  };

  if (keepDrop !== undefined) parsed.keepDrop = keepDrop;
  if (keepCount !== undefined) parsed.keepCount = keepCount;
  if (modifier !== undefined) parsed.modifier = modifier;
  if (reason !== undefined) parsed.reason = reason;

  return {
    success: true,
    expression: parsed,
  };
}

export class DiceParser {
  parse(expression: string, defaultSides = 100): ParseResult {
    return parseDiceExpression(expression, defaultSides);
  }
}
