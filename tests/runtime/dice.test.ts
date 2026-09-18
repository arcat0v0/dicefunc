import { describe, it, expect } from 'vitest';
import { rollDice, applyKeepDrop, createWebCryptoRandomSource } from '../../../packages/core/src/domain/dice/expression';

describe('Dice Rolling', () => {
  const randomSource = createWebCryptoRandomSource();
  
  it('should roll single die', () => {
    const rolls = rollDice(6, 1, randomSource);
    expect(rolls).toHaveLength(1);
    expect(rolls[0]).toBeGreaterThanOrEqual(1);
    expect(rolls[0]).toBeLessThanOrEqual(6);
  });
  
  it('should roll multiple dice', () => {
    const rolls = rollDice(6, 3, randomSource);
    expect(rolls).toHaveLength(3);
    rolls.forEach(r => {
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(6);
    });
  });
  
  it('should sort rolls in ascending order', () => {
    const rolls = rollDice(6, 5, randomSource);
    for (let i = 1; i < rolls.length; i++) {
      expect(rolls[i]).toBeGreaterThanOrEqual(rolls[i - 1]);
    }
  });
});

describe('Keep/Drop', () => {
  it('should keep lowest', () => {
    const rolls = [1, 2, 3, 4, 5];
    const result = applyKeepDrop(rolls, 'kl', 2);
    expect(result).toEqual([1, 2]);
  });
  
  it('should keep highest', () => {
    const rolls = [1, 2, 3, 4, 5];
    const result = applyKeepDrop(rolls, 'kh', 2);
    expect(result).toEqual([4, 5]);
  });
  
  it('should drop lowest', () => {
    const rolls = [1, 2, 3, 4, 5];
    const result = applyKeepDrop(rolls, 'dl', 2);
    expect(result).toEqual([4, 5]);
  });
  
  it('should drop highest', () => {
    const rolls = [1, 2, 3, 4, 5];
    const result = applyKeepDrop(rolls, 'dh', 2);
    expect(result).toEqual([1, 2]);
  });
  
  it('should return all rolls when count equals length', () => {
    const rolls = [1, 2, 3, 4, 5];
    const result = applyKeepDrop(rolls, 'kl', 5);
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });
});
