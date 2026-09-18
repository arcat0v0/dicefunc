import { ConversationSession, CharacterSheet } from '../domain';

export interface EventClaim {
  readonly eventId: string;
  readonly messageKey: string;
  readonly conversationSeq: number;
  readonly status: 'claimed' | 'processing' | 'completed' | 'failed';
  readonly configDigest: string;
  readonly seed?: string;
}

export interface CommandScope {
  readonly botId: string;
  readonly scene: string;
  readonly conversationId: string;
  readonly principalId: string;
}

export interface StateSnapshot {
  readonly conversation: ConversationSession | null;
  readonly characterBinding?: CharacterBinding;
  readonly character?: CharacterSheet;
  readonly permissions: Permissions;
  readonly deckSessions: Record<string, DeckSession>;
}

export interface CharacterBinding {
  readonly sheetId: string;
  readonly version: number;
}

export interface Permissions {
  readonly isDiceMaster: boolean;
  readonly isGroupHost: boolean;
  readonly isTrusted: boolean;
  readonly denied: boolean;
}

export interface CommandCommit {
  readonly transactionId: string;
  readonly updates: StateUpdate[];
  readonly createdAt: Date;
}

export interface StateUpdate {
  readonly type: 'conversation' | 'character' | 'binding' | 'policy' | 'deck';
  readonly id: string;
  readonly data: unknown;
  readonly expectedVersion: number;
}

export interface CommitOutcome {
  readonly success: boolean;
  readonly executionId: string;
  readonly updatedVersions: Record<string, number>;
  readonly errors?: CommitError[];
}

export interface CommitError {
  readonly type: 'version_conflict' | 'constraint_violation' | 'validation_error';
  readonly resource: string;
  readonly details: unknown;
}

export interface StateStore {
  claimEvent(event: VerifiedEvent): Promise<EventClaim>;
  loadSnapshot(scope: CommandScope): Promise<StateSnapshot>;
  commit(plan: CommandCommit): Promise<CommitOutcome>;
}

export interface VerifiedEvent {
  readonly botId: string;
  readonly scene: SceneType;
  readonly externalId: string;
  readonly messageId: string;
  readonly timestamp: Date;
  readonly text?: string;
  readonly sender: Principal;
  readonly rawBody: Uint8Array;
}

export type SceneType = 'groupAt' | 'c2c' | 'groupAll';

export interface Principal {
  readonly scene: SceneType;
  readonly scopeId: string;
  readonly externalId: string;
}
