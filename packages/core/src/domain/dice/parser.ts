import { DiceExpression, KeepDropType, RandomSource, rollDice, applyKeepDrop } from './expression';

export interface ParsedDiceExpression {
  readonly type: 'dice';
  readonly faces: number;
  readonly count: number;
  readonly keepDrop?: KeepDropType;
  readonly keepCount?: number;
  readonly reason?: string;
}

export interface ParseResult {
  readonly success: boolean;
  readonly expression?: ParsedDiceExpression;
  readonly error?: string;
}

export class DiceParser {
  private static readonly MAX_FACES = 100000;
  private static readonly MAX_COUNT = 1000;
  
  parse(expression: string): ParseResult {
    const trimmed = expression.trim();
    
    // Match pattern: N d M [kl/kh/dl/dh N] [reason]
    const match = trimmed.match(/^(?:(\d+)\s*d\s*(\d+))(\s+(kl|kh|dl|dh)\s*(\d+))?(\s+.+)?$/i);
    
    if (!match) {
      return {
        success: false,
        error: `Invalid dice expression: ${expression}`
      };
    }
    
    const countStr = match[1];
    const facesStr = match[2];
    const keepDropOp = match[4];
    const keepCountStr = match[5];
    const reason = match[6]?.trim().replace(/^[\s-]+/, '') || undefined;
    
    const count = parseInt(countStr, 10);
    const faces = parseInt(facesStr, 10);
    const keepCount = keepCountStr ? parseInt(keepCountStr, 10) : undefined;
    
    // Validate
    if (isNaN(count) || count <= 0) {
      return {
        success: false,
        error: `Invalid count: ${countStr}`
      };
    }
    
    if (isNaN(faces) || faces <= 0) {
      return {
        success: false,
        error: `Invalid faces: ${facesStr}`
      };
    }
    
    if (count > DiceParser.MAX_COUNT) {
      return {
        success: false,
        error: `Count exceeds maximum: ${DiceParser.MAX_COUNT}`
      };
    }
    
    if (faces > DiceParser.MAX_FACES) {
      return {
        success: false,
        error: `Faces exceeds maximum: ${DiceParser.MAX_FACES}`
      };
    }
    
    // Normalize keep drop operation
    let keepDrop: KeepDropType | undefined;
    let normalizedKeepCount: number | undefined;
    
    if (keepDropOp) {
      keepDrop = keepDropOp.toLowerCase() as KeepDropType;
      normalizedKeepCount = keepCount || Math.ceil(count / 2);
      
      if (normalizedKeepCount > count) {
        normalizedKeepCount = count;
      }
    }
    
    return {
      success: true,
      expression: {
        type: 'dice',
        faces,
        count,
        keepDrop,
        keepCount: normalizedKeepCount,
        reason
      }
    };
  }
  
  evaluate(parsed: ParsedDiceExpression, randomSource: RandomSource): number[] {
    const rolls = rollDice(parsed.faces, parsed.count, randomSource);
    
    if (parsed.keepDrop && parsed.keepCount) {
      return applyKeepDrop(rolls, parsed.keepDrop, parsed.keepCount);
    }
    
    return rolls;
  }
}

export function simpleRoll(
  faces: number,
  count: number,
  randomSource: RandomSource
): number {
  const rolls = rollDice(faces, count, randomSource);
  return rolls.reduce((sum, n) => sum + n, 0);
}
