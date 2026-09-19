export interface Combatant {
  readonly id: string;
  readonly name: string;
  readonly initiative: number;
  readonly isNpc?: boolean | undefined;
}

export interface CombatEncounterState {
  readonly id: string;
  readonly conversationId: string;
  readonly round: number;
  readonly turnIndex: number;
  readonly combatants: readonly Combatant[];
  readonly version: number;
}

export function createCombatEncounter(input: {
  readonly id: string;
  readonly conversationId: string;
  readonly version?: number | undefined;
}): CombatEncounterState {
  return {
    id: input.id,
    conversationId: input.conversationId,
    round: 1,
    turnIndex: 0,
    combatants: [],
    version: input.version ?? 1,
  };
}

export function addCombatant(
  encounter: CombatEncounterState,
  combatant: Combatant,
): CombatEncounterState {
  const filtered = encounter.combatants.filter((c) => c.id !== combatant.id);
  const updated = [...filtered, combatant].sort((a, b) => b.initiative - a.initiative);
  return {
    ...encounter,
    combatants: updated,
    version: encounter.version + 1,
  };
}

export function removeCombatant(
  encounter: CombatEncounterState,
  combatantId: string,
): CombatEncounterState {
  const updated = encounter.combatants.filter((c) => c.id !== combatantId);
  const nextTurnIndex =
    encounter.turnIndex >= updated.length ? Math.max(0, updated.length - 1) : encounter.turnIndex;
  return {
    ...encounter,
    combatants: updated,
    turnIndex: nextTurnIndex,
    version: encounter.version + 1,
  };
}

export function advanceTurn(encounter: CombatEncounterState): {
  readonly encounter: CombatEncounterState;
  readonly currentCombatant: Combatant | undefined;
  readonly roundAdvanced: boolean;
} {
  if (encounter.combatants.length === 0) {
    return {
      encounter,
      currentCombatant: undefined,
      roundAdvanced: false,
    };
  }

  const nextIndex = encounter.turnIndex + 1;
  let nextRound = encounter.round;
  let resolvedIndex = nextIndex;
  let roundAdvanced = false;

  if (nextIndex >= encounter.combatants.length) {
    nextRound += 1;
    resolvedIndex = 0;
    roundAdvanced = true;
  }

  const nextEncounter: CombatEncounterState = {
    ...encounter,
    round: nextRound,
    turnIndex: resolvedIndex,
    version: encounter.version + 1,
  };

  return {
    encounter: nextEncounter,
    currentCombatant: nextEncounter.combatants[resolvedIndex],
    roundAdvanced,
  };
}

export function resetEncounter(encounter: CombatEncounterState): CombatEncounterState {
  return {
    id: encounter.id,
    conversationId: encounter.conversationId,
    round: 1,
    turnIndex: 0,
    combatants: [],
    version: encounter.version + 1,
  };
}
