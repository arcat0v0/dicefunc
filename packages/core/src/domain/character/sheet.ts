export interface CharacterSheet {
  readonly id: string;
  readonly ownerId: string;
  readonly ruleSet: string;
  readonly name: string;
  readonly attributes: Readonly<Record<string, number>>;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function createCharacterSheet(input: {
  readonly id: string;
  readonly ownerId: string;
  readonly ruleSet: string;
  readonly name: string;
  readonly attributes?: Record<string, number> | undefined;
  readonly createdAt?: Date | undefined;
}): CharacterSheet {
  const now = input.createdAt ?? new Date();
  return {
    id: input.id,
    ownerId: input.ownerId,
    ruleSet: input.ruleSet,
    name: input.name,
    attributes: Object.freeze({ ...(input.attributes ?? {}) }),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function applyAttributeChange(
  sheet: CharacterSheet,
  change: {
    readonly name?: string | undefined;
    readonly attributes?: Record<string, number> | undefined;
  },
  now: Date = new Date(),
): CharacterSheet {
  const nextAttributes =
    change.attributes !== undefined
      ? Object.freeze({ ...sheet.attributes, ...change.attributes })
      : sheet.attributes;
  const nextName = change.name !== undefined ? change.name : sheet.name;

  return {
    id: sheet.id,
    ownerId: sheet.ownerId,
    ruleSet: sheet.ruleSet,
    name: nextName,
    attributes: nextAttributes,
    version: sheet.version + 1,
    createdAt: sheet.createdAt,
    updatedAt: now,
  };
}
