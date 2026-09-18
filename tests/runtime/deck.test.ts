import { describe, it, expect } from 'vitest';
import { 
  createDeck, 
  createDeckSession, 
  drawFromDeck,
  createWebCryptoRandomSource 
} from '../../../packages/core/src/domain/deck/deck';

describe('Deck', () => {
  const randomSource = createWebCryptoRandomSource();
  
  it('should create deck with version', () => {
    const deck = createDeck({
      id: 'test-deck',
      name: 'Test Deck',
      cards: []
    });
    
    expect(deck.version).toBe(1);
  });
  
  it('should create deck session', () => {
    const session = createDeckSession('test-deck');
    expect(session.deckId).toBe('test-deck');
    expect(session.remainingCards).toHaveLength(0);
    expect(session.drawnCount).toBe(0);
  });
});

describe('Draw from Deck', () => {
  const randomSource = createWebCryptoRandomSource();
  
  it('should return null when deck is empty', () => {
    const session = createDeckSession('empty');
    const result = drawFromDeck(session, randomSource);
    expect(result).toBeNull();
  });
  
  it('should draw card from non-empty deck', () => {
    const session: any = {
      deckId: 'test',
      remainingCards: [
        { id: 'c1', text: 'Card 1', weight: 1 },
        { id: 'c2', text: 'Card 2', weight: 1 }
      ],
      drawnCount: 0,
      version: 1
    };
    
    const result = drawFromDeck(session, randomSource);
    expect(result).not.toBeNull();
    expect(result?.card).toBeDefined();
    expect(result?.remainingCount).toBe(1);
    expect(result?.isLastCard).toBe(false);
  });
  
  it('should mark last card correctly', () => {
    const session: any = {
      deckId: 'test',
      remainingCards: [{ id: 'c1', text: 'Last', weight: 1 }],
      drawnCount: 0,
      version: 1
    };
    
    const result = drawFromDeck(session, randomSource);
    expect(result?.isLastCard).toBe(true);
  });
});
