import { CommandScope, StateSnapshot, CommandCommit, CommitOutcome } from '../ports/state-store';
import { RandomSource } from '../ports/random-source';
import { CocCheckResult, performCocCheck } from '../domain/rules/coc7/check';
import { DiceRollResult, rollDice, createWebCryptoRandomSource } from '../domain/dice/expression';
import { CharacterSheet } from '../domain/character/sheet';
import { ConversationSession } from '../domain/session/conversation';

export interface CommandContext {
  readonly snapshot: StateSnapshot;
  readonly randomSource: RandomSource;
  readonly configVersion: string;
  readonly budget: CommandBudget;
}

export interface CommandBudget {
  readonly maxDiceRolls: number;
  readonly maxRecursionDepth: number;
  readonly maxOutputBytes: number;
}

export interface CommandDecision {
  readonly success: boolean;
  readonly executionId: string;
  readonly stateUpdates?: StateUpdate[];
  readonly results: CommandResult[];
  readonly errors?: CommandError[];
}

export interface CommandResult {
  readonly type: 'coc_check' | 'dice_roll' | 'character_save' | 'deck_draw';
  readonly data: unknown;
}

export interface CommandError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface StateUpdate {
  readonly type: 'conversation' | 'character' | 'binding' | 'policy' | 'deck';
  readonly id: string;
  readonly data: unknown;
  readonly expectedVersion: number;
}

export class CommandExecutor {
  private readonly randomSource: RandomSource;
  
  constructor(randomSource?: RandomSource) {
    this.randomSource = randomSource || createWebCryptoRandomSource();
  }
  
  async execute(
    scope: CommandScope,
    context: CommandContext
  ): Promise<CommandDecision> {
    const executionId = this.generateExecutionId();
    
    try {
      if (!context.snapshot.conversation) {
        return {
          success: false,
          executionId,
          results: [],
          errors: [{
            code: 'NO_CONVERSATION',
            message: 'No active conversation found'
          }]
        };
      }
      
      return {
        success: true,
        executionId,
        results: [],
        stateUpdates: []
      };
    } catch (error) {
      return {
        success: false,
        executionId,
        results: [],
        errors: [{
          code: 'EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error'
        }]
      };
    }
  }
  
  private generateExecutionId(): string {
    return `exec_${Date.now()}_${this.randomSource.integer(1000000, 9999999)}`;
  }
}

export function rollSimpleDice(
  faces: number,
  count: number,
  randomSource: RandomSource
): DiceRollResult {
  const rolls = rollDice(faces, count, randomSource);
  return {
    expression: `${count}d${faces}`,
    diceFaces: rolls,
    total: rolls.reduce((sum, n) => sum + n, 0),
    individualRolls: rolls
  };
}
