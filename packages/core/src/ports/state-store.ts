import type { CharacterSheet } from '../domain/character/sheet.js';
import type { PolicyEntry } from '../domain/policy/policy.js';
import type { ConversationSession } from '../domain/session/conversation.js';

export type SceneType = 'groupAt' | 'groupAll' | 'c2c';

export interface Principal {
  readonly scene: SceneType;
  readonly scopeId: string;
  readonly externalId: string;
  readonly name?: string | undefined;
}

export interface VerifiedEvent {
  readonly botId: string;
  readonly scene: SceneType;
  readonly eventId: string;
  readonly messageId: string;
  readonly externalId: string;
  readonly timestamp: Date;
  readonly text: string;
  readonly sender: Principal;
}

export type StateUpdate =
  | {
      readonly type: 'conversation-settings';
      readonly conversationId: string;
      readonly expectedVersion: number;
      readonly changes: {
        readonly ruleSet?: string | undefined;
        readonly diceSides?: number | undefined;
        readonly enabled?: boolean | undefined;
      };
      readonly newVersion: number;
    }
  | {
      readonly type: 'character-sheet';
      readonly sheetId: string;
      readonly expectedVersion: number;
      readonly changes: {
        readonly name?: string | undefined;
        readonly attributes?: Record<string, number> | undefined;
        readonly ownerPrincipal?: string | undefined;
        readonly ruleSet?: string | undefined;
      };
      readonly newVersion: number;
    }
  | {
      readonly type: 'character-binding';
      readonly conversationId: string;
      readonly principalId: string;
      readonly expectedVersion: number;
      readonly changes: {
        readonly sheetId: string | null;
      };
      readonly newVersion: number;
    }
  | {
      readonly type: 'policy-entry';
      readonly entryId: string;
      readonly expectedVersion: number;
      readonly changes: {
        readonly effect: 'deny' | 'trust';
        readonly reason?: string | undefined;
      };
      readonly newVersion: number;
    }
  | {
      readonly type: 'deck-session';
      readonly sessionId: string;
      readonly expectedVersion: number;
      readonly changes: {
        readonly remaining: unknown[];
        readonly drawnCount: number;
      };
      readonly newVersion: number;
    }
  | {
      readonly type: 'story-log';
      readonly logId: string;
      readonly conversationId?: string | undefined;
      readonly expectedVersion: number;
      readonly changes: {
        readonly name?: string | undefined;
        readonly status: 'new' | 'recording' | 'paused' | 'closed';
      };
      readonly newVersion: number;
    }
  | {
      readonly type: 'encounter';
      readonly encounterId: string;
      readonly conversationId: string;
      readonly expectedVersion: number;
      readonly changes: {
        readonly state: unknown;
      };
      readonly newVersion: number;
    };

export interface CommandResult {
  readonly executionId: string;
  readonly kind: string;
  readonly ruleVersion: string;
  readonly data: Record<string, unknown>;
}

export interface PreparedReply {
  readonly executionId: string;
  readonly part: number;
  readonly msgSeq: number;
  readonly scene: SceneType;
  readonly targetId: string;
  readonly originMessageId: string;
  readonly templateKey: string;
  readonly variantId?: string | undefined;
  readonly text: string;
  readonly deadline: Date;
}

export interface InboundLogItem {
  readonly sourceId: string;
  readonly seq: number;
  readonly direction: 'inbound' | 'outbound';
  readonly text: string;
  readonly deliveryStatus: 'pending' | 'sending' | 'sent' | 'unknown' | 'failed' | 'expired';
}

export interface CommandCommit {
  readonly transactionId: string;
  readonly eventId: string;
  readonly executionId: string;
  readonly botId: string;
  readonly conversationId: string;
  readonly conversationSeq: number;
  readonly lease: {
    readonly token: string;
    readonly fencingToken: number;
  } | null;
  readonly updates: StateUpdate[];
  readonly results: CommandResult[];
  readonly replies: PreparedReply[];
  readonly logItems: InboundLogItem[];
  readonly completeEvent: boolean;
}

export interface EventClaim {
  readonly eventId: string;
  readonly messageKey: string;
  readonly conversationId: string;
  readonly conversationSeq: number;
  readonly seed: string;
  readonly jobId: string;
  readonly status: 'claimed' | 'processing' | 'completed' | 'failed';
  readonly alreadyProcessed: boolean;
}

export interface CommandScope {
  readonly botId: string;
  readonly scene: SceneType;
  readonly externalId: string;
  readonly principal: Principal;
}

export interface Permissions {
  readonly isDiceMaster: boolean;
  readonly isGroupHost: boolean;
  readonly isTrusted: boolean;
  readonly denied: boolean;
}

export interface StateSnapshot {
  readonly principalId?: string | undefined;
  readonly conversation: ConversationSession;
  readonly characterBinding?:
    | {
        readonly sheetId: string | null;
        readonly version: number;
      }
    | undefined;
  readonly sheet?: CharacterSheet | undefined;
  readonly policyEntries: PolicyEntry[];
  readonly permissions: Permissions;
  readonly activeStoryLog?:
    | {
        readonly id: string;
        readonly name: string;
        readonly status: 'new' | 'recording' | 'paused' | 'closed';
        readonly version: number;
      }
    | undefined;
  readonly encounter?:
    | {
        readonly id: string;
        readonly conversationId: string;
        readonly state: unknown;
        readonly version: number;
      }
    | undefined;
  readonly deckSessions?:
    | Readonly<
        Record<
          string,
          {
            readonly id: string;
            readonly remaining: readonly unknown[];
            readonly drawnCount: number;
            readonly version: number;
          }
        >
      >
    | undefined;
}

export interface CommitOutcome {
  readonly success: boolean;
  readonly executionId: string;
  readonly updatedVersions: Record<string, number>;
  readonly conflict: boolean;
  readonly errors: {
    readonly type: string;
    readonly resource: string;
    readonly details?: string | undefined;
  }[];
}

export interface StoredJob {
  readonly jobId: string;
  readonly type: 'command' | 'archive-chunk';
  readonly resourceId: string;
  readonly status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead';
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: Date;
  readonly deadline: Date;
  readonly fencingToken: number;
}

export interface JobLease {
  readonly job: StoredJob;
  readonly leaseToken: string;
  readonly fencingToken: number;
}

export interface StateStore {
  claimEvent(event: VerifiedEvent, configDigest: string): Promise<EventClaim>;
  loadSnapshot(scope: CommandScope): Promise<StateSnapshot>;
  commit(plan: CommandCommit): Promise<CommitOutcome>;
  getJob(botId: string, jobId: string): Promise<StoredJob | null>;
  acquireJob(botId: string, jobId: string, leaseSeconds: number): Promise<JobLease | null>;
  completeJob(
    botId: string,
    jobId: string,
    fencingToken: number,
    status: 'completed' | 'failed' | 'dead',
    errorCode?: string,
  ): Promise<boolean>;
  listRecoverableJobs(botId: string, limit: number): Promise<StoredJob[]>;
  purgeExpiredData(
    botId: string,
    retention: {
      readonly resultDays: number;
      readonly dedupDays: number;
      readonly auditDays: number;
    },
  ): Promise<{
    results: number;
    events: number;
    audits: number;
  }>;
}
