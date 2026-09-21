import {
  type AstNode,
  type DiceGroupNode,
  ExpressionBudgetError,
  collectDiceBudget,
} from './ast.js';
import type { KeepDropType } from './expression.js';

export { ExpressionBudgetError } from './ast.js';

export interface ParsedDiceExpression {
  readonly type: 'dice';
  readonly faces: number;
  readonly count: number;
  readonly keepDrop?: KeepDropType | undefined;
  readonly keepCount?: number | undefined;
  readonly modifier?: number | undefined;
  readonly repeat: number;
  readonly reason?: string | undefined;
  readonly ast: AstNode;
  readonly isCompound: boolean;
}

export interface ParseResult {
  readonly success: boolean;
  readonly expression?: ParsedDiceExpression | undefined;
  readonly error?: string | undefined;
}

export interface ParseDiceExpressionOptions {
  readonly allowVariables?: boolean | undefined;
}

enum Precedence {
  NONE = 0,
  ADD_SUB = 1,
  MUL_DIV = 2,
  POWER = 3,
  UNARY = 4,
}

type Token =
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'dice'; readonly node: DiceGroupNode }
  | { readonly type: 'variable'; readonly name: string }
  | { readonly type: '+' | '-' | '*' | '/' | '%' | '^' | '(' | ')' }
  | { readonly type: 'eof' };

class Tokenizer {
  private pos = 0;
  private readonly text: string;
  private readonly defaultSides: number;

  constructor(text: string, defaultSides: number) {
    this.text = text;
    this.defaultSides = defaultSides;
  }

  getRemaining(): string {
    return this.text.slice(this.pos).trim();
  }

  getPosition(): number {
    return this.pos;
  }

  nextToken(allowVariable = false): Token {
    this.skipWhitespace();
    if (this.pos >= this.text.length) {
      return { type: 'eof' };
    }

    const remaining = this.text.slice(this.pos);

    const ch = remaining[0];
    if (
      ch === '(' ||
      ch === ')' ||
      ch === '+' ||
      ch === '-' ||
      ch === '*' ||
      ch === '/' ||
      ch === '%' ||
      ch === '^'
    ) {
      this.pos++;
      return { type: ch };
    }

    const diceMatch = remaining.match(
      /^(\d+)?([dD])(\d+)?(?:(kh|kl|dh|dl|k|q|优势|劣势|優勢|劣勢)(\d+)?)?/,
    );
    const diceMatchEndsAtIdentifier =
      diceMatch !== null &&
      diceMatch[3] === undefined &&
      diceMatch[4] === undefined &&
      /^[\p{L}\p{N}_:]$/u.test(remaining[diceMatch[0].length] ?? '');
    if (diceMatch && !diceMatchEndsAtIdentifier) {
      const countStr = diceMatch[1];
      const facesStr = diceMatch[3];
      const modStr = diceMatch[4];
      const keepCountStr = diceMatch[5];

      let count = countStr !== undefined ? Number.parseInt(countStr, 10) : 1;
      const faces = facesStr !== undefined ? Number.parseInt(facesStr, 10) : this.defaultSides;

      if (Number.isNaN(count) || count <= 0) {
        throw new Error(`Invalid count: ${countStr ?? ''}`);
      }
      if (Number.isNaN(faces) || faces <= 0) {
        throw new Error(`Invalid faces: ${facesStr ?? ''}`);
      }

      let keepDrop: KeepDropType | undefined;
      let keepCount: number | undefined;

      if (modStr) {
        const lowerMod = modStr.toLowerCase();
        if (lowerMod === '优势' || lowerMod === '優勢') {
          keepDrop = 'kh';
          keepCount = 1;
        } else if (lowerMod === '劣势' || lowerMod === '劣勢') {
          keepDrop = 'kl';
          keepCount = 1;
        } else if (lowerMod === 'kh' || lowerMod === 'k') {
          keepDrop = 'kh';
          keepCount = keepCountStr !== undefined ? Number.parseInt(keepCountStr, 10) : 1;
        } else if (lowerMod === 'kl' || lowerMod === 'q') {
          keepDrop = 'kl';
          keepCount = keepCountStr !== undefined ? Number.parseInt(keepCountStr, 10) : 1;
        } else if (lowerMod === 'dh') {
          keepDrop = 'dh';
          keepCount = keepCountStr !== undefined ? Number.parseInt(keepCountStr, 10) : 1;
        } else if (lowerMod === 'dl') {
          keepDrop = 'dl';
          keepCount = keepCountStr !== undefined ? Number.parseInt(keepCountStr, 10) : 1;
        }

        if (
          countStr === undefined &&
          (lowerMod === '优势' ||
            lowerMod === '優勢' ||
            lowerMod === '劣势' ||
            lowerMod === '劣勢' ||
            ((lowerMod === 'kh' || lowerMod === 'kl') && keepCountStr === undefined))
        ) {
          count = 2;
        }

        if (keepCount !== undefined && (Number.isNaN(keepCount) || keepCount <= 0)) {
          throw new Error(`Invalid keep/drop count: ${keepCountStr ?? ''}`);
        }
      }

      this.pos += diceMatch[0].length;
      const node: DiceGroupNode = {
        kind: 'dice',
        count,
        faces,
        ...(keepDrop !== undefined ? { keepDrop, keepCount } : {}),
      };
      return { type: 'dice', node };
    }

    const numMatch = remaining.match(/^\d+/);
    if (numMatch) {
      this.pos += numMatch[0].length;
      return { type: 'number', value: Number.parseInt(numMatch[0], 10) };
    }

    if (allowVariable) {
      const variableMatch = remaining.match(/^[\p{L}_][\p{L}\p{N}_:]*/u);
      if (variableMatch) {
        this.pos += variableMatch[0].length;
        return { type: 'variable', name: variableMatch[0] };
      }
    }

    return { type: 'eof' };
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        this.pos++;
      } else {
        break;
      }
    }
  }
}

