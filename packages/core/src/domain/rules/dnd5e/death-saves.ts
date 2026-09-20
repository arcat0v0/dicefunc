export type DeathSaveOutcome = 'success' | 'failure' | 'revive' | 'criticalFailure';

export interface DeathSaveCheckResult {
  readonly d20: number;
  readonly outcome: DeathSaveOutcome;
  readonly successPlus: number;
  readonly failurePlus: number;
}

export interface DeathSaveState {
  readonly successes: number;
  readonly failures: number;
}

export function applyDeathSaveModifiers(
  state: DeathSaveState,
  successPlus: number,
  failurePlus: number,
): DeathSaveState {
  return {
    successes: Math.max(0, state.successes + successPlus),
    failures: Math.max(0, state.failures + failurePlus),
  };
}

export function deathSaveResultText(state: DeathSaveState): {
  readonly stable: boolean;
  readonly dead: boolean;
} {
  return {
    stable: state.successes >= 3,
    dead: state.failures >= 3,
  };
}

export function decideDeathSave(d20: number): DeathSaveCheckResult {
  if (d20 === 20) {
    return { d20, outcome: 'revive', successPlus: 0, failurePlus: 0 };
  }
  if (d20 === 1) {
    return { d20, outcome: 'criticalFailure', successPlus: 0, failurePlus: 2 };
  }
  if (d20 >= 10) {
    return { d20, outcome: 'success', successPlus: 1, failurePlus: 0 };
  }
  return { d20, outcome: 'failure', successPlus: 0, failurePlus: 1 };
}
