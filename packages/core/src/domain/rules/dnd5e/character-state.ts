export interface DndHpState {
  readonly maxHp: number;
  readonly currentHp: number;
  readonly tempHp: number;
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
} {
  const actualDamage = Math.max(0, damage);
  const tempHpAbsorbed = Math.min(state.tempHp, actualDamage);
  const remainingDamage = actualDamage - tempHpAbsorbed;
  const nextTempHp = state.tempHp - tempHpAbsorbed;
  const nextCurrentHp = Math.max(0, state.currentHp - remainingDamage);

  return {
    nextState: {
      maxHp: state.maxHp,
      currentHp: nextCurrentHp,
      tempHp: nextTempHp,
    },
    effectiveDamage: remainingDamage,
    tempHpAbsorbed,
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

  return {
    nextState: {
      maxHp: state.maxHp,
      currentHp: nextCurrentHp,
      tempHp: state.tempHp,
    },
    effectiveHealing,
  };
}

export function setTempHp(state: DndHpState, tempHp: number): DndHpState {
  return {
    maxHp: state.maxHp,
    currentHp: state.currentHp,
    tempHp: Math.max(state.tempHp, Math.max(0, tempHp)),
  };
}

export function setMaxHp(state: DndHpState, maxHp: number): DndHpState {
  const nextMaxHp = Math.max(1, maxHp);
  return {
    maxHp: nextMaxHp,
    currentHp: Math.min(nextMaxHp, state.currentHp),
    tempHp: state.tempHp,
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
    },
    nextSlots: restoreSpellSlots(slots),
  };
}
