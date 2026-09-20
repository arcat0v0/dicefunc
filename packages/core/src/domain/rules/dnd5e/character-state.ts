export interface DndHpState {
  readonly maxHp: number;
  readonly currentHp: number;
  readonly tempHp: number;
  readonly deathSaveSuccesses?: number | undefined;
  readonly deathSaveFailures?: number | undefined;
}

export interface SpellSlotLevel {
  readonly level: number;
  readonly total: number;
  readonly used: number;
}

export type DndSpellSlots = Readonly<Record<number, SpellSlotLevel>>;

export function applyDamage(
  state: DndHpState,
  damage: number,
): {
  readonly nextState: DndHpState;
  readonly effectiveDamage: number;
  readonly tempHpAbsorbed: number;
  readonly deathSaveFailureAdded: number;
  readonly massiveDamage: boolean;
} {
  const actualDamage = Math.max(0, damage);
  const tempHpAbsorbed = Math.min(state.tempHp, actualDamage);
  const remainingDamage = actualDamage - tempHpAbsorbed;
  const nextTempHp = state.tempHp - tempHpAbsorbed;
  const nextCurrentHp = Math.max(0, state.currentHp - remainingDamage);
  const deathSaveFailureAdded = state.currentHp === 0 && remainingDamage > 0 ? 1 : 0;
  const massiveDamage = state.currentHp > 0 && remainingDamage - state.currentHp >= state.maxHp;

  return {
    nextState: {
      maxHp: state.maxHp,
      currentHp: nextCurrentHp,
      tempHp: nextTempHp,
      deathSaveSuccesses: state.deathSaveSuccesses ?? 0,
      deathSaveFailures: (state.deathSaveFailures ?? 0) + deathSaveFailureAdded,
    },
    effectiveDamage: remainingDamage,
    tempHpAbsorbed,
    deathSaveFailureAdded,
    massiveDamage,
  };
}

export function applyHealing(
  state: DndHpState,
  healing: number,
): {
  readonly nextState: DndHpState;
  readonly effectiveHealing: number;
} {
  const actualHealing = Math.max(0, healing);
  const nextCurrentHp = Math.min(state.maxHp, state.currentHp + actualHealing);
  const effectiveHealing = nextCurrentHp - state.currentHp;
  const recovered = nextCurrentHp > 0;

  return {
    nextState: {
      maxHp: state.maxHp,
      currentHp: nextCurrentHp,
      tempHp: state.tempHp,
      deathSaveSuccesses: recovered ? 0 : (state.deathSaveSuccesses ?? 0),
      deathSaveFailures: recovered ? 0 : (state.deathSaveFailures ?? 0),
    },
    effectiveHealing,
  };
}

export function setTempHp(state: DndHpState, tempHp: number): DndHpState {
  return {
    maxHp: state.maxHp,
    currentHp: state.currentHp,
    tempHp: Math.max(state.tempHp, Math.max(0, tempHp)),
    deathSaveSuccesses: state.deathSaveSuccesses ?? 0,
    deathSaveFailures: state.deathSaveFailures ?? 0,
  };
}

export function setMaxHp(state: DndHpState, maxHp: number): DndHpState {
  const nextMaxHp = Math.max(1, maxHp);
  return {
    maxHp: nextMaxHp,
    currentHp: Math.min(nextMaxHp, state.currentHp),
    tempHp: state.tempHp,
    deathSaveSuccesses: state.deathSaveSuccesses ?? 0,
    deathSaveFailures: state.deathSaveFailures ?? 0,
  };
}

export function useSpellSlot(
  slots: DndSpellSlots,
  level: number,
  count = 1,
): {
  readonly nextSlots: DndSpellSlots;
  readonly success: boolean;
} {
  const slot = slots[level];
  if (!slot) {
    return { nextSlots: slots, success: false };
  }

  const remaining = slot.total - slot.used;
  if (remaining < count) {
    return { nextSlots: slots, success: false };
  }

  const updatedSlot: SpellSlotLevel = {
    level: slot.level,
    total: slot.total,
    used: slot.used + count,
  };

  return {
    nextSlots: {
      ...slots,
      [level]: updatedSlot,
    },
    success: true,
  };
}

export function restoreSpellSlots(slots: DndSpellSlots, level?: number): DndSpellSlots {
  if (level !== undefined) {
    const slot = slots[level];
    if (!slot) return slots;
    return {
      ...slots,
      [level]: {
        level: slot.level,
        total: slot.total,
        used: 0,
      },
    };
  }

  const updated: Record<number, SpellSlotLevel> = {};
  for (const [lvlStr, slot] of Object.entries(slots)) {
    const lvl = Number.parseInt(lvlStr, 10);
    updated[lvl] = {
      level: slot.level,
      total: slot.total,
      used: 0,
    };
  }
  return updated;
}

export function performLongRest(
  hp: DndHpState,
  slots: DndSpellSlots,
): {
  readonly nextHp: DndHpState;
  readonly nextSlots: DndSpellSlots;
} {
  return {
    nextHp: {
      maxHp: hp.maxHp,
      currentHp: hp.maxHp,
      tempHp: 0,
      deathSaveSuccesses: 0,
      deathSaveFailures: 0,
    },
    nextSlots: restoreSpellSlots(slots),
  };
}
