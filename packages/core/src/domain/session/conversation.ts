import type { SceneType } from '../../ports/state-store.js';

export interface ConversationSession {
  readonly id: string;
  readonly botId: string;
  readonly scene: SceneType;
  readonly externalId: string;
  readonly ruleSet: string;
  readonly diceSides: number;
  readonly enabled: boolean;
  readonly activeLogId?: string | undefined;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function createConversationSession(input: {
  readonly id: string;
  readonly botId: string;
  readonly scene: SceneType;
  readonly externalId: string;
  readonly ruleSet?: string | undefined;
  readonly diceSides?: number | undefined;
  readonly enabled?: boolean | undefined;
  readonly activeLogId?: string | undefined;
  readonly createdAt?: Date | undefined;
}): ConversationSession {
  const now = input.createdAt ?? new Date();
  const session: {
    id: string;
    botId: string;
    scene: SceneType;
    externalId: string;
    ruleSet: string;
    diceSides: number;
    enabled: boolean;
    activeLogId?: string | undefined;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  } = {
    id: input.id,
    botId: input.botId,
    scene: input.scene,
    externalId: input.externalId,
    ruleSet: input.ruleSet ?? 'coc7',
    diceSides: input.diceSides ?? 100,
    enabled: input.enabled ?? true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  if (input.activeLogId !== undefined) {
    session.activeLogId = input.activeLogId;
  }
  return session;
}

export function applyConversationSettings(
  session: ConversationSession,
  changes: {
    readonly ruleSet?: string | undefined;
    readonly diceSides?: number | undefined;
    readonly enabled?: boolean | undefined;
    readonly activeLogId?: string | undefined;
  },
  now: Date = new Date(),
): ConversationSession {
  const nextRuleSet = changes.ruleSet !== undefined ? changes.ruleSet : session.ruleSet;
  const nextDiceSides = changes.diceSides !== undefined ? changes.diceSides : session.diceSides;
  const nextEnabled = changes.enabled !== undefined ? changes.enabled : session.enabled;
  const nextActiveLogId =
    changes.activeLogId !== undefined ? changes.activeLogId : session.activeLogId;

  const updated: {
    id: string;
    botId: string;
    scene: SceneType;
    externalId: string;
    ruleSet: string;
    diceSides: number;
    enabled: boolean;
    activeLogId?: string | undefined;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  } = {
    id: session.id,
    botId: session.botId,
    scene: session.scene,
    externalId: session.externalId,
    ruleSet: nextRuleSet,
    diceSides: nextDiceSides,
    enabled: nextEnabled,
    version: session.version + 1,
    createdAt: session.createdAt,
    updatedAt: now,
  };
  if (nextActiveLogId !== undefined) {
    updated.activeLogId = nextActiveLogId;
  }
  return updated;
}