class PrattParser {
  private currentToken: Token;

  constructor(
    private readonly tokenizer: Tokenizer,
    private readonly allowVariables: boolean,
  ) {
    this.currentToken = this.tokenizer.nextToken(this.allowVariables);
  }

  parse(): AstNode {
    return this.parseExpression(Precedence.NONE);
  }

  private parseExpression(precedence: Precedence): AstNode {
    let left = this.parsePrefix();

    while (
      this.currentToken.type !== 'eof' &&
      precedence < this.getBindingPower(this.currentToken.type)
    ) {
      left = this.parseInfix(left);
    }

    return left;
  }

  private parsePrefix(): AstNode {
    const token = this.currentToken;

    if (token.type === 'number') {
      this.currentToken = this.tokenizer.nextToken();
      return { kind: 'number', value: token.value };
    }

    if (token.type === 'dice') {
      this.currentToken = this.tokenizer.nextToken();
      return token.node;
    }

    if (token.type === 'variable') {
      this.currentToken = this.tokenizer.nextToken();
      return { kind: 'variable', name: token.name };
    }

    if (token.type === '+') {
      this.currentToken = this.tokenizer.nextToken(this.allowVariables);
      return { kind: 'unary', op: '+', operand: this.parseExpression(Precedence.UNARY) };
    }

    if (token.type === '-') {
      this.currentToken = this.tokenizer.nextToken(this.allowVariables);
      return { kind: 'unary', op: '-', operand: this.parseExpression(Precedence.UNARY) };
    }

    if (token.type === '(') {
      this.currentToken = this.tokenizer.nextToken(this.allowVariables);
      const expr = this.parseExpression(Precedence.NONE);
      if (this.currentToken.type !== ')') {
        throw new Error('Unclosed parenthesis');
      }
      this.currentToken = this.tokenizer.nextToken();
      return expr;
    }

    throw new Error(`Unexpected token: ${JSON.stringify(token)}`);
  }

  private parseInfix(left: AstNode): AstNode {
    const opToken = this.currentToken;
    const op = opToken.type as '+' | '-' | '*' | '/' | '%' | '^';
    const bp = this.getBindingPower(op);

    this.currentToken = this.tokenizer.nextToken(this.allowVariables);

    const rightBp = op === '^' ? ((bp - 1) as Precedence) : bp;
    const right = this.parseExpression(rightBp);

    return {
      kind: 'binary',
      op,
      left,
      right,
    };
  }

  private getBindingPower(type: string): Precedence {
    switch (type) {
      case '+':
      case '-':
        return Precedence.ADD_SUB;
      case '*':
      case '/':
      case '%':
        return Precedence.MUL_DIV;
      case '^':
        return Precedence.POWER;
      default:
        return Precedence.NONE;
    }
  }
}

