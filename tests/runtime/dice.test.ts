import {
  ExpressionBudgetError,
  applyKeepDrop,
  createWebCryptoRandomSource,
  parseDiceExpression,
  rollDice,
} from '@dicefunc/core';
import { describe, expect, it } from 'vitest';

describe('applyKeepDrop', () => {
  it('drops lowest rolls with dl', () => {
    const rolls = [4, 1, 6, 2, 5];
    const kept = applyKeepDrop(rolls, 'dl', 2);
    expect(kept).toEqual([4, 5, 6]);
  });

  it('drops highest rolls with dh', () => {
    const rolls = [4, 1, 6, 2, 5];
    const kept = applyKeepDrop(rolls, 'dh', 2);
    expect(kept).toEqual([1, 2, 4]);
  });

  it('keeps highest rolls with kh', () => {
    const rolls = [4, 1, 6, 2, 5];
    const kept = applyKeepDrop(rolls, 'kh', 2);
    expect(kept).toEqual([5, 6]);
  });

  it('keeps lowest rolls with kl', () => {
    const rolls = [4, 1, 6, 2, 5];
    const kept = applyKeepDrop(rolls, 'kl', 2);
    expect(kept).toEqual([1, 2]);
  });

  it('handles boundary counts for keep and drop', () => {
    const rolls = [1, 2, 3];
    expect(applyKeepDrop(rolls, 'dl', 0)).toEqual([1, 2, 3]);
    expect(applyKeepDrop(rolls, 'dh', 0)).toEqual([1, 2, 3]);
    expect(applyKeepDrop(rolls, 'kl', 0)).toEqual([]);
    expect(applyKeepDrop(rolls, 'kh', 0)).toEqual([]);

    expect(applyKeepDrop(rolls, 'dl', 3)).toEqual([]);
    expect(applyKeepDrop(rolls, 'dh', 3)).toEqual([]);
    expect(applyKeepDrop(rolls, 'kl', 3)).toEqual([1, 2, 3]);
    expect(applyKeepDrop(rolls, 'kh', 3)).toEqual([1, 2, 3]);
  });
});

describe('parseDiceExpression', () => {
  it('parses positive and negative modifiers', () => {
    const parsedPlus = parseDiceExpression('3d6 + 5');
    expect(parsedPlus.success).toBe(true);
    expect(parsedPlus.expression?.modifier).toBe(5);

    const parsedMinus = parseDiceExpression('1d100 - 10');
    expect(parsedMinus.success).toBe(true);
    expect(parsedMinus.expression?.modifier).toBe(-10);
  });

  it('parses repeat count xN and *N', () => {
    const parsedX = parseDiceExpression('2d6 x3');
    expect(parsedX.success).toBe(true);
    expect(parsedX.expression?.repeat).toBe(3);

    const parsedStar = parseDiceExpression('2d6 * 4');
    expect(parsedStar.success).toBe(true);
    expect(parsedStar.expression?.repeat).toBe(4);
  });

  it('parses keep and drop operators', () => {
    const parsedDl = parseDiceExpression('5d6dl2');
    expect(parsedDl.success).toBe(true);
    expect(parsedDl.expression?.keepDrop).toBe('dl');
    expect(parsedDl.expression?.keepCount).toBe(2);

    const parsedKh = parseDiceExpression('4d6kh3');
    expect(parsedKh.success).toBe(true);
    expect(parsedKh.expression?.keepDrop).toBe('kh');
    expect(parsedKh.expression?.keepCount).toBe(3);
  });

  it('parses Chinese advantage and disadvantage keywords', () => {
    const adv = parseDiceExpression('2d20优势');
    expect(adv.success).toBe(true);
    expect(adv.expression?.count).toBe(2);
    expect(adv.expression?.faces).toBe(20);
    expect(adv.expression?.keepDrop).toBe('kh');
    expect(adv.expression?.keepCount).toBe(1);

    const disadv = parseDiceExpression('2d20劣势');
    expect(disadv.success).toBe(true);
    expect(disadv.expression?.keepDrop).toBe('kl');
    expect(disadv.expression?.keepCount).toBe(1);

    const tradAdv = parseDiceExpression('2d20優勢');
    expect(tradAdv.success).toBe(true);
    expect(tradAdv.expression?.keepDrop).toBe('kh');

    const tradDisadv = parseDiceExpression('2d20劣勢');
    expect(tradDisadv.success).toBe(true);
    expect(tradDisadv.expression?.keepDrop).toBe('kl');
  });

  it('parses compound arithmetic dice expressions', () => {
    const compound = parseDiceExpression('1d20 + 2d6 + 5');
    expect(compound.success).toBe(true);
    expect(compound.expression?.isCompound).toBe(true);
    expect(compound.expression?.ast.kind).toBe('binary');
  });

  it('parses nested parentheses in dice expressions', () => {
    const nested = parseDiceExpression('(1d6 + 2) * 3');
    expect(nested.success).toBe(true);
    expect(nested.expression?.isCompound).toBe(true);
    expect(nested.expression?.ast.kind).toBe('binary');
  });

  it('throws ExpressionBudgetError when budget limits are exceeded', () => {
    expect(() => parseDiceExpression('101d6')).toThrow(ExpressionBudgetError);
    expect(() => parseDiceExpression('1d6 x11')).toThrow(ExpressionBudgetError);
    expect(() => parseDiceExpression('a'.repeat(2049))).toThrow(ExpressionBudgetError);
  });
});

describe('rollDice', () => {
  it('rolls the expected number of dice within bounds', async () => {
    const rng = createWebCryptoRandomSource();
    const rolls = await rollDice(6, 5, rng);
    expect(rolls).toHaveLength(5);
    for (const roll of rolls) {
      expect(roll).toBeGreaterThanOrEqual(1);
      expect(roll).toBeLessThanOrEqual(6);
    }
  });

  it('returns empty array when count or sides is non-positive', async () => {
    const rng = createWebCryptoRandomSource();
    expect(await rollDice(0, 5, rng)).toEqual([]);
    expect(await rollDice(6, 0, rng)).toEqual([]);
  });
});
