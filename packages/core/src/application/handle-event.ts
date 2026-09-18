import { VerifiedEvent, StateStore, CommandScope } from '../ports/state-store';
import { CommandExecutor, CommandContext, CommandDecision } from './execute-command';
import { RandomSource, createWebCryptoRandomSource } from '../ports/random-source';

export interface EventHandler {
  handle(event: VerifiedEvent): Promise<EventOutcome>;
}

export interface EventOutcome {
  readonly success: boolean;
  readonly eventId: string;
  readonly executionId?: string;
  readonly messageKey: string;
  readonly queued: boolean;
  readonly error?: EventError;
}

export interface EventError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export class DefaultEventHandler implements EventHandler {
  private readonly stateStore: StateStore;
  private readonly commandExecutor: CommandExecutor;
  private readonly randomSource: RandomSource;
  
  constructor(
    stateStore: StateStore,
    commandExecutor?: CommandExecutor,
    randomSource?: RandomSource
  ) {
    this.stateStore = stateStore;
    this.commandExecutor = commandExecutor || new CommandExecutor();
    this.randomSource = randomSource || createWebCryptoRandomSource();
  }
  
  async handle(event: VerifiedEvent): Promise<EventOutcome> {
    const claim = await this.stateStore.claimEvent(event);
    
    if (claim.status !== 'claimed') {
      return {
        success: false,
        eventId: event.messageId,
        messageKey: claim.messageKey,
        queued: false,
        error: {
          code: 'EVENT_ALREADY_PROCESSED',
          message: 'Event has already been processed',
          retryable: false
        }
      };
    }
    
    try {
      const scope: CommandScope = {
        botId: event.botId,
        scene: event.scene,
        conversationId: `${event.scene}:${event.externalId}`,
        principalId: event.sender.scopeId
      };
      
      const snapshot = await this.stateStore.loadSnapshot(scope);
      
      const context: CommandContext = {
        snapshot,
        randomSource: this.randomSource,
        configVersion: claim.configDigest,
        budget: {
          maxDiceRolls: 1000,
          maxRecursionDepth: 32,
          maxOutputBytes: 4096
        }
      };
      
      const decision = await this.commandExecutor.execute(scope, context);
      
      if (decision.success && decision.executionId) {
        return {
          success: true,
          eventId: event.messageId,
          executionId: decision.executionId,
          messageKey: claim.messageKey,
          queued: true
        };
      }
      
      return {
        success: false,
        eventId: event.messageId,
        messageKey: claim.messageKey,
        queued: false,
        error: decision.errors?.[0] ? {
          code: decision.errors[0].code,
          message: decision.errors[0].message,
          retryable: false
        } : undefined
      };
      
    } catch (error) {
      return {
        success: false,
        eventId: event.messageId,
        messageKey: claim.messageKey,
        queued: false,
        error: {
          code: 'HANDLER_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: true
        }
      };
    }
  }
}
