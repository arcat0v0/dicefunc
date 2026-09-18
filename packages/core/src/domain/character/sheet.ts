export interface CharacterSheet {
  readonly id: string;
  readonly ownerId: string;
  readonly ruleSet: RuleSetName;
  readonly name: string;
  readonly attributes: Record<string, AttributeValue>;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type AttributeValue = 
  | { type: 'number'; value: number }
  | { type: 'formula'; expression: string }
  | { type: 'string'; value: string };

export interface CharacterSnapshot {
  readonly sheetId: string;
  readonly snapshotId: string;
  readonly schemaVersion: number;
  readonly attributes: Record<string, AttributeValue>;
  readonly createdAt: Date;
}
