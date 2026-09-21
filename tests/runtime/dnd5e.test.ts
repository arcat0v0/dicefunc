import {
  type CombatEncounterState,
  type CommandContext,
  CommandExecutor,
  type ConversationSession,
  type DndHpState,
  type DndSpellSlots,
  type RandomSource,
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

  it('tracks zero-HP damage, massive damage, and healing resets in one state model', () => {
    const unconscious = applyDamage(
      {
        maxHp: 20,
        currentHp: 0,
        tempHp: 0,
        deathSaveSuccesses: 1,
        deathSaveFailures: 1,
      },
      4,
    );
    expect(unconscious.nextState).toMatchObject({
      currentHp: 0,
      deathSaveSuccesses: 1,
      deathSaveFailures: 2,
    });
    expect(unconscious.deathSaveFailureAdded).toBe(1);

    const massive = applyDamage({ maxHp: 10, currentHp: 5, tempHp: 0 }, 15);
    expect(massive.massiveDamage).toBe(true);

    const healed = applyHealing(
      {
        maxHp: 20,
        currentHp: 0,
        tempHp: 0,
        deathSaveSuccesses: 2,
        deathSaveFailures: 2,
      },
      3,
    );
    expect(healed.nextState).toMatchObject({
      currentHp: 3,
      deathSaveSuccesses: 0,
      deathSaveFailures: 0,
    });
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
  random: RandomSource = createWebCryptoRandomSource(),
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
    random,
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

function sequenceRandom(values: readonly number[]): RandomSource {
  let index = 0;
  return {
    async integer(minInclusive: number, maxInclusive: number): Promise<number> {
      const value = values[index];
      index += 1;
      if (value === undefined || value < minInclusive || value > maxInclusive) {
        throw new Error(
          `Invalid deterministic random value ${String(value)} for ${minInclusive}-${maxInclusive}`,
        );
      }
      return value;
    },
    async bytes(length: number): Promise<Uint8Array> {
      return new Uint8Array(length);
    },
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
  it('applies .st HP changes through the same death-save state model', async () => {
    const unconscious = createCharacterSheet({
      id: 'sheet_st_hp',
      ownerId: 'user_dnd_1',
      ruleSet: 'dnd5e',
      name: '倒地角色',
      attributes: { HP: 0, MaxHP: 20, TempHP: 0, DSS: 1, DSF: 1 },
    });
    const damaged = await executor.execute(
      createTestEvent('.st hp-1'),
      createTestDndContext({}, { sheet: unconscious }),
    );
    expect(damaged.updates[0]).toMatchObject({
      type: 'character-sheet',
      changes: {
        attributes: expect.objectContaining({ HP: 0, DSS: 1, DSF: 2 }),
      },
    });

    const healed = await executor.execute(
      createTestEvent('.st hp+3'),
      createTestDndContext({}, { sheet: unconscious }),
    );
    expect(healed.updates[0]).toMatchObject({
      type: 'character-sheet',
      changes: {
        attributes: expect.objectContaining({ HP: 3, DSS: 0, DSF: 0 }),
      },
    });
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

  it('stores proficiency factors and resolves calculated skills and saving throws', async () => {
    const baseSheet = createCharacterSheet({
      id: 'sheet_skills',
      ownerId: 'user_dnd_1',
      ruleSet: 'dnd5e',
      name: '战士',
      attributes: {},
    });
    const recorded = await executor.execute(
      createTestEvent('.st 力量:16 熟练:3 运动*:1 力量*:16'),
      createTestDndContext({}, { sheet: baseSheet }),
    );
    expect(recorded.updates[0]).toMatchObject({
      type: 'character-sheet',
      changes: {
        attributes: expect.objectContaining({
          力量: 16,
          熟练: 3,
          运动: 1,
          运动熟练: 1,
          力量豁免熟练: 1,
        }),
      },
    });

    const calculatedSheet = createCharacterSheet({
      id: 'sheet_skills',
      ownerId: 'user_dnd_1',
      ruleSet: 'dnd5e',
      name: '战士',
      attributes: {
        力量: 16,
        熟练: 3,
        运动: 1,
        运动熟练: 1,
        力量豁免熟练: 1,
      },
    });
    const skill = await executor.execute(
      createTestEvent('.ra 运动'),
      createTestDndContext({}, { sheet: calculatedSheet }, sequenceRandom([10])),
    );
    expect(skill.results[0]?.data).toMatchObject({
      skill: '运动',
      d20: 10,
      modifier: 7,
      total: 17,
    });

    const savingThrow = await executor.execute(
      createTestEvent('.rc 力量豁免'),
      createTestDndContext({}, { sheet: calculatedSheet }, sequenceRandom([10])),
    );
    expect(savingThrow.results[0]?.data).toMatchObject({
      skill: '力量豁免',
      modifier: 6,
      total: 16,
    });
  });

  it('supports DND advantage, expressions, repetition, reasons, and hidden checks', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_checks',
      ownerId: 'user_dnd_1',
      ruleSet: 'dnd5e',
      name: '游侠',
      attributes: {
        力量: 16,
        熟练: 3,
        运动: 1,
        运动熟练: 1,
      },
    });
    const advantage = await executor.execute(
      createTestEvent('.ra 优势 运动+1d4 15 撞门'),
      createTestDndContext({}, { sheet }, sequenceRandom([8, 17, 3])),
    );
    expect(advantage.results[0]?.data).toMatchObject({
      skill: '运动',
      advantage: 1,
      dc: 15,
      reason: '撞门',
      items: [
        {
          rolls: [8, 17],
          d20: 17,
          baseModifier: 7,
          extraModifier: 3,
          total: 27,
          success: true,
        },
      ],
    });
    expect(advantage.replies[0]?.text).toBe(
      '游侠进行「运动」检定：2D20(8,17)取17 + 7 + 3 = 27，DC 15，通过\n原因：撞门',
    );

    const repeated = await executor.execute(
      createTestEvent('.ra 2# 力量'),
      createTestDndContext({}, { sheet }, sequenceRandom([10, 11])),
    );
    expect(repeated.results[0]?.data).toMatchObject({
      repeat: 2,
      items: [
        { d20: 10, total: 13 },
        { d20: 11, total: 14 },
      ],
    });

    const hidden = await executor.execute(
      createTestEvent('.rah 力量'),
      createTestDndContext(
        {},
        {
          sheet,
          hiddenRollBinding: {
            id: 'binding_dnd_hidden',
            groupScopeId: 'group_dnd_1',
            groupPrincipalId: 'principal_group',
            c2cPrincipalId: 'principal_c2c',
            userOpenid: 'user_openid',
            activeMessagesEnabled: true,
            version: 1,
          },
        },
        sequenceRandom([12]),
      ),
    );
    expect(hidden.results[0]?.data).toMatchObject({ hidden: true });
    expect(hidden.replies[0]).toMatchObject({
      scene: 'c2c',
      targetId: 'user_openid',
      deliveryMode: 'active',
    });
  });

  it('applies temporary buffs to calculated checks and clears them', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_buffs',
      ownerId: 'user_dnd_1',
      ruleSet: 'dnd5e',
      name: '战士',
      attributes: { 力量: 16, 熟练: 3, 运动: 1 },
    });
    const applied = await executor.execute(
      createTestEvent('.buff 力量:2 运动*:1'),
      createTestDndContext({}, { sheet }),
    );
    expect(applied.updates[0]).toMatchObject({
      type: 'character-sheet',
      changes: {
        attributes: expect.objectContaining({
          Buff_力量: 2,
          Buff_运动: 1,
          Buff_运动熟练: 1,
        }),
      },
    });
    expect(applied.replies[0]?.text).toBe(
      ['「战士」的临时加值已更新：', '力量：2', '运动：1', '运动熟练：1'].join('\n'),
    );

    const buffedSheet = createCharacterSheet({
      id: 'sheet_buffs',
      ownerId: 'user_dnd_1',
      ruleSet: 'dnd5e',
      name: '战士',
      attributes: {
        力量: 16,
        熟练: 3,
        运动: 1,
        Buff_力量: 2,
        Buff_运动: 1,
        Buff_运动熟练: 1,
      },
    });
    const checked = await executor.execute(
      createTestEvent('.ra 运动'),
      createTestDndContext({}, { sheet: buffedSheet }, sequenceRandom([10])),
    );
    expect(checked.results[0]?.data).toMatchObject({ modifier: 9, total: 19 });

    const cleared = await executor.execute(
      createTestEvent('.buff clr'),
      createTestDndContext({}, { sheet: buffedSheet }),
    );
    expect(cleared.updates[0]).toMatchObject({
      changes: {
        attributes: expect.not.objectContaining({ Buff_力量: expect.any(Number) }),
      },
    });
    expect(cleared.replies[0]?.text).toBe(
      '「战士」的临时加值已更新：\n已移除：力量、运动、运动熟练',
    );
  });

  it('supports batch spell slots, casting, restoration, and clearing', async () => {
    const emptySheet = createCharacterSheet({
      id: 'sheet_slots',
      ownerId: 'user_dnd_1',
      ruleSet: 'dnd5e',
      name: '法师',
      attributes: { HP: 12, MaxHP: 20 },
    });
    const initialized = await executor.execute(
      createTestEvent('.ss init 4 3 2'),
      createTestDndContext({}, { sheet: emptySheet }),
    );
    expect(initialized.updates[0]).toMatchObject({
      changes: {
        attributes: expect.objectContaining({
          法术位_1: 4,
          法术位_2: 3,
          法术位_3: 2,
        }),
      },
    });
    expect(initialized.replies[0]?.text).toBe(
      '「法师」已初始化法术位：1环 4/4，2环 3/3，3环 2/2。',
    );

    const slotSheet = createCharacterSheet({
      id: 'sheet_slots',
      ownerId: 'user_dnd_1',
      ruleSet: 'dnd5e',
      name: '法师',
      attributes: {
        HP: 12,
        MaxHP: 20,
        法术位_1: 4,
        法术位_1_已用: 2,
        法术位_2: 3,
        法术位_2_已用: 0,
        DSS: 2,
        DSF: 1,
      },
    });
    const cast = await executor.execute(
      createTestEvent('.cast 2 2'),
      createTestDndContext({}, { sheet: slotSheet }),
    );
    expect(cast.updates[0]).toMatchObject({
      changes: {
        attributes: expect.objectContaining({ 法术位_2_已用: 2 }),
      },
    });

    const restored = await executor.execute(
      createTestEvent('.ss rest'),
      createTestDndContext({}, { sheet: slotSheet }),
    );
    expect(restored.updates[0]).toMatchObject({
      changes: {
        attributes: expect.objectContaining({ 法术位_1_已用: 0, 法术位_2_已用: 0 }),
      },
    });
    expect(restored.replies[0]?.text).toBe('「法师」已恢复法术位：1环 4/4，2环 3/3。');

    const changed = await executor.execute(
      createTestEvent('.ss 1环-1'),
      createTestDndContext({}, { sheet: slotSheet }),
    );
    expect(changed.replies[0]?.text).toBe('「法师」的法术位已变更：1环 -1，剩余 1/4。');

    const rested = await executor.execute(
      createTestEvent('.长休'),
      createTestDndContext({}, { sheet: slotSheet }),
    );
    expect(rested.updates[0]).toMatchObject({
      changes: {
        attributes: expect.objectContaining({ HP: 20, TempHP: 0, DSS: 0, DSF: 0 }),
      },
    });

    const cleared = await executor.execute(
      createTestEvent('.ss clr'),
      createTestDndContext({}, { sheet: slotSheet }),
    );
    if (cleared.updates[0]?.type === 'character-sheet') {
      expect(cleared.updates[0].changes.attributes).not.toHaveProperty('法术位_1');
      expect(cleared.updates[0].changes.attributes).not.toHaveProperty('法术位_2');
    }
  });

  it('applies dice modifiers to death saves', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_death_save',
      ownerId: 'user_dnd_1',
      ruleSet: 'dnd5e',
      name: '倒地角色',
      attributes: { HP: 0, MaxHP: 20, DSS: 0, DSF: 0 },
    });
    const decision = await executor.execute(
      createTestEvent('.ds +1d4'),
      createTestDndContext({}, { sheet }, sequenceRandom([8, 3])),
    );

    expect(decision.results[0]?.data).toMatchObject({
      rawRoll: 8,
      modifier: 3,
      total: 11,
      outcome: 'success',
    });
    expect(decision.updates[0]).toMatchObject({
      changes: {
        attributes: expect.objectContaining({ DSS: 1, DSF: 0 }),
      },
    });
  });

  it('applies HP dice expressions and persists death-save invariants', async () => {
    const unconscious = createCharacterSheet({
      id: 'sheet_hp_invariants',
      ownerId: 'user_dnd_1',
      ruleSet: 'dnd5e',
      name: '倒地角色',
      attributes: { HP: 0, MaxHP: 20, TempHP: 0, DSS: 1, DSF: 1 },
    });
    const damaged = await executor.execute(
      createTestEvent('.hp -1d4'),
      createTestDndContext({}, { sheet: unconscious }, sequenceRandom([4])),
    );
    expect(damaged.results[0]?.data).toMatchObject({
      damage: 4,
      currentHp: 0,
      deathSaveFailures: 2,
      deathSaveFailureAdded: 1,
    });
    expect(damaged.updates[0]).toMatchObject({
      changes: {
        attributes: expect.objectContaining({ HP: 0, DSS: 1, DSF: 2 }),
      },
    });

    const healed = await executor.execute(
      createTestEvent('.hp +1d4'),
      createTestDndContext({}, { sheet: unconscious }, sequenceRandom([3])),
    );
    expect(healed.updates[0]).toMatchObject({
      changes: {
        attributes: expect.objectContaining({ HP: 3, DSS: 0, DSF: 0 }),
      },
    });
  });
});
