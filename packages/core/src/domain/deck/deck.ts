export interface Deck {
  readonly id: string;
  readonly name: string;
  readonly cards: Card[];
  readonly version: number;
}

export interface Card {
  readonly id: string;
  readonly text: string;
  readonly weight: number;
  readonly nestedDecks?: NestedDeck[];
}

export interface NestedDeck {
  readonly deckId: string;
  readonly weight: number;
}

export interface DeckSession {
  readonly deckId: string;
  readonly remainingCards: Card[];
  readonly drawnCount: number;
  readonly version: number;
}

export interface DrawResult {
  readonly card: Card;
  readonly remainingCount: number;
  readonly isLastCard: boolean;
}

export function createDeck(deckData: Omit<Deck, 'version'>): Deck {
  return {
    ...deckData,
    version: 1
  };
}

export function createDeckSession(deckId: string): DeckSession {
  return {
    deckId,
    remainingCards: [],
    drawnCount: 0,
    version: 1
  };
}

export function drawFromDeck(
  session: DeckSession,
  randomSource: RandomSource
): DrawResult | null {
  if (session.remainingCards.length === 0) {
    return null;
  }
  
  const totalWeight = session.remainingCards.reduce((sum, card) => sum + card.weight, 0);
  let random = randomSource.integer(1, totalWeight);
  let cumulative = 0;
  
  for (const card of session.remainingCards) {
    cumulative += card.weight;
    if (random <= cumulative) {
      const newRemaining = session.remainingCards.filter(c => c.id !== card.id);
      return {
        card,
        remainingCount: newRemaining.length,
        isLastCard: newRemaining.length === 0
      };
    }
  }
  
  return null;
}
