import {
  type CombatEncounterState,
  type CommandContext,
  CommandExecutor,
  type ConversationSession,
  type DndHpState,
  type DndSpellSlots,
  type StateSnapshot,
  type VerifiedEvent,
  addCombatant,
  advanceTurn,
  applyDamage,
  applyHealing,
  createCharacterSheet,
  createCombatEncounter,
  createConversationSession,
  createWebCryptoRandomSource,
  performLongRest,
  removeCombatant,
  resetEncounter,
  restoreSpellSlots,
  setTempHp,
  systemClock,
  useSpellSlot,
} from '@dicefunc/core';
import { describe, expect, it } from 'vitest';

describe('DND5e Combat Encounter domain', () => {
  it('creates encounter with round 1 and empty combatants', () => {
    const enc = createCombatEncounter({
      id: 'enc_1',
      conversationId: 'conv_1',
    });
    expect(enc.round).toBe(1);
    expect(enc.turnIndex).toBe(0);
    expect(enc.combatants).toHaveLength(0);
  });

  it('adds combatants and keeps them sorted by initiative descending', () => {
    let enc = createCombatEncounter({ id: 'enc_1', conversationId: 'conv_1' });
    enc = addCombatant(enc, { id: 'c1', name: '战士', initiative: 12 });
    enc = addCombatant(enc, { id: 'c2', name: '法师', initiative: 18 });
    enc = addCombatant(enc, { id: 'c3', name: '地精', initiative: 8 });

    expect(enc.combatants).toHaveLength(3);
    expect(enc.combatants[0]?.name).toBe('法师');
    expect(enc.combatants[1]?.name).toBe('战士');
    expect(enc.combatants[2]?.name).toBe('地精');
  });

  it('advances turns and increments round on full cycle', () => {
    let enc = createCombatEncounter({ id: 'enc_1', conversationId: 'conv_1' });
    enc = addCombatant(enc, { id: 'c1', name: '法师', initiative: 18 });
    enc = addCombatant(enc, { id: 'c2', name: '战士', initiative: 12 });

    const turn1 = advanceTurn(enc);
    expect(turn1.currentCombatant?.name).toBe('战士');
    expect(turn1.roundAdvanced).toBe(false);

    const turn2 = advanceTurn(turn1.encounter);
    expect(turn2.currentCombatant?.name).toBe('法师');
    expect(turn2.roundAdvanced).toBe(true);
    expect(turn2.encounter.round).toBe(2);
  });

  it('removes combatant and resets encounter', () => {
    let enc = createCombatEncounter({ id: 'enc_1', conversationId: 'conv_1' });
    enc = addCombatant(enc, { id: 'c1', name: '法师', initiative: 18 });
    enc = addCombatant(enc, { id: 'c2', name: '战士', initiative: 12 });
    enc = removeCombatant(enc, 'c1');

    expect(enc.combatants).toHaveLength(1);
    expect(enc.combatants[0]?.name).toBe('战士');

    enc = resetEncounter(enc);
    expect(enc.combatants).toHaveLength(0);
    expect(enc.round).toBe(1);
  });
});

describe('DND5e Character State domain', () => {
  it('absorbs damage using temporary HP before reducing current HP', () => {
    const hp: DndHpState = { maxHp: 30, currentHp: 30, tempHp: 8 };
    const { nextState, effectiveDamage, tempHpAbsorbed } = applyDamage(hp, 10);

    expect(tempHpAbsorbed).toBe(8);
    expect(effectiveDamage).toBe(2);
    expect(nextState.tempHp).toBe(0);
    expect(nextState.currentHp).toBe(28);
  });

  it('heals current HP up to maxHp and does not exceed it', () => {
    const hp: DndHpState = { maxHp: 30, currentHp: 25, tempHp: 0 };
    const { nextState, effectiveHealing } = applyHealing(hp, 10);

    expect(effectiveHealing).toBe(5);
    expect(nextState.currentHp).toBe(30);
  });

  it('does not stack temporary HP, taking the higher value', () => {
    const hp: DndHpState = { maxHp: 30, currentHp: 30, tempHp: 5 };
    const state1 = setTempHp(hp, 4);
    expect(state1.tempHp).toBe(5);

    const state2 = setTempHp(hp, 8);
    expect(state2.tempHp).toBe(8);
  });

  it('tracks, consumes, and restores spell slots', () => {
    const slots: DndSpellSlots = {
      1: { level: 1, total: 4, used: 2 },
      2: { level: 2, total: 2, used: 0 },
    };

    const use1 = useSpellSlot(slots, 1, 1);
    expect(use1.success).toBe(true);
    expect(use1.nextSlots[1]?.used).toBe(3);

    const useFail = useSpellSlot(use1.nextSlots, 1, 2);
    expect(useFail.success).toBe(false);

    const restoredLvl1 = restoreSpellSlots(use1.nextSlots, 1);
    expect(restoredLvl1[1]?.used).toBe(0);
  });

  it('performs long rest restoring HP, removing temp HP, and resetting spell slots', () => {
    const hp: DndHpState = { maxHp: 40, currentHp: 15, tempHp: 6 };
    const slots: DndSpellSlots = {
      1: { level: 1, total: 4, used: 4 },
      2: { level: 2, total: 3, used: 2 },
    };

    const { nextHp, nextSlots } = performLongRest(hp, slots);
    expect(nextHp.currentHp).toBe(40);
    expect(nextHp.tempHp).toBe(0);
    expect(nextSlots[1]?.used).toBe(0);
    expect(nextSlots[2]?.used).toBe(0);
  });
});

