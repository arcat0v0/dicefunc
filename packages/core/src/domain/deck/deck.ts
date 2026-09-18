import type { RandomSource } from '../../ports/random-source.js';

export interface Card {
  readonly id: string;
  readonly text: string;
  readonly weight: number;
}

export interface Deck {
  readonly id: string;
  readonly name: string;
  readonly cards: readonly Card[];
  readonly version: number;
}

export interface DeckSession {
  readonly sessionId: string;
  readonly deckId: string;
  readonly remaining: readonly Card[];
  readonly drawnCount: number;
  readonly version: number;
}

export function createDeck(input: {
  readonly id: string;
  readonly name: string;
  readonly cards: readonly Card[];
}): Deck {
  if (input.cards.length === 0) {
    throw new Error('Deck must not be empty');
  }
  for (const card of input.cards) {
    if (!Number.isInteger(card.weight) || card.weight <= 0) {
      throw new Error(`Invalid card weight: ${card.weight}`);
    }
  }
  return {
    id: input.id,
    name: input.name,
    cards: Object.freeze([...input.cards]),
    version: 1,
  };
}

export function createDeckSession(sessionId: string, deck: Deck): DeckSession {
  return {
    sessionId,
    deckId: deck.id,
    remaining: Object.freeze([...deck.cards]),
    drawnCount: 0,
    version: 1,
  };
}

export async function drawFromDeck(
  session: DeckSession,
  count: number,
  random: RandomSource,
): Promise<{
  readonly session: DeckSession;
  readonly drawn: readonly Card[];
}> {
  if (count <= 0) {
    return {
      session,
      drawn: [],
    };
  }
  if (session.remaining.length === 0) {
    throw new Error('Deck is exhausted');
  }

  const currentRemaining = [...session.remaining];
  const drawn: Card[] = [];
  const drawLimit = Math.min(count, currentRemaining.length);

  for (let i = 0; i < drawLimit; i++) {
    const totalWeight = currentRemaining.reduce((sum, c) => sum + c.weight, 0);
    const target = await random.integer(1, totalWeight);
    let cumulative = 0;
    let chosenIndex = -1;

    for (const [j, card] of currentRemaining.entries()) {
      cumulative += card.weight;
      if (target <= cumulative) {
        chosenIndex = j;
        break;
      }
    }

    if (chosenIndex >= 0) {
      const [card] = currentRemaining.splice(chosenIndex, 1);
      if (card) {
        drawn.push(card);
      }
    }
  }

  const newSession: DeckSession = {
    sessionId: session.sessionId,
    deckId: session.deckId,
    remaining: Object.freeze(currentRemaining),
    drawnCount: session.drawnCount + drawn.length,
    version: session.version + 1,
  };

  return {
    session: newSession,
    drawn: Object.freeze(drawn),
  };
}
