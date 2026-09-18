import {
  createDeck,
  createDeckSession,
  createWebCryptoRandomSource,
  drawFromDeck,
} from '@dicefunc/core';
import { describe, expect, it } from 'vitest';

describe('Deck weight validation', () => {
  it('throws when card weight is 0', () => {
    expect(() =>
      createDeck({
        id: 'deck-zero-weight',
        name: 'Zero Weight Deck',
        cards: [{ id: 'c1', text: 'Card 1', weight: 0 }],
      }),
    ).toThrow(/Invalid card weight/);
  });

  it('throws when card weight is negative', () => {
    expect(() =>
      createDeck({
        id: 'deck-neg-weight',
        name: 'Negative Weight Deck',
        cards: [{ id: 'c1', text: 'Card 1', weight: -3 }],
      }),
    ).toThrow(/Invalid card weight/);
  });

  it('throws when card weight is not an integer', () => {
    expect(() =>
      createDeck({
        id: 'deck-float-weight',
        name: 'Float Weight Deck',
        cards: [{ id: 'c1', text: 'Card 1', weight: 2.5 }],
      }),
    ).toThrow(/Invalid card weight/);
  });

  it('throws when deck is empty', () => {
    expect(() =>
      createDeck({
        id: 'deck-empty',
        name: 'Empty Deck',
        cards: [],
      }),
    ).toThrow(/Deck must not be empty/);
  });
});

describe('Deck session immutability and continuous draw', () => {
  const rng = createWebCryptoRandomSource();

  it('preserves previous session immutably when drawing', async () => {
    const deck = createDeck({
      id: 'deck-1',
      name: 'Sample Deck',
      cards: [
        { id: 'c1', text: 'First Card', weight: 1 },
        { id: 'c2', text: 'Second Card', weight: 1 },
      ],
    });

    const initialSession = createDeckSession('session-1', deck);
    expect(initialSession.remaining).toHaveLength(2);
    expect(initialSession.drawnCount).toBe(0);

    const draw1 = await drawFromDeck(initialSession, 1, rng);
    expect(draw1.drawn).toHaveLength(1);
    expect(draw1.session.remaining).toHaveLength(1);
    expect(draw1.session.drawnCount).toBe(1);
    expect(draw1.session.version).toBe(2);

    expect(initialSession.remaining).toHaveLength(2);
    expect(initialSession.drawnCount).toBe(0);
    expect(initialSession.version).toBe(1);
  });

  it('draws without replacement and throws when deck is exhausted', async () => {
    const deck = createDeck({
      id: 'deck-2',
      name: 'Exhaustible Deck',
      cards: [
        { id: 'c1', text: 'Card A', weight: 1 },
        { id: 'c2', text: 'Card B', weight: 1 },
      ],
    });

    let currentSession = createDeckSession('session-2', deck);

    const firstDraw = await drawFromDeck(currentSession, 1, rng);
    expect(firstDraw.drawn).toHaveLength(1);
    expect(firstDraw.session.remaining).toHaveLength(1);
    currentSession = firstDraw.session;

    const secondDraw = await drawFromDeck(currentSession, 1, rng);
    expect(secondDraw.drawn).toHaveLength(1);
    expect(secondDraw.session.remaining).toHaveLength(0);
    currentSession = secondDraw.session;

    await expect(drawFromDeck(currentSession, 1, rng)).rejects.toThrow(/Deck is exhausted/);
  });
});