function createTestDndContext(
  conversationOverrides: Partial<ConversationSession> = {},
  snapshotOverrides: Partial<StateSnapshot> = {},
): CommandContext {
  const baseConversation = createConversationSession({
    id: 'conv_dnd_1',
    botId: 'bot_test_1',
    scene: 'groupAt',
    externalId: 'group_dnd_1',
    ruleSet: 'dnd5e',
    diceSides: 20,
    enabled: true,
    receiveSeq: 1,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const conversation = {
    ...baseConversation,
    ...conversationOverrides,
  };

  const snapshot: StateSnapshot = {
    conversation,
    policyEntries: [],
    permissions: {
      isGroupHost: true,
      isDiceMaster: true,
      denied: false,
      isTrusted: true,
    },
    ...snapshotOverrides,
  };

  return {
    snapshot,
    random: createWebCryptoRandomSource(),
    clock: systemClock,
    permissions: snapshot.permissions,
    budget: {
      maxDiceRolls: 100,
      maxRecursionDepth: 10,
      maxOutputBytes: 4096,
      consumed: {
        diceRolls: 0,
        recursionDepth: 0,
        outputBytes: 0,
      },
    },
    configVersion: '1.0.0',
    botId: 'bot_test_1',
  };
}

function createTestEvent(text: string): VerifiedEvent {
  return {
    botId: 'bot_test_1',
    scene: 'groupAt',
    eventId: 'evt_dnd_1',
    messageId: 'msg_dnd_1',
    externalId: 'group_dnd_1',
    timestamp: new Date(),
    text,
    sender: {
      scene: 'groupAt',
      scopeId: 'group_dnd_1',
      externalId: 'user_dnd_1',
    },
  };
}

describe('DND5e Commands (.init, .hp, .ss, .longrest)', () => {
  const executor = new CommandExecutor();

  it('rolls initiative and adds to encounter on .ri', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_hero',
      ownerId: 'user_dnd_1',
      ruleSet: 'dnd5e',
      name: '瓦里斯',
      attributes: { 敏捷: 14 },
    });
    const ctx = createTestDndContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.ri'), ctx);

    expect(decision.updates).toHaveLength(1);
    const encUpdate = decision.updates[0];
    expect(encUpdate?.type).toBe('encounter');
    expect(decision.replies[0]?.text).toContain('先攻');
    expect(decision.replies[0]?.text).toContain('瓦里斯');
  });

  it('advances combat turn on .init next', async () => {
    const enc: CombatEncounterState = {
      id: 'enc_test',
      conversationId: 'conv_dnd_1',
      round: 1,
      turnIndex: 0,
      combatants: [
        { id: 'c1', name: '战士', initiative: 18 },
        { id: 'c2', name: '法师', initiative: 12 },
      ],
      version: 1,
    };
    const ctx = createTestDndContext({}, { encounter: enc });
    const decision = await executor.execute(createTestEvent('.init next'), ctx);

    expect(decision.updates).toHaveLength(1);
    const encUpdate = decision.updates[0];
    expect(encUpdate?.type).toBe('encounter');
    expect(decision.replies[0]?.text).toContain('当前回合');
    expect(decision.replies[0]?.text).toContain('法师');

    if (encUpdate?.type === 'encounter') {
      const nextEncState = encUpdate.changes.state as CombatEncounterState;
      const ctx2 = createTestDndContext({}, { encounter: nextEncState });
      const decision2 = await executor.execute(createTestEvent('.init next'), ctx2);
      expect(decision2.replies[0]?.text).toContain('下一轮/回合');
      expect(decision2.replies[0]?.text).toContain('战士');
    }
  });

  it('manages HP with damage, healing, and temp HP on .hp', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_hero',
      ownerId: 'user_dnd_1',
      ruleSet: 'dnd5e',
      name: '瓦里斯',
      attributes: { HP: 20, MaxHP: 20, TempHP: 5 },
    });
    const ctx = createTestDndContext({}, { sheet });

    const damageDecision = await executor.execute(createTestEvent('.hp -8'), ctx);
    expect(damageDecision.updates).toHaveLength(1);
    const sheetUpdate = damageDecision.updates[0];
    expect(sheetUpdate?.type).toBe('character-sheet');
    if (sheetUpdate?.type === 'character-sheet') {
      expect(sheetUpdate.changes.attributes?.HP).toBe(17);
      expect(sheetUpdate.changes.attributes?.TempHP).toBe(0);
    }
    expect(damageDecision.replies[0]?.text).toContain('HP: 17/20');

    const healDecision = await executor.execute(createTestEvent('.hp +5'), ctx);
    expect(healDecision.updates).toHaveLength(1);
  });

  it('consumes spell slots on .ss use and restores on .longrest', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_hero',
      ownerId: 'user_dnd_1',
      ruleSet: 'dnd5e',
      name: '瓦里斯',
      attributes: { HP: 15, MaxHP: 25, 法术位_1: 4, 法术位_1_已用: 1 },
    });
    const ctx = createTestDndContext({}, { sheet });

    const useDecision = await executor.execute(createTestEvent('.ss use 1'), ctx);
    expect(useDecision.updates).toHaveLength(1);
    const sheetUpdate = useDecision.updates[0];
    if (sheetUpdate?.type === 'character-sheet') {
      expect(sheetUpdate.changes.attributes?.法术位_1_已用).toBe(2);
    }

    const restDecision = await executor.execute(createTestEvent('.longrest'), ctx);
    expect(restDecision.updates).toHaveLength(1);
    const restUpdate = restDecision.updates[0];
    if (restUpdate?.type === 'character-sheet') {
      expect(restUpdate.changes.attributes?.HP).toBe(25);
      expect(restUpdate.changes.attributes?.法术位_1_已用).toBe(0);
    }
  });
});
