export class ExpressionBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionBudgetError';
  }
}

import type { RandomSource } from '../../ports/random-source.js';
import { type DiceRollResult, type KeepDropType, applyKeepDrop } from './expression.js';

export interface DiceGroupNode {
  readonly kind: 'dice';
  readonly count: number;
  readonly faces: number;
  readonly keepDrop?: KeepDropType | undefined;
  readonly keepCount?: number | undefined;
}

export interface NumberNode {
  readonly kind: 'number';
  readonly value: number;
}

export interface UnaryOpNode {
  readonly kind: 'unary';
  readonly op: '+' | '-';
  readonly operand: AstNode;
}

export interface BinaryOpNode {
  readonly kind: 'binary';
  readonly op: '+' | '-' | '*' | '/' | '%' | '^';
  readonly left: AstNode;
  readonly right: AstNode;
}

export type AstNode = DiceGroupNode | NumberNode | UnaryOpNode | BinaryOpNode;

export interface AstEvaluationResult {
  readonly value: number;
  readonly rendered: string;
  readonly diceGroups: readonly DiceRollResult[];
}
export async function evaluateAst(
  node: AstNode,
  random: RandomSource,
): Promise<AstEvaluationResult> {
  switch (node.kind) {
    case 'number':
      return {
        value: node.value,
        rendered: String(node.value),
        diceGroups: [],
      };
    case 'dice': {
      const rolls: number[] = [];
      for (let i = 0; i < node.count; i++) {
        rolls.push(await random.integer(1, node.faces));
      }
      let kept = rolls;
      if (node.keepDrop && node.keepCount !== undefined) {
        kept = applyKeepDrop(rolls, node.keepDrop, node.keepCount);
      }
      const total = kept.reduce((a, b) => a + b, 0);
      const groupResult: DiceRollResult = {
        expression: `${node.count}d${node.faces}`,
        faces: node.faces,
        count: node.count,
        rolls: [...rolls],
        keptRolls: kept,
        total,
        ...(node.keepDrop !== undefined
          ? { keepDrop: node.keepDrop, keepCount: node.keepCount ?? 1 }
          : {}),
      };
      return {
        value: total,
        rendered: `[${rolls.join(', ')}]`,
        diceGroups: [groupResult],
      };
    }
    case 'unary': {
      const sub = await evaluateAst(node.operand, random);
      const val = node.op === '-' ? -sub.value : sub.value;
      const rend = node.op === '-' ? `-${sub.rendered}` : sub.rendered;
      return {
        value: val,
        rendered: rend,
        diceGroups: sub.diceGroups,
      };
    }
    case 'binary': {
      const left = await evaluateAst(node.left, random);
      const right = await evaluateAst(node.right, random);
      let val: number;
      switch (node.op) {
        case '+':
          val = left.value + right.value;
          break;
        case '-':
          val = left.value - right.value;
          break;
        case '*':
          val = left.value * right.value;
          break;
        case '/':
          val = right.value === 0 ? 0 : Math.floor(left.value / right.value);
          break;
        case '%':
          val = right.value === 0 ? 0 : left.value % right.value;
          break;
        case '^':
          val = left.value ** right.value;
          break;
      }
      const rendered = `${left.rendered} ${node.op} ${right.rendered}`;
      return {
        value: val,
        rendered,
        diceGroups: [...left.diceGroups, ...right.diceGroups],
      };
    }
  }
}

export function collectDiceBudget(
  node: AstNode,
  maxSingleDice = 100,
): { totalDice: number; diceGroups: DiceGroupNode[] } {
  const diceGroups: DiceGroupNode[] = [];
  let totalDice = 0;

  function traverse(n: AstNode): void {
    switch (n.kind) {
      case 'number':
        break;
      case 'dice':
        if (n.count > maxSingleDice) {
          throw new ExpressionBudgetError(
            `Dice count ${n.count} exceeds maximum of ${maxSingleDice}`,
          );
        }
        totalDice += n.count;
        diceGroups.push(n);
        break;
      case 'unary':
        traverse(n.operand);
        break;
      case 'binary':
        traverse(n.left);
        traverse(n.right);
        break;
    }
  }

  traverse(node);
  return { totalDice, diceGroups };
}
