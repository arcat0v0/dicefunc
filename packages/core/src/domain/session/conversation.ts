export interface ConversationSettings {
  ruleSet: RuleSetName;
  diceSides: number;
  timezone: string;
  enabled: boolean;
  settingsOverride?: Record<string, unknown>;
}

export type RuleSetName = 'coc7' | 'dnd5e' | 'other';

export interface ConversationSession {
  readonly id: string;
  readonly botId: string;
  readonly scene: SceneType;
  readonly externalId: string;
  readonly ruleSet: RuleSetName;
  readonly diceSides: number;
  readonly enabled: boolean;
  readonly settings: ConversationSettings;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type SceneType = 'groupAt' | 'c2c' | 'groupAll';

export interface ConversationSnapshot {
  session: ConversationSession;
  characterBinding?: CharacterBinding;
}

export interface CharacterBinding {
  readonly principalId: string;
  readonly sheetId: string;
  readonly version: number;
}