export function parseDiceExpression(
  expression: string,
  defaultSides = 100,
  options: ParseDiceExpressionOptions = {},
): ParseResult {
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

  let exprToParse = trimmed;
  let repeat = 1;
  let reason: string | undefined;

  const repeatXMatch = trimmed.match(/^(.*?)(?:\s+[xX]\s*(\d+)|\s+[xX](\d+))(?:\s+(.*))?$/);
  const singleDiceStarMatch = trimmed.match(
    /^(\d*d\d*(?:[a-zA-Z\u4e00-\u9fa5]+\d*)?)\s*\*\s*(\d+)(?:\s+(.*))?$/i,
  );

  if (singleDiceStarMatch?.[1] && singleDiceStarMatch[2]) {
    exprToParse = singleDiceStarMatch[1];
    repeat = Number.parseInt(singleDiceStarMatch[2], 10);
    const rawReason = singleDiceStarMatch[3]?.trim();
    reason = rawReason ? rawReason : undefined;
  } else if (repeatXMatch?.[1] && (repeatXMatch[2] || repeatXMatch[3])) {
    exprToParse = repeatXMatch[1];
    const repStr = repeatXMatch[2] ?? repeatXMatch[3] ?? '1';
    repeat = Number.parseInt(repStr, 10);
    const rawReason = repeatXMatch[4]?.trim();
    reason = rawReason ? rawReason : undefined;
  }

  if (Number.isNaN(repeat) || repeat <= 0) {
    return {
      success: false,
      error: 'Invalid repeat count',
    };
  }

  if (repeat > 10) {
    throw new ExpressionBudgetError(`Repeat count ${repeat} exceeds maximum of 10`);
  }

  try {
    const tokenizer = new Tokenizer(exprToParse, defaultSides);
    const parser = new PrattParser(tokenizer, options.allowVariables ?? false);
    const ast = parser.parse();

    const remaining = tokenizer.getRemaining();
    if (remaining) {
      if (!reason) {
        reason = remaining;
      } else {
        reason = `${remaining} ${reason}`;
      }
    }

    const { totalDice, diceGroups } = collectDiceBudget(ast);
    if (diceGroups.length === 0) {
      return {
        success: false,
        error: `Invalid dice expression: ${expression}`,
      };
    }

    if (totalDice * repeat > 1000) {
      throw new ExpressionBudgetError(
        `Total dice ${totalDice * repeat} exceeds maximum of 1000 per command`,
      );
    }

    let faces = defaultSides;
    let count = 1;
    let keepDrop: KeepDropType | undefined;
    let keepCount: number | undefined;
    let modifier: number | undefined;
    let isCompound = false;

    if (ast.kind === 'dice') {
      faces = ast.faces;
      count = ast.count;
      keepDrop = ast.keepDrop;
      keepCount = ast.keepCount;
    } else if (
      ast.kind === 'binary' &&
      ast.left.kind === 'dice' &&
      ast.right.kind === 'number' &&
      (ast.op === '+' || ast.op === '-')
    ) {
      faces = ast.left.faces;
      count = ast.left.count;
      keepDrop = ast.left.keepDrop;
      keepCount = ast.left.keepCount;
      modifier = ast.op === '-' ? -ast.right.value : ast.right.value;
    } else {
      isCompound = true;
      const firstGroup = diceGroups[0];
      if (firstGroup) {
        faces = firstGroup.faces;
        count = firstGroup.count;
      }
    }

    const parsed: ParsedDiceExpression = {
      type: 'dice',
      faces,
      count,
      repeat,
      ast,
      isCompound,
      ...(keepDrop !== undefined ? { keepDrop, keepCount } : {}),
      ...(modifier !== undefined ? { modifier } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };

    return {
      success: true,
      expression: parsed,
    };
  } catch (err) {
    if (err instanceof ExpressionBudgetError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message.startsWith('Invalid') ? message : `Invalid dice expression: ${expression}`,
    };
  }
}

export class DiceParser {
  parse(
    expression: string,
    defaultSides = 100,
    options: ParseDiceExpressionOptions = {},
  ): ParseResult {
    return parseDiceExpression(expression, defaultSides, options);
  }
}
