import {
  CommandConflictError,
  type CommandContext,
  type CommandDecision,
  CommandExecutor,
  type ConversationSession,
  DefaultCommandRegistry,
  type HiddenRollLinkReader,
  type RandomSource,
  type StateSnapshot,
  type VerifiedEvent,
  addCombatant,
  createCharacterSheet,
  createCombatEncounter,
  createConversationSession,
  createDefaultCommandRegistry,
  createWebCryptoRandomSource,
  systemClock,
} from '@dicefunc/core';
import { describe, expect, it } from 'vitest';

function createTestContext(
  conversationOverrides: Partial<ConversationSession> = {},
  snapshotOverrides: Partial<StateSnapshot> = {},
  hiddenRollLinks?: HiddenRollLinkReader,
  random: RandomSource = createWebCryptoRandomSource(),
): CommandContext {
  const baseConversation = createConversationSession({
    id: 'conv_test_1',
    botId: 'bot_test_1',
    scene: 'groupAt',
    externalId: 'group_ext_1',
    ruleSet: 'coc7',
    diceSides: 100,
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
    ...(hiddenRollLinks ? { hiddenRollLinks } : {}),
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
    eventId: 'evt_1',
    messageId: 'msg_1',
    externalId: 'group_ext_1',
    timestamp: new Date(),
    text,
    sender: {
      scene: 'groupAt',
      scopeId: 'group_ext_1',
      externalId: 'user_ext_1',
    },
  };
}

function createC2cTestEvent(text: string): VerifiedEvent {
  return {
    ...createTestEvent(text),
    scene: 'c2c',
    externalId: 'user_ext_1',
    sender: {
      scene: 'c2c',
      scopeId: 'user_ext_1',
      externalId: 'user_ext_1',
    },
  };
}

const dummyHandler = async (): Promise<CommandDecision> => ({
  results: [],
  updates: [],
  replies: [],
  logItems: [],
});

describe('CommandRegistry conflict detection', () => {
  it('throws CommandConflictError when registering duplicate command names', () => {
    const registry = new DefaultCommandRegistry();
    registry.register({ name: 'ping', permission: 'all' }, dummyHandler);

    expect(() => registry.register({ name: 'ping', permission: 'all' }, dummyHandler)).toThrow(
      CommandConflictError,
    );

    expect(() => registry.register({ name: 'PING', permission: 'all' }, dummyHandler)).toThrow(
      CommandConflictError,
    );
  });

  it('throws CommandConflictError on alias collision with existing command or alias', () => {
    const registry = new DefaultCommandRegistry();
    registry.register({ name: 'roll', aliases: ['r', 'dice'], permission: 'all' }, dummyHandler);

    expect(() => registry.register({ name: 'r', permission: 'all' }, dummyHandler)).toThrow(
      CommandConflictError,
    );

    expect(() =>
      registry.register({ name: 'random', aliases: ['dice'], permission: 'all' }, dummyHandler),
    ).toThrow(CommandConflictError);
  });

  it('throws CommandConflictError when a command specifies duplicate aliases', () => {
    const registry = new DefaultCommandRegistry();
    expect(() =>
      registry.register(
        { name: 'custom', aliases: ['dup', 'dup'], permission: 'all' },
        dummyHandler,
      ),
    ).toThrow(CommandConflictError);
  });
});

describe('Conversation settings updates with set and bot commands', () => {
  const executor = new CommandExecutor();

  it('produces typed conversation-settings update for .set rule', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.set rule dnd5e'), ctx);

    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('conversation-settings');
    if (update?.type === 'conversation-settings') {
      expect(update.changes.ruleSet).toBe('dnd5e');
      expect(update.newVersion).toBe(ctx.snapshot.conversation.version + 1);
    }
  });

  it('produces typed conversation-settings update for .set sides', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.set sides 20'), ctx);

    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('conversation-settings');
    if (update?.type === 'conversation-settings') {
      expect(update.changes.diceSides).toBe(20);
      expect(update.newVersion).toBe(ctx.snapshot.conversation.version + 1);
    }
  });

  it('produces typed conversation-settings update for .bot on and .bot off', async () => {
    const ctx = createTestContext();

    const decisionOff = await executor.execute(createTestEvent('.bot off'), ctx);
    expect(decisionOff.updates).toHaveLength(1);
    const updateOff = decisionOff.updates[0];
    expect(updateOff?.type).toBe('conversation-settings');
    if (updateOff?.type === 'conversation-settings') {
      expect(updateOff.changes.enabled).toBe(false);
      expect(updateOff.newVersion).toBe(ctx.snapshot.conversation.version + 1);
    }

    const decisionOn = await executor.execute(createTestEvent('.bot on'), ctx);
    expect(decisionOn.updates).toHaveLength(1);
    const updateOn = decisionOn.updates[0];
    expect(updateOn?.type).toBe('conversation-settings');
    if (updateOn?.type === 'conversation-settings') {
      expect(updateOn.changes.enabled).toBe(true);
      expect(updateOn.newVersion).toBe(ctx.snapshot.conversation.version + 1);
    }
  });

  it('rejects .bot and .set when user lacks groupHost permission', async () => {
    const nonHostCtx = createTestContext(
      {},
      {
        permissions: {
          isGroupHost: false,
          isDiceMaster: false,
          denied: false,
          isTrusted: false,
        },
      },
    );

    const botDecision = await executor.execute(createTestEvent('.bot off'), nonHostCtx);
    expect(botDecision.updates).toHaveLength(0);
    expect(botDecision.replies[0]?.text).toBe('This command requires Group Host permission.');

    const setDecision = await executor.execute(createTestEvent('.set sides 20'), nonHostCtx);
    expect(setDecision.updates).toHaveLength(0);
    expect(setDecision.replies[0]?.text).toBe('This command requires Group Host permission.');
  });
});

describe('Disabled conversation command execution', () => {
  const executor = new CommandExecutor();

  it('rejects non-whitelisted commands when enabled is false', async () => {
    const disabledCtx = createTestContext({ enabled: false });

    const rollDecision = await executor.execute(createTestEvent('.r 1d100'), disabledCtx);
    expect(rollDecision.results).toHaveLength(0);
    expect(rollDecision.replies).toHaveLength(0);
    expect(rollDecision.updates).toHaveLength(0);

    const useridDecision = await executor.execute(createTestEvent('.userid'), disabledCtx);
    expect(useridDecision.results).toHaveLength(0);
    expect(useridDecision.replies).toHaveLength(0);
  });

  it('executes whitelisted commands when enabled is false', async () => {
    const disabledCtx = createTestContext({ enabled: false });

    const helpDecision = await executor.execute(createTestEvent('.help'), disabledCtx);
    expect(helpDecision.replies).toHaveLength(1);
    expect(helpDecision.results).toHaveLength(1);

    const botOnDecision = await executor.execute(createTestEvent('.bot on'), disabledCtx);
    expect(botOnDecision.updates).toHaveLength(1);
    expect(botOnDecision.replies).toHaveLength(1);
  });
});

describe('Help and userid commands', () => {
  const executor = new CommandExecutor();

  it('publishes only implemented command families', async () => {
    const decision = await executor.execute(createTestEvent('.help'), createTestContext());

    expect(decision.results[0]?.kind).toBe('help');
    expect(decision.replies[0]?.text).toContain('DiceFunc');
    expect(decision.replies[0]?.text).toContain('.help 骰点');
    expect(decision.replies[0]?.text).toContain('.help COC7');
    expect(decision.replies[0]?.text).toContain('.help DND5E');
    expect(decision.replies[0]?.text).not.toContain('.ext');
    expect(decision.replies[0]?.text).not.toContain('reload');
  });

  it('uses the same overview for help aliases', async () => {
    const ctx = createTestContext();
    const direct = await executor.execute(createTestEvent('.help'), ctx);
    const chinese = await executor.execute(createTestEvent('.帮助'), ctx);
    const short = await executor.execute(createTestEvent('.h'), ctx);

    expect(chinese.replies[0]?.text).toBe(direct.replies[0]?.text);
    expect(short.replies[0]?.text).toBe(direct.replies[0]?.text);
  });

  it('documents actual syntax and does not claim fake reload support', async () => {
    const ctx = createTestContext();
    const checks = await executor.execute(createTestEvent('.help ra'), ctx);
    expect(checks.replies[0]?.text).toContain('.ra/rc');
    expect(checks.replies[0]?.text).not.toContain('.check');

    const initiative = await executor.execute(createTestEvent('.help init'), ctx);
    expect(initiative.replies[0]?.text).toContain('.init end');
    expect(initiative.replies[0]?.text).toContain('.init clr');

    const slots = await executor.execute(createTestEvent('.help ss'), ctx);
    expect(slots.replies[0]?.text).toContain('.ss set <环阶> <总数>');
    expect(slots.replies[0]?.text).not.toContain('.ss reset');

    const saves = await executor.execute(createTestEvent('.help ds'), ctx);
    expect(saves.replies[0]?.text).toContain('.ds stat');
    expect(saves.replies[0]?.text).not.toContain('.ds reset');

    const reload = await executor.execute(createTestEvent('.help reload'), ctx);
    expect(reload.replies[0]?.text).not.toContain('重新装载');
    expect(reload.replies[0]?.text).toContain('未找到');
  });

  it('groups implemented COC, DND, card, logging, and utility commands', async () => {
    const ctx = createTestContext();
    const coc = await executor.execute(createTestEvent('.help COC7'), ctx);
    expect(coc.replies[0]?.text).toContain('.ra');
    expect(coc.replies[0]?.text).toContain('.sc');
    expect(coc.replies[0]?.text).toContain('.en');

    const dnd = await executor.execute(createTestEvent('.help DND5E'), ctx);
    expect(dnd.replies[0]?.text).toContain('.init');
    expect(dnd.replies[0]?.text).toContain('.ss');
    expect(dnd.replies[0]?.text).toContain('.longrest');

    const cards = await executor.execute(createTestEvent('.help 角色卡'), ctx);
    expect(cards.replies[0]?.text).toContain('.st');
    expect(cards.replies[0]?.text).toContain('.pc');

    const log = await executor.execute(createTestEvent('.help log'), ctx);
    expect(log.replies[0]?.text).toContain('.log export');
  });

  it('searches the rule glossary for unknown help topics', async () => {
    const ctx = createTestContext();
    const glossary = await executor.execute(createTestEvent('.help 理智检定'), ctx);
    expect(glossary.replies[0]?.text).toContain('理智检定');

    const missing = await executor.execute(
      createTestEvent('.help 这是一个完全不存在的词条条目xyz123'),
      ctx,
    );
    expect(missing.replies[0]?.text).toContain('未找到');
  });

  it('provides user and conversation identifiers on userid', async () => {
    const decision = await executor.execute(createTestEvent('.userid'), createTestContext());

    expect(decision.results[0]?.kind).toBe('userid');
    expect(decision.replies[0]?.text).toContain('user_ext_1');
    expect(decision.replies[0]?.text).toContain('group_ext_1');
  });
});

describe('Character sheet attributes command (.st)', () => {
  const executor = new CommandExecutor();

  it('notifies when no character sheet is bound on .st show', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.st show'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('未绑定角色卡');
    expect(decision.updates).toHaveLength(0);
  });

  it('displays character attributes on .st show when sheet is bound', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_1',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '哈维',
      attributes: { 力量: 60, 敏捷: 70 },
    });
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.st show'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('哈维');
    expect(decision.replies[0]?.text).toContain('力量: 60');
    expect(decision.replies[0]?.text).toContain('敏捷: 70');
  });

  it('displays specific attributes on .st show <attr>', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_1',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '哈维',
      attributes: { 力量: 60, 敏捷: 70, 体质: 50 },
    });
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.st show 力量'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('力量: 60');
    expect(decision.replies[0]?.text).not.toContain('敏捷');
  });

  it('clears attributes on .st clr', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_1',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '哈维',
      attributes: { 力量: 60 },
    });
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.st clr'), ctx);

    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('character-sheet');
    if (update?.type === 'character-sheet') {
      expect(update.changes.attributes).toEqual({});
      expect(update.newVersion).toBe(2);
    }
    expect(decision.replies[0]?.text).toContain('属性已清空');
  });

  it('modifies attributes on .st <attr> <val>', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_1',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '哈维',
      attributes: { 力量: 50, HP: 10 },
    });
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.st 力量 65 HP+2'), ctx);

    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('character-sheet');
    if (update?.type === 'character-sheet') {
      expect(update.changes.attributes).toEqual({ 力量: 65, 生命值: 12 });
      expect(update.newVersion).toBe(2);
    }
    expect(decision.replies[0]?.text).toBe('「哈维」的属性变化：\n生命值: 12');
  });

  it('parses compact COC7 aliases and summarizes bulk attribute entry', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_1',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '初无',
      attributes: {},
    });
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(
      createTestEvent(
        '.st 力量55str55敏捷55dex55意志75pow75体质55con55外貌90app90教育50知识50edu50体型70siz70智力60灵感60int60san75san值75理智75理智值75幸运68运气68mp15魔法15hp12体力12会计5人类学1估价5考古学1取悦50攀爬30计算机5计算机使用5电脑5信用20信誉20信用评级20克苏鲁1克苏鲁神话1cm1乔装5闪避57汽车20驾驶20汽车驾驶20电气维修10电子学1话术5斗殴25手枪50急救30历史5恐吓15跳跃20中文52母语50法律5图书馆20图书馆使用20聆听52开锁1撬锁1锁匠1机械维修10医学1博物学10自然学10领航40导航40神秘学63重型操作1重型机械1操作重型机械1重型1说服10精神分析1心理学10骑术5妙手10侦查58潜行40生存10游泳20投掷20追踪10驯兽5潜水1爆破1读唇1催眠1炮术1',
      ),
      ctx,
    );

    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('character-sheet');
    if (update?.type === 'character-sheet') {
      const attributes = update.changes.attributes;
      expect(attributes).toMatchObject({
        力量: 55,
        敏捷: 55,
        意志: 75,
        教育: 50,
        智力: 60,
        理智: 75,
        幸运: 68,
        魔法值: 15,
        生命值: 12,
        信用评级: 20,
        克苏鲁神话: 1,
        计算机使用: 5,
        汽车驾驶: 20,
        图书馆使用: 20,
        锁匠: 1,
        博物学: 10,
        导航: 40,
        操作重型机械: 1,
        动物驯养: 5,
      });
      expect(attributes).not.toHaveProperty('str');
      expect(attributes).not.toHaveProperty('san值');
      expect(attributes).not.toHaveProperty('电脑');
      expect(attributes).not.toHaveProperty('重型');
      expect(decision.replies[0]?.text).toBe(
        `「初无」的COC7属性录入完成，本次录入了${Object.keys(attributes ?? {}).length}条数据`,
      );
    }
  });

  it('creates and binds new character when setting attributes on unbound user', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.st 力量 70 敏捷 80'), ctx);

    expect(decision.updates).toHaveLength(2);
    const sheetUpdate = decision.updates.find((u) => u.type === 'character-sheet');
    const bindUpdate = decision.updates.find((u) => u.type === 'character-binding');
    expect(sheetUpdate).toBeDefined();
    expect(bindUpdate).toBeDefined();
    if (sheetUpdate?.type === 'character-sheet') {
      expect(sheetUpdate.expectedVersion).toBe(0);
      expect(sheetUpdate.newVersion).toBe(1);
      expect(sheetUpdate.changes.attributes).toEqual({ 力量: 70, 敏捷: 80 });
    }
    if (bindUpdate?.type === 'character-binding') {
      expect(bindUpdate.expectedVersion).toBe(0);
      expect(bindUpdate.newVersion).toBe(1);
      expect(bindUpdate.changes.sheetId).toBeTruthy();
    }
  });
});

describe('Character switching command (.pc)', () => {
  const executor = new CommandExecutor();

  it('creates and binds new character on .pc new <name>', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.pc new 艾莉丝'), ctx);

    expect(decision.updates).toHaveLength(2);
    const sheetUpdate = decision.updates.find((u) => u.type === 'character-sheet');
    const bindUpdate = decision.updates.find((u) => u.type === 'character-binding');
    expect(sheetUpdate).toBeDefined();
    expect(bindUpdate).toBeDefined();
    if (sheetUpdate?.type === 'character-sheet') {
      expect(sheetUpdate.expectedVersion).toBe(0);
      expect(sheetUpdate.changes.name).toBe('艾莉丝');
    }
    expect(decision.replies[0]?.text).toContain('已创建并绑定新角色卡「艾莉丝」');
  });

  it('displays current bound character on .pc list', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_alice',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '艾莉丝',
    });
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.pc list'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('艾莉丝');
    expect(decision.replies[0]?.text).toContain('sheet_alice');
  });

  it('unbinds character on .pc untag', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_alice',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '艾莉丝',
    });
    const ctx = createTestContext(
      {},
      {
        sheet,
        characterBinding: { sheetId: sheet.id, version: 1 },
      },
    );
    const decision = await executor.execute(createTestEvent('.pc untag'), ctx);

    expect(decision.updates).toHaveLength(1);
    const bindUpdate = decision.updates[0];
    expect(bindUpdate?.type === 'character-binding' && bindUpdate.changes.sheetId === null).toBe(
      true,
    );
    expect(decision.replies[0]?.text).toContain('已解除');
  });
});

describe('Story log command (.log)', () => {
  const executor = new CommandExecutor();

  it('creates and starts new story log on .log new <name>', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.log new 密斯卡托尼克之夜'), ctx);

    expect(decision.updates).toHaveLength(1);
    const logUpdate = decision.updates[0];
    expect(logUpdate?.type).toBe('story-log');
    if (logUpdate?.type === 'story-log') {
      expect(logUpdate.expectedVersion).toBe(0);
      expect(logUpdate.changes.name).toBe('密斯卡托尼克之夜');
      expect(logUpdate.changes.status).toBe('recording');
    }
    expect(decision.replies[0]?.text).toContain('已创建并开启跑团日志「密斯卡托尼克之夜」');
  });

  it('explains that an unfinished story log must be closed before creating another', async () => {
    const ctx = createTestContext(
      {},
      {
        activeStoryLog: {
          id: 'log_active',
          name: '旧日志',
          status: 'recording',
          version: 1,
        },
      },
    );

    const decision = await executor.execute(createTestEvent('.log new 新日志'), ctx);

    expect(decision.updates).toHaveLength(0);
    expect(decision.replies[0]?.text).toBe(
      '当前已有未结束的跑团日志「旧日志」，请先使用 .log end 关闭后再新建。',
    );
  });

  it('allows normal member without group host permission to create story log', async () => {
    const ctx = createTestContext(
      {},
      {
        permissions: {
          isGroupHost: false,
          isDiceMaster: false,
          denied: false,
          isTrusted: false,
        },
      },
    );
    const decision = await executor.execute(createTestEvent('.log new 测试'), ctx);

    expect(decision.updates).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('已创建并开启跑团日志「测试」');
    expect(decision.replies[0]?.text).not.toContain('Group Host');
  });

  it('pauses active story log on .log pause', async () => {
    const ctx = createTestContext(
      {},
      {
        activeStoryLog: {
          id: 'log_1',
          name: '测试日志',
          status: 'recording',
          version: 1,
        },
      },
    );
    const decision = await executor.execute(createTestEvent('.log pause'), ctx);

    expect(decision.updates).toHaveLength(1);
    const logUpdate = decision.updates[0];
    expect(logUpdate?.type).toBe('story-log');
    if (logUpdate?.type === 'story-log') {
      expect(logUpdate.changes.status).toBe('paused');
      expect(logUpdate.newVersion).toBe(2);
    }
    expect(decision.replies[0]?.text).toContain('已暂停');
  });

  it('resumes active story log on .log on', async () => {
    const ctx = createTestContext(
      {},
      {
        activeStoryLog: {
          id: 'log_1',
          name: '测试日志',
          status: 'paused',
          version: 2,
        },
      },
    );
    const decision = await executor.execute(createTestEvent('.log on'), ctx);

    expect(decision.updates).toHaveLength(1);
    const logUpdate = decision.updates[0];
    expect(logUpdate?.type).toBe('story-log');
    if (logUpdate?.type === 'story-log') {
      expect(logUpdate.changes.status).toBe('recording');
      expect(logUpdate.newVersion).toBe(3);
    }
    expect(decision.replies[0]?.text).toContain('已恢复');
  });

  it('closes active story log on .log end', async () => {
    const ctx = createTestContext(
      {},
      {
        activeStoryLog: {
          id: 'log_1',
          name: '测试日志',
          status: 'recording',
          version: 1,
        },
      },
    );
    const decision = await executor.execute(createTestEvent('.log end'), ctx);

    expect(decision.updates).toHaveLength(2);
    const logUpdate = decision.updates.find((update) => update.type === 'story-log');
    expect(logUpdate?.type).toBe('story-log');
    if (logUpdate?.type === 'story-log') {
      expect(logUpdate.changes.status).toBe('closed');
    }
    const archiveUpdate = decision.updates.find((update) => update.type === 'story-log-archive');
    expect(archiveUpdate).toMatchObject({
      type: 'story-log-archive',
      archiveId: 'archive_log_1',
      jobId: 'job_archive_evt_1',
      logId: 'log_1',
    });
    expect(decision.replies[0]?.text).toContain('.log export');
  });

  it('starts an archive for a previously closed story log', async () => {
    const ctx = createTestContext(
      {},
      {
        latestStoryLog: {
          id: 'log_legacy',
          name: '旧日志',
          status: 'closed',
          version: 2,
        },
      },
    );

    const decision = await executor.execute(createTestEvent('.log export'), ctx);

    expect(decision.updates).toEqual([
      {
        type: 'story-log-archive',
        archiveId: 'archive_log_legacy',
        jobId: 'job_archive_evt_1',
        logId: 'log_legacy',
      },
    ]);
    expect(decision.replies[0]?.text).toContain('已提交归档');
    expect(decision.replies[0]?.text).toContain('.log export');
  });
  it('reports that a closed story log is still being archived', async () => {
    const ctx = createTestContext(
      {},
      {
        latestStoryLog: {
          id: 'log_1',
          name: '测试日志',
          status: 'closed',
          version: 2,
          archive: {
            id: 'archive_log_1',
            status: 'pending',
          },
        },
      },
    );

    const decision = await executor.execute(createTestEvent('.log export'), ctx);

    expect(decision.updates).toHaveLength(0);
    expect(decision.replies[0]?.text).toContain('正在归档');
    expect(decision.replies[0]?.text).toContain('.log export');
  });

  it('issues a short-lived download link for a ready story log archive', async () => {
    const ctx = {
      ...createTestContext(
        {},
        {
          latestStoryLog: {
            id: 'log_1',
            name: '测试日志',
            status: 'closed',
            version: 2,
            archive: {
              id: 'archive_log_1',
              status: 'ready',
            },
          },
        },
      ),
      publicBaseUrl: 'https://worker.test',
    };

    const decision = await executor.execute(createTestEvent('.log export'), ctx);

    expect(decision.updates).toHaveLength(1);
    const grantUpdate = decision.updates[0];
    expect(grantUpdate?.type).toBe('archive-grant');
    if (grantUpdate?.type === 'archive-grant') {
      expect(grantUpdate.archiveId).toBe('archive_log_1');
      expect(grantUpdate.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(grantUpdate.expiresAt.getTime()).toBeGreaterThan(Date.now());
    }
    expect(decision.replies[0]?.text).toMatch(
      /^跑团日志「测试日志」已归档。下载链接（15 分钟内有效）：\nhttps:\/\/worker\.test\/archives\/archive_log_1\?token=[A-Za-z0-9_-]{43}$/,
    );
  });

  it('rejects story log export from a normal member', async () => {
    const ctx = {
      ...createTestContext(
        {},
        {
          permissions: {
            isGroupHost: false,
            isDiceMaster: false,
            denied: false,
            isTrusted: false,
          },
          latestStoryLog: {
            id: 'log_1',
            name: '测试日志',
            status: 'closed',
            version: 2,
            archive: {
              id: 'archive_log_1',
              status: 'ready',
            },
          },
        },
      ),
      publicBaseUrl: 'https://worker.test',
    };

    const decision = await executor.execute(createTestEvent('.log export'), ctx);

    expect(decision.updates).toHaveLength(0);
    expect(decision.replies[0]?.text).toBe('只有群主或骰主可以导出跑团日志。');
  });

  it('reports log status on .log stat', async () => {
    const ctx = createTestContext(
      {},
      {
        activeStoryLog: {
          id: 'log_1',
          name: '测试日志',
          status: 'recording',
          version: 1,
        },
      },
    );
    const decision = await executor.execute(createTestEvent('.log stat'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('测试日志');
    expect(decision.replies[0]?.text).toContain('记录中');
  });

  it('lists logs and resolves named get and stat operations', async () => {
    const storyLogs = [
      {
        id: 'log_old',
        name: '旧日志',
        status: 'closed' as const,
        version: 3,
        itemCount: 42,
        rollCount: 7,
        archive: { id: 'archive_log_old', status: 'ready' as const },
      },
      {
        id: 'log_current',
        name: '当前日志',
        status: 'recording' as const,
        version: 1,
        itemCount: 5,
        rollCount: 2,
      },
    ];
    const ctx = {
      ...createTestContext({}, { storyLogs, activeStoryLog: storyLogs[1] }),
      publicBaseUrl: 'https://worker.test',
    };

    const listed = await executor.execute(createTestEvent('.log list'), ctx);
    expect(listed.results[0]).toMatchObject({
      kind: 'log.list',
      data: { logs: expect.arrayContaining([expect.objectContaining({ id: 'log_old' })]) },
    });
    expect(listed.replies[0]?.text).toContain('旧日志');

    const stat = await executor.execute(createTestEvent('.log stat 旧日志'), ctx);
    expect(stat.results[0]).toMatchObject({
      kind: 'log.stat',
      data: { log: expect.objectContaining({ id: 'log_old', itemCount: 42, rollCount: 7 }) },
    });
    expect(stat.replies[0]?.text).toContain('42');
    expect(stat.replies[0]?.text).toContain('7');

    const downloaded = await executor.execute(createTestEvent('.log get 旧日志'), ctx);
    expect(downloaded.results[0]).toMatchObject({
      kind: 'log.export',
      data: { logId: 'log_old', archiveId: 'archive_log_old' },
    });
    expect(downloaded.updates[0]).toMatchObject({
      type: 'archive-grant',
      archiveId: 'archive_log_old',
    });
  });

  it('halts without archive upload and starts convergent deletion for closed logs', async () => {
    const active = {
      id: 'log_active',
      name: '现场日志',
      status: 'recording' as const,
      version: 2,
    };
    const halted = await executor.execute(
      createTestEvent('.log halt'),
      createTestContext({}, { activeStoryLog: active, storyLogs: [active] }),
    );
    expect(halted.updates).toEqual([
      {
        type: 'story-log',
        logId: 'log_active',
        conversationId: 'conv_test_1',
        expectedVersion: 2,
        changes: { name: '现场日志', status: 'closed' },
        newVersion: 3,
      },
    ]);

    const closed = {
      id: 'log_closed',
      name: '待删除',
      status: 'closed' as const,
      version: 4,
      archive: { id: 'archive_log_closed', status: 'ready' as const },
    };
    const deleted = await executor.execute(
      createTestEvent('.log del 待删除'),
      createTestContext({}, { latestStoryLog: closed, storyLogs: [closed] }),
    );
    expect(deleted.updates).toEqual([
      {
        type: 'story-log-delete',
        logId: 'log_closed',
        expectedVersion: 4,
        newVersion: 5,
        jobId: 'job_delete_log_evt_1',
      },
    ]);
  });
});
describe('Nickname command (.nn)', () => {
  const executor = new CommandExecutor();

  it('shows current nickname on .nn', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.nn'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('玩家的当前昵称为: <用户_xt_1>');
  });

  it('sets nickname and creates character sheet binding when none exists on .nn <name>', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.nn 阿卡特'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('character.nn');
    expect(decision.updates).toHaveLength(2);
    expect(decision.replies[0]?.text).toContain('的昵称被设定为<阿卡特>');
  });

  it('updates bound character name on .nn <name>', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_1',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '哈维',
      attributes: { 侦查: 75 },
    });
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.nn 阿卡特'), ctx);

    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('character-sheet');
    if (update?.type === 'character-sheet') {
      expect(update.changes.name).toBe('阿卡特');
    }
    expect(decision.replies[0]?.text).toContain('<哈维>');
    expect(decision.replies[0]?.text).toContain('的昵称被设定为<阿卡特>');
  });

  it('resets nickname on .nn clr', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_1',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '阿卡特',
    });
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.nn clr'), ctx);

    expect(decision.replies[0]?.text).toContain('已重置为<用户_xt_1>');
  });

  it('shows help text on .nn help', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.nn help'), ctx);

    expect(decision.replies[0]?.text).toContain('角色名设置:');
    expect(decision.replies[0]?.text).toContain('.nn clr // 重置回群名片');
  });
});

describe('Check commands (.ra / .rc)', () => {
  const executor = new CommandExecutor();

  it('performs COC7 check against raw target value on .ra 60', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.ra 60'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('coc.check');
    expect(decision.replies).toHaveLength(1);
    expect(decision.results[0]?.data).toMatchObject({
      skill: { name: '检定' },
      target: { value: 60 },
    });
    expect(decision.results[0]?.data.roll).toMatchObject({
      total: expect.any(Number),
    });
  });

  it('performs COC7 check with bound character skill on .ra 侦查', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_1',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '哈维',
      attributes: { 侦查: 75 },
    });
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.ra 侦查'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('coc.check');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('哈维');
    expect(decision.replies[0]?.text).toContain('侦查');
    expect(decision.replies[0]?.text).toContain('75');
  });

  it('performs DND5e check when conversation ruleSet is dnd5e', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_dnd',
      ownerId: 'user_ext_1',
      ruleSet: 'dnd5e',
      name: '格罗姆',
      attributes: { 力量: 16 },
    });
    const ctx = createTestContext({ ruleSet: 'dnd5e' }, { sheet });
    const decision = await executor.execute(createTestEvent('.ra 力量 15'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('dnd5e.check');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('格罗姆');
    expect(decision.replies[0]?.text).toContain('力量');
    expect(decision.replies[0]?.text).toMatch(/1D20/);
  });
});

describe('Character generation commands (.coc / .dnd) and seamless prefix parsing', () => {
  const executor = new CommandExecutor();

  it('generates single COC7 investigator card on .coc', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.coc'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('coc.card_gen');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('七版COC人物作成');
    expect(decision.replies[0]?.text).toContain('力量:');
    expect(decision.replies[0]?.text).toContain('幸运:');
    expect(decision.replies[0]?.text).toContain('<DB:');
  });

  it('generates 5 COC7 investigator cards on 。coc5 without space', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('。coc5'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('coc.card_gen');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('七版COC人物作成');
    const sets = decision.replies[0]?.text.split('\n\n') ?? [];
    expect(sets.length).toBe(5);
  });

  it('generates 3 COC7 investigator cards on .coc 3 with space', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.coc 3'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('七版COC人物作成');
    const sets = decision.replies[0]?.text.split('\n\n') ?? [];
    expect(sets.length).toBe(3);
  });

  it('seamlessly parses .r1d100 without space', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.r1d100'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('dice_roll');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toMatch(/1d100/i);
  });

  it('generates DND5e cards in free allocation mode on .dnd3 without space', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.dnd3'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('dnd.card_gen');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('使用自由分配的DND5E人物作成');
    expect(decision.replies[0]?.text).toMatch(/\[\d+, \d+, \d+, \d+, \d+, \d+\] = \d+/);
  });

  it('generates DND5e cards in preset mode on .dndx', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.dndx'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('dnd.card_gen');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('使用预设模板的DND5E人物作成');
    expect(decision.replies[0]?.text).toContain('力量:');
    expect(decision.replies[0]?.text).toContain('共计:');
  });

  it('returns help message when invalid argument passed to .coc', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.coc abc'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('COC制卡指令:');
  });

  it('supports multi-execution prefix 3# .r 1d100', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('3# .r 1d100'), ctx);

    expect(decision.results).toHaveLength(3);
    expect(decision.replies).toHaveLength(1);
    const lines = decision.replies[0]?.text.split('\n') ?? [];
    expect(lines.length).toBe(3);
  });

  it('supports ! and ！ prefixes', async () => {
    const ctx = createTestContext();
    const decision1 = await executor.execute(createTestEvent('!r 1d20'), ctx);
    expect(decision1.results).toHaveLength(1);

    const decision2 = await executor.execute(createTestEvent('！r 1d20'), ctx);
    expect(decision2.results).toHaveLength(1);
  });
});

describe('Roll command rd-alias compat parsing (.rd)', () => {
  const executor = new CommandExecutor();

  it('restores leading d for .rd20+d10+d4 like SealDice compat mode', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.rd20+d10+d4'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('dice_roll');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toMatch(
      /^d20\+d10\+d4 = \[\d+\] \+ \[\d+\] \+ \[\d+\] = \d+$/,
    );
  });

  it('restores leading d for .rd20 without space', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.rd20'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('1d20');
  });

  it('treats .rd 20 with space as default die with reason like SealDice', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.rd 20'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('1d100');
  });

  it('restores leading d for .rd+5 modifier form', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.rd+5'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('1d100+5');
  });

  it('does not duplicate d when expression already starts with d on .rd d20', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.rd d20'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('1d20');
  });
});

describe('Advantage and disadvantage dice suffixes', () => {
  const executor = new CommandExecutor();

  it('rolls two dice and keeps the highest for d20优势', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.r d20优势'), ctx);

    expect(decision.results).toHaveLength(1);
    const match = decision.replies[0]?.text.match(/^2d20 = \[(\d+), (\d+)\] = (\d+)$/);
    expect(match).not.toBeNull();
    const first = Number(match?.[1]);
    const second = Number(match?.[2]);
    const total = Number(match?.[3]);
    expect(total).toBe(Math.max(first, second));
  });

  it('rolls two dice and keeps the lowest for d20劣势', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.r d20劣势'), ctx);

    expect(decision.results).toHaveLength(1);
    const match = decision.replies[0]?.text.match(/^2d20 = \[(\d+), (\d+)\] = (\d+)$/);
    expect(match).not.toBeNull();
    const first = Number(match?.[1]);
    const second = Number(match?.[2]);
    const total = Number(match?.[3]);
    expect(total).toBe(Math.min(first, second));
  });

  it('uses default sides while rolling two dice for d优势', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.r d优势'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.replies[0]?.text).toMatch(/^2d100 = \[\d+, \d+\] = \d+$/);
  });
});

describe('Hidden roll command (.rh)', () => {
  const executor = new CommandExecutor();
  const activeBinding = {
    id: 'hrb_test',
    groupScopeId: 'group_ext_1',
    groupPrincipalId: 'group_principal_1',
    c2cPrincipalId: 'c2c_principal_1',
    userOpenid: 'user_c2c_1',
    activeMessagesEnabled: true,
    version: 1,
  };

  it('guides unbound group users without consuming dice', async () => {
    const ctx = createTestContext({}, { principalId: 'group_principal_1' });
    const decision = await executor.execute(createTestEvent('.rh d20 秘密行动'), ctx);

    expect(decision.results).toHaveLength(0);
    expect(ctx.budget.consumed.diceRolls).toBe(0);
    expect(decision.replies[0]).toMatchObject({
      scene: 'groupAt',
      templateKey: 'dice.hidden.binding_required',
    });
    expect(decision.replies[0]?.text).toContain('.rhbind');
  });

  it('creates an active C2C result and mutually exclusive group notices', async () => {
    const ctx = createTestContext(
      {},
      {
        principalId: 'group_principal_1',
        hiddenRollBinding: activeBinding,
      },
    );
    const decision = await executor.execute(createTestEvent('.rh d20 秘密行动'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.data.hidden).toBe(true);
    expect(decision.replies).toHaveLength(3);
    expect(decision.replies[0]).toMatchObject({
      scene: 'c2c',
      targetId: 'user_c2c_1',
      templateKey: 'dice.hidden.roll',
      deliveryMode: 'active',
    });
    expect(decision.replies[0]?.originMessageId).toBeUndefined();
    expect(decision.replies[0]?.text).toMatch(/^1d20 = \[\d+\] = \d+ 秘密行动$/);
    expect(decision.replies[1]).toMatchObject({
      scene: 'groupAt',
      templateKey: 'dice.hidden.group_sent',
      condition: { part: 1, status: 'sent' },
    });
    expect(decision.replies[2]).toMatchObject({
      scene: 'groupAt',
      templateKey: 'dice.hidden.group_failed',
      condition: { part: 1, status: 'failed' },
    });
    expect(decision.replies.slice(1).every((reply) => !reply.text.includes('['))).toBe(true);
  });

  it('attempts private delivery even when cached active-message authorization is disabled', async () => {
    const ctx = createTestContext(
      {},
      {
        principalId: 'group_principal_1',
        hiddenRollBinding: {
          ...activeBinding,
          activeMessagesEnabled: false,
        },
      },
    );
    const decision = await executor.execute(createTestEvent('.rh d20'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(ctx.budget.consumed.diceRolls).toBe(1);
    expect(decision.replies).toHaveLength(3);
    expect(decision.replies[0]).toMatchObject({
      scene: 'c2c',
      deliveryMode: 'active',
    });
  });

  it('returns a hidden roll result inside a C2C conversation', async () => {
    const ctx = createTestContext({
      scene: 'c2c',
      externalId: 'user_ext_1',
    });
    const decision = await executor.execute(createC2cTestEvent('.rh d20 秘密行动'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]).toMatchObject({
      kind: 'dice_roll',
      data: {
        hidden: true,
      },
    });
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]).toMatchObject({
      scene: 'c2c',
      targetId: 'user_ext_1',
      templateKey: 'dice.hidden.roll',
    });
    expect(decision.replies[0]?.text).toMatch(/^1d20 = \[\d+\] = \d+ 秘密行动$/);
  });

  it('supports SealDice rhd and rdh aliases with compact dice expressions', async () => {
    for (const command of ['.rhd20', '.rdh20']) {
      const ctx = createTestContext({
        scene: 'c2c',
        externalId: 'user_ext_1',
      });
      const decision = await executor.execute(createC2cTestEvent(command), ctx);

      expect(decision.results).toHaveLength(1);
      expect(decision.results[0]?.data.hidden).toBe(true);
      expect(decision.replies[0]?.text).toMatch(/^1d20 = \[\d+\] = \d+$/);
    }
  });
});

describe('Hidden roll trusted binding command (.rhbind)', () => {
  const executor = new CommandExecutor();

  it('issues a private token when the authorization event is missing or stale', async () => {
    const ctx = createTestContext(
      { scene: 'c2c', externalId: 'user_ext_1' },
      { principalId: 'c2c_principal_1', c2cActiveMessagesEnabled: false },
    );
    const decision = await executor.execute(createC2cTestEvent('.rhbind'), ctx);

    expect(decision.updates[0]).toMatchObject({
      type: 'hidden-roll-link-challenge',
      c2cPrincipalId: 'c2c_principal_1',
      userOpenid: 'user_ext_1',
    });
    expect(decision.replies[0]?.text).toMatch(/绑定令牌：[A-Za-z0-9_-]{43}/);
  });

  it('issues a single-use 256-bit binding token in C2C', async () => {
    const ctx = createTestContext(
      { scene: 'c2c', externalId: 'user_ext_1' },
      { principalId: 'c2c_principal_1', c2cActiveMessagesEnabled: true },
    );
    const decision = await executor.execute(createC2cTestEvent('.rhbind'), ctx);

    expect(decision.updates).toHaveLength(1);
    expect(decision.updates[0]).toMatchObject({
      type: 'hidden-roll-link-challenge',
      c2cPrincipalId: 'c2c_principal_1',
      userOpenid: 'user_ext_1',
    });
    const token = decision.replies[0]?.text.match(/绑定令牌：([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toHaveLength(43);
  });

  it('consumes a private token even when the cached authorization is disabled', async () => {
    const token = 'A'.repeat(43);
    const hiddenRollLinks: HiddenRollLinkReader = {
      findHiddenRollLinkChallenge: async () => ({
        id: 'challenge_1',
        c2cPrincipalId: 'c2c_principal_1',
        userOpenid: 'user_c2c_1',
        version: 1,
        expiresAt: new Date(Date.now() + 600_000),
        activeMessagesEnabled: false,
      }),
    };
    const ctx = createTestContext({}, { principalId: 'group_principal_1' }, hiddenRollLinks);
    const decision = await executor.execute(createTestEvent(`.rhbind ${token}`), ctx);

    expect(decision.updates).toEqual([
      {
        type: 'hidden-roll-binding',
        bindingId: 'hrb_evt_1',
        challengeId: 'challenge_1',
        expectedChallengeVersion: 1,
        groupScopeId: 'group_ext_1',
        groupPrincipalId: 'group_principal_1',
        c2cPrincipalId: 'c2c_principal_1',
        userOpenid: 'user_c2c_1',
      },
    ]);
    expect(decision.replies[0]?.text).toContain('绑定成功');
  });

  it('revokes the current group binding', async () => {
    const ctx = createTestContext(
      {},
      {
        principalId: 'group_principal_1',
        hiddenRollBinding: {
          id: 'binding_1',
          groupScopeId: 'group_ext_1',
          groupPrincipalId: 'group_principal_1',
          c2cPrincipalId: 'c2c_principal_1',
          userOpenid: 'user_c2c_1',
          activeMessagesEnabled: true,
          version: 3,
        },
      },
    );
    const decision = await executor.execute(createTestEvent('.rhbind off'), ctx);

    expect(decision.updates).toEqual([
      {
        type: 'hidden-roll-unbind',
        bindingId: 'binding_1',
        expectedVersion: 3,
        newVersion: 4,
      },
    ]);
  });
});

describe('Sanity check command (.sc)', () => {
  const executor = new CommandExecutor();

  it('shows help when no args given on .sc', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.sc'), ctx);

    expect(decision.replies[0]?.templateKey).toBe('coc.sc.help');
    expect(decision.replies[0]?.text).toContain('--cap');
  });

  it('performs sanity check and decreases san on .sc 1/1d6', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_coc',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '爱德华',
      attributes: { 理智: 60 },
    });
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.sc 1/1d6'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('coc.sc');
    expect(decision.replies[0]?.templateKey).toBe('coc.sc');
    expect(decision.results[0]?.data).toMatchObject({
      sanOld: 60,
      sanNew: expect.any(Number),
      sanLoss: expect.any(Number),
    });
    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('character-sheet');
  });

  it('produces temporary madness tip when san loss is large on .sc 10/10', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_coc',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '爱德华',
      attributes: { 理智: 60 },
    });
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.sc 10/10'), ctx);

    expect(decision.results[0]?.data).toMatchObject({ sanLoss: 10 });
    expect(decision.replies[0]?.text).toContain('临时疯狂');
  });
});

describe('Madness symptom table commands (.ti / .li)', () => {
  const executor = new CommandExecutor();

  it('draws temporary madness symptom on .ti', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.ti'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('coc.ti');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('疯狂发作-即时症状');
    expect(decision.replies[0]?.text).toContain('1D10=');
  });

  it('draws summary madness symptom on .li', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.li'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('coc.li');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('疯狂发作-总结症状');
    expect(decision.replies[0]?.text).toContain('1D10=');
  });
});

describe('Skill growth command (.en)', () => {
  const executor = new CommandExecutor();

  it('shows help when no args given on .en', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.en'), ctx);

    expect(decision.replies[0]?.templateKey).toBe('coc.en.help');
    expect(decision.replies[0]?.text).toContain('多个技能');
  });

  it('performs skill growth check on .en 侦查 with bound sheet', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_coc',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '爱德华',
      attributes: { 侦查: 30 },
    });
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.en 侦查'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('coc.en');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('爱德华');
    expect(decision.replies[0]?.text).toContain('侦查');
    expect(decision.replies[0]?.text).toContain('D100=');
  });
});

describe('Death saving throws command (.ds)', () => {
  const executor = new CommandExecutor();

  it('rejects when character has HP > 0', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_dnd',
      ownerId: 'user_ext_1',
      ruleSet: 'dnd5e',
      name: '格罗姆',
      attributes: { HP: 15 },
    });
    const ctx = createTestContext({ ruleSet: 'dnd5e' }, { sheet });
    const decision = await executor.execute(createTestEvent('.ds'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('生命值大于0');
  });

  it('rejects when character has no HP attribute', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_dnd',
      ownerId: 'user_ext_1',
      ruleSet: 'dnd5e',
      name: '格罗姆',
      attributes: {},
    });
    const ctx = createTestContext({ ruleSet: 'dnd5e' }, { sheet });
    const decision = await executor.execute(createTestEvent('.ds'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('未设置生命值');
  });

  it('rolls death save when HP is 0', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_dnd',
      ownerId: 'user_ext_1',
      ruleSet: 'dnd5e',
      name: '格罗姆',
      attributes: { HP: 0 },
    });
    const ctx = createTestContext({ ruleSet: 'dnd5e' }, { sheet });
    const decision = await executor.execute(createTestEvent('.ds'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('dnd5e.ds');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('死亡豁免检定: 1D20=');
    expect(decision.updates).toHaveLength(1);
  });

  it('shows stats on .ds stat', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_dnd',
      ownerId: 'user_ext_1',
      ruleSet: 'dnd5e',
      name: '格罗姆',
      attributes: { HP: 0, DSS: 1, DSF: 2 },
    });
    const ctx = createTestContext({ ruleSet: 'dnd5e' }, { sheet });
    const decision = await executor.execute(createTestEvent('.ds stat'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('当前的死亡豁免情况: 成功1 失败2');
  });

  it('supports manual adjustment on .ds s+1', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_dnd',
      ownerId: 'user_ext_1',
      ruleSet: 'dnd5e',
      name: '格罗姆',
      attributes: { HP: 0, DSS: 0, DSF: 0 },
    });
    const ctx = createTestContext({ ruleSet: 'dnd5e' }, { sheet });
    const decision = await executor.execute(createTestEvent('.ds s+1'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('当前的死亡豁免情况: 成功1 失败0');
    expect(decision.updates).toHaveLength(1);
  });
});

describe('COC house rule switching command (.setcoc)', () => {
  const executor = new CommandExecutor();

  it('shows current house rule on .setcoc', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.setcoc'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('当前房规: 规则书规则');
  });

  it('shows all rule details on .setcoc details', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.setcoc details'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('COC房规列表：');
    expect(decision.replies[0]?.text).toContain('DeltaGreen');
  });

  it('switches house rule on .setcoc 2', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.setcoc 2'), ctx);

    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('conversation-settings');
    if (update?.type === 'conversation-settings') {
      expect(update.changes.cocRule).toBe('2');
    }
    expect(decision.replies[0]?.text).toContain('国内常用规则');
  });

  it('switches house rule on .setcoc dg', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.setcoc dg'), ctx);

    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('conversation-settings');
    if (update?.type === 'conversation-settings') {
      expect(update.changes.cocRule).toBe('dg');
    }
    expect(decision.replies[0]?.text).toContain('DeltaGreen');
  });
});

describe('Set command loose syntax (.set)', () => {
  const executor = new CommandExecutor();

  it('sets dice sides with single number .set 20', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.set 20'), ctx);

    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('conversation-settings');
    if (update?.type === 'conversation-settings') {
      expect(update.changes.diceSides).toBe(20);
    }
    expect(decision.replies[0]?.text).toContain('Default dice sides set to 20');
  });

  it('sets rule set with single keyword .set dnd', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.set dnd'), ctx);

    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('conversation-settings');
    if (update?.type === 'conversation-settings') {
      expect(update.changes.ruleSet).toBe('dnd5e');
    }
    expect(decision.replies[0]?.text).toContain('Rule set changed to dnd5e');
  });

  it('resets dice sides on .set clr', async () => {
    const ctx = createTestContext({ diceSides: 20 });
    const decision = await executor.execute(createTestEvent('.set clr'), ctx);

    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('conversation-settings');
    if (update?.type === 'conversation-settings') {
      expect(update.changes.diceSides).toBe(100);
    }
    expect(decision.replies[0]?.text).toContain('Default dice sides reset to 100');
  });
});

describe('Character sheet dice-expression modification and threshold filter (.st)', () => {
  const executor = new CommandExecutor();

  it('filters attributes by threshold on .st show 50', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_1',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '哈维',
      attributes: { 力量: 60, 敏捷: 40, 体质: 75 },
    });
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.st show 50'), ctx);

    expect(decision.replies[0]?.text).toContain('力量: 60');
    expect(decision.replies[0]?.text).toContain('体质: 75');
    expect(decision.replies[0]?.text).not.toContain('敏捷');
  });

  it('modifies attribute with dice expression on .st HP+1d4', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_1',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '哈维',
      attributes: { HP: 10 },
    });
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.st HP+1d4'), ctx);

    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('character-sheet');
    if (update?.type === 'character-sheet') {
      const hp = update.changes.attributes?.生命值;
      expect(hp).toBeGreaterThanOrEqual(11);
      expect(hp).toBeLessThanOrEqual(14);
    }
    expect(decision.replies[0]?.text).toContain('生命值:');
  });
});

describe('Character sheet save and load (.pc save / .pc load)', () => {
  const executor = new CommandExecutor();

  it('saves character snapshot on .pc save <name>', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_1',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '艾莉丝',
      attributes: { 力量: 50 },
    });
    const ctx = createTestContext({}, { principalId: 'principal_1', sheet });
    const decision = await executor.execute(createTestEvent('.pc save 战斗卡'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('character.save');
    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('character-sheet');
    if (update?.type === 'character-sheet') {
      expect(update.changes.name).toBe('战斗卡');
      expect(update.changes.attributes).toEqual({ 力量: 50 });
      expect(update.changes.ownerPrincipal).toBe('principal_1');
      expect(update.sheetId).not.toContain('战斗卡');
    }
    expect(decision.replies[0]?.templateKey).toBe('character.save');
  });

  it('binds an owned character selected by name', async () => {
    const saved = createCharacterSheet({
      id: 'sheet_saved',
      ownerId: 'principal_1',
      ruleSet: 'coc7',
      name: '战斗卡',
      attributes: { 力量: 50 },
    });
    const ctx = createTestContext({}, { principalId: 'principal_1', ownedSheets: [saved] });
    const decision = await executor.execute(createTestEvent('.pc load 战斗卡'), ctx);

    expect(decision.results[0]?.kind).toBe('character.load');
    expect(decision.updates[0]).toMatchObject({
      type: 'character-binding',
      changes: { sheetId: 'sheet_saved' },
    });
  });

  it('rejects loading a missing or foreign character', async () => {
    const decision = await executor.execute(
      createTestEvent('.pc load 不存在'),
      createTestContext({}, { principalId: 'principal_1', ownedSheets: [] }),
    );

    expect(decision.results).toHaveLength(0);
    expect(decision.updates).toHaveLength(0);
    expect(decision.replies[0]?.templateKey).toBe('character.not_found');
  });

  it('lists every owned character and marks the active one', async () => {
    const first = createCharacterSheet({
      id: 'sheet_first',
      ownerId: 'principal_1',
      ruleSet: 'coc7',
      name: '第一张卡',
    });
    const second = createCharacterSheet({
      id: 'sheet_second',
      ownerId: 'principal_1',
      ruleSet: 'coc7',
      name: '第二张卡',
    });
    const decision = await executor.execute(
      createTestEvent('.pc list'),
      createTestContext(
        {},
        {
          principalId: 'principal_1',
          sheet: second,
          ownedSheets: [first, second],
        },
      ),
    );

    expect(decision.results[0]?.data).toMatchObject({
      activeSheetId: 'sheet_second',
      sheets: [
        { id: 'sheet_first', name: '第一张卡', active: false },
        { id: 'sheet_second', name: '第二张卡', active: true },
      ],
    });
  });

  it('renames the active character and deletes an owned character by name', async () => {
    const active = {
      ...createCharacterSheet({
        id: 'sheet_active',
        ownerId: 'principal_1',
        ruleSet: 'coc7',
        name: '旧名',
      }),
      version: 3,
    };
    const archived = {
      ...createCharacterSheet({
        id: 'sheet_archived',
        ownerId: 'principal_1',
        ruleSet: 'coc7',
        name: '归档卡',
      }),
      version: 2,
    };
    const snapshot = {
      principalId: 'principal_1',
      sheet: active,
      ownedSheets: [active, archived],
    };

    const renamed = await executor.execute(
      createTestEvent('.pc rename 新名'),
      createTestContext({}, snapshot),
    );
    expect(renamed.updates[0]).toMatchObject({
      type: 'character-sheet',
      sheetId: 'sheet_active',
      expectedVersion: 3,
      changes: { name: '新名' },
      newVersion: 4,
    });

    const deleted = await executor.execute(
      createTestEvent('.pc del 归档卡'),
      createTestContext({}, snapshot),
    );
    expect(deleted.updates[0]).toEqual({
      type: 'character-sheet-delete',
      sheetId: 'sheet_archived',
      ownerPrincipal: 'principal_1',
      expectedVersion: 2,
    });
  });
});

describe('Rule glossary search command (.find)', () => {
  const executor = new CommandExecutor();

  it('shows help when no query given on .find', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.find'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('规则查询指令：.find <关键词>');
  });

  it('finds rule glossary entries on .find 理智', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.find 理智'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('rule.find');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('理智检定');
  });

  it('finds rule glossary entries on .find 死亡豁免', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.find 死亡豁免'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('死亡豁免');
  });

  it('reports not found on .find 某个不存在的规则词条', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.find 某个不存在的规则词条'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('未找到与');
  });
  it('supports lookup aliases, grouped pagination, and stable entry IDs', async () => {
    const ctx = createTestContext();
    const grouped = await executor.execute(createTestEvent('.查询 list dnd5e 2'), ctx);
    expect(grouped.results[0]).toMatchObject({
      kind: 'rule.find.list',
      data: { group: 'dnd5e', page: 2, totalPages: 2 },
    });
    expect(grouped.replies[0]?.text).toContain('DND5E');

    const byId = await executor.execute(createTestEvent('.査詢 #1'), ctx);
    expect(byId.results[0]).toMatchObject({
      kind: 'rule.find',
      data: {
        matches: [expect.objectContaining({ id: 1, ruleSet: 'coc7' })],
      },
    });
    expect(byId.replies[0]?.text).toContain('理智检定');
  });
});

describe('Entertainment and utility commands (.jrrp / .gugu / .name / .namednd / .modu)', () => {
  const executor = new CommandExecutor();

  it('calculates daily luck on .jrrp deterministically', async () => {
    const ctx = createTestContext();
    const decision1 = await executor.execute(createTestEvent('.jrrp'), ctx);
    const decision2 = await executor.execute(createTestEvent('.jrrp'), ctx);

    expect(decision1.results).toHaveLength(1);
    expect(decision1.results[0]?.kind).toBe('fun.jrrp');
    expect(decision1.replies).toHaveLength(1);
    expect(decision1.replies[0]?.text).toContain('今日人品为');
    expect(decision1.replies[0]?.text).toBe(decision2.replies[0]?.text);
  });

  it('generates excuse on .gugu and includes author with 来源', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.gugu'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('fun.gugu');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('🕊️:');

    const decisionAuthor = await executor.execute(createTestEvent('.gugu 来源'), ctx);
    expect(decisionAuthor.replies[0]?.text).toContain('——');
  });

  it('generates random names on .name', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.name cn 3'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('fun.name');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('生成随机名字 (cn)');

    const decisionEn = await executor.execute(createTestEvent('.name en'), ctx);
    expect(decisionEn.replies[0]?.text).toContain('生成随机名字 (en)');

    const decisionJp = await executor.execute(createTestEvent('.name jp'), ctx);
    expect(decisionJp.replies[0]?.text).toContain('生成随机名字 (jp)');
  });

  it('generates DND names on .namednd', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.namednd 矮人 2'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('fun.namednd');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('生成 DND 名字 (矮人)');
  });

  it('shows help on .modu help', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.modu help'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('魔都模组网查询：');
  });

  it('requires module ID on .modu get', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.modu get'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('请提供模组编号');
  });
  it('provides low-cost compatibility utilities and aliases', async () => {
    const defaultNames = await executor.execute(createTestEvent('.name'), createTestContext());
    expect(defaultNames.results[0]?.data).toMatchObject({ count: 5 });

    const regionalName = await executor.execute(
      createTestEvent('.namednd 达马拉 2'),
      createTestContext(),
    );
    expect(regionalName.results[0]).toMatchObject({
      kind: 'fun.namednd',
      data: { race: '达马拉', count: 2 },
    });

    const chineseAlias = await executor.execute(createTestEvent('.咕咕'), createTestContext());
    expect(chineseAlias.results[0]?.kind).toBe('fun.gugu');

    const moduAlias = await executor.execute(createTestEvent('.cnmods help'), createTestContext());
    expect(moduAlias.replies[0]?.text).toContain('魔都模组网查询');

    const ping = await executor.execute(createTestEvent('.ping'), createTestContext());
    expect(ping.results[0]).toMatchObject({ kind: 'utility.ping' });

    const who = await executor.execute(
      createTestEvent('.who 甲 乙 丙'),
      createTestContext({}, {}, undefined, sequenceRandom([0, 0])),
    );
    expect(who.results[0]).toMatchObject({
      kind: 'utility.who',
      data: { choices: expect.arrayContaining(['甲', '乙', '丙']) },
    });
  });
});

describe('SealDice compatibility entry contracts', () => {
  const executor = new CommandExecutor();

  it('routes compact Unicode arguments through the matching command', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_compact',
      ownerId: 'user_ext_1',
      ruleSet: 'coc7',
      name: '调查员',
      attributes: { 侦查: 65 },
    });
    const ctx = createTestContext({}, { sheet });

    const check = await executor.execute(createTestEvent('。ra侦查'), ctx);
    expect(check.results[0]?.kind).toBe('coc.check');
    expect(check.results[0]?.data).toMatchObject({
      skill: { name: '侦查' },
      target: { value: 65 },
    });

    const attributes = await executor.execute(createTestEvent('.st力量50敏捷60'), ctx);
    expect(attributes.results[0]?.kind).toBe('character.attributes.set');
    expect(attributes.updates[0]).toMatchObject({
      type: 'character-sheet',
      changes: { attributes: expect.objectContaining({ 力量: 50, 敏捷: 60 }) },
    });

    const growth = await executor.execute(createTestEvent('.en侦查'), ctx);
    expect(growth.results[0]?.kind).toBe('coc.en');
    expect(growth.results[0]?.data).toMatchObject({ skill: '侦查', oldValue: 65 });
  });

  it('rejects missing check targets instead of inventing values', async () => {
    const noSheet = createTestContext();
    const empty = await executor.execute(createTestEvent('。ra'), noSheet);
    expect(empty.results).toHaveLength(0);
    expect(empty.updates).toHaveLength(0);
    expect(empty.replies[0]?.templateKey).toBe('coc.check.help');

    const missingSkill = await executor.execute(createTestEvent('.ra 侦查'), noSheet);
    expect(missingSkill.results).toHaveLength(0);
    expect(missingSkill.replies[0]?.templateKey).toBe('coc.check.missing_attribute');

    const dndMissing = await executor.execute(
      createTestEvent('.ra 隐匿'),
      createTestContext({ ruleSet: 'dnd5e' }),
    );
    expect(dndMissing.results).toHaveLength(0);
    expect(dndMissing.replies[0]?.templateKey).toBe('dnd5e.check.missing_attribute');
  });

  it('reserves check for the unsupported SealDice authenticity command', async () => {
    const decision = await executor.execute(createTestEvent('.check'), createTestContext());
    expect(decision.results).toHaveLength(0);
    expect(decision.updates).toHaveLength(0);
    expect(decision.replies[0]?.templateKey).toBe('system.check.unsupported');
  });

  it('advances initiative on end and clears only on clr', async () => {
    const base = createCombatEncounter({
      id: 'enc_test',
      conversationId: 'conv_test_1',
      version: 1,
    });
    const withFirst = addCombatant(base, { id: 'a', name: '甲', initiative: 20 });
    const encounter = addCombatant(withFirst, { id: 'b', name: '乙', initiative: 10 });
    const ctx = createTestContext(
      { ruleSet: 'dnd5e' },
      {
        encounter: {
          id: encounter.id,
          conversationId: encounter.conversationId,
          state: encounter,
          version: encounter.version,
        },
      },
    );

    const advanced = await executor.execute(createTestEvent('.init end'), ctx);
    expect(advanced.results[0]?.kind).toBe('dnd5e.init.next');
    expect(advanced.updates[0]).toMatchObject({
      type: 'encounter',
      changes: { state: expect.objectContaining({ turnIndex: 1 }) },
    });

    const cleared = await executor.execute(createTestEvent('.init clr'), ctx);
    expect(cleared.results[0]?.kind).toBe('dnd5e.init.clear');
    expect(cleared.updates[0]).toMatchObject({
      type: 'encounter',
      changes: { state: expect.objectContaining({ combatants: [] }) },
    });
  });

  it('separates batch initiative rolling from list administration', async () => {
    const rolled = await executor.execute(
      createTestEvent('.ri =1d10+3 王五, +2 李四, 12 张三'),
      createTestContext({ ruleSet: 'dnd5e' }, {}, undefined, sequenceRandom([7, 10])),
    );
    expect(rolled.results[0]?.kind).toBe('dnd5e.initiative.roll');
    expect(rolled.results[0]?.data).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ name: '王五', initiative: 10 }),
        expect.objectContaining({ name: '李四', initiative: 12 }),
        expect.objectContaining({ name: '张三', initiative: 12 }),
      ]),
    });
    expect(rolled.updates[0]).toMatchObject({
      type: 'encounter',
      changes: {
        state: expect.objectContaining({
          combatants: expect.arrayContaining([
            expect.objectContaining({ name: '王五', initiative: 10 }),
            expect.objectContaining({ name: '李四', initiative: 12 }),
            expect.objectContaining({ name: '张三', initiative: 12 }),
          ]),
        }),
      },
    });

    const listed = await executor.execute(
      createTestEvent('.init'),
      createTestContext({ ruleSet: 'dnd5e' }),
    );
    expect(listed.updates).toHaveLength(0);
    expect(listed.replies[0]?.templateKey).toBe('dnd5e.init.empty');
  });

  it('removes named combatants through init del', async () => {
    const base = createCombatEncounter({
      id: 'enc_delete',
      conversationId: 'conv_test_1',
      version: 1,
    });
    const encounter = addCombatant(
      addCombatant(base, { id: 'actor_甲', name: '甲', initiative: 20 }),
      { id: 'actor_乙', name: '乙', initiative: 10 },
    );
    const decision = await executor.execute(
      createTestEvent('.init del 甲'),
      createTestContext(
        { ruleSet: 'dnd5e' },
        {
          encounter: {
            id: encounter.id,
            conversationId: encounter.conversationId,
            state: encounter,
            version: encounter.version,
          },
        },
      ),
    );

    expect(decision.results[0]?.kind).toBe('dnd5e.init.remove');
    expect(decision.updates[0]).toMatchObject({
      changes: {
        state: expect.objectContaining({
          combatants: [expect.objectContaining({ name: '乙' })],
        }),
      },
    });
  });

  it('rejects invalid initiative values instead of using ten', async () => {
    const decision = await executor.execute(
      createTestEvent('.init set 调查员 not-a-number'),
      createTestContext({ ruleSet: 'dnd5e' }),
    );
    expect(decision.results).toHaveLength(0);
    expect(decision.updates).toHaveLength(0);
    expect(decision.replies[0]?.templateKey).toBe('dnd5e.init.invalid');
  });

  it('switches to COC7 together with the selected house rule', async () => {
    const decision = await executor.execute(
      createTestEvent('.setcoc 2'),
      createTestContext({ ruleSet: 'dnd5e' }),
    );
    expect(decision.updates[0]).toMatchObject({
      type: 'conversation-settings',
      changes: { cocRule: '2', ruleSet: 'coc7' },
    });
  });

  it('reports sender and conversation identifiers separately', async () => {
    const decision = await executor.execute(createTestEvent('.userid'), createTestContext());
    expect(decision.results[0]?.data).toMatchObject({
      userExternalId: 'user_ext_1',
      conversationExternalId: 'group_ext_1',
      scene: 'groupAt',
    });
    expect(decision.replies[0]?.text).toContain('user_ext_1');
    expect(decision.replies[0]?.text).toContain('group_ext_1');
  });

  it('rejects unknown deck and DND race without state changes', async () => {
    const ctx = createTestContext();
    const deck = await executor.execute(createTestEvent('.draw definitely-missing'), ctx);
    expect(deck.results).toHaveLength(0);
    expect(deck.updates).toHaveLength(0);
    expect(deck.replies[0]?.templateKey).toBe('deck.not_found');

    const race = await executor.execute(createTestEvent('.namednd definitely-missing'), ctx);
    expect(race.results).toHaveLength(0);
    expect(race.updates).toHaveLength(0);
    expect(race.replies[0]?.templateKey).toBe('fun.namednd.unknown_race');
  });

  it('uses .deck as a draw-compatible entry and keeps resource operations truthful', async () => {
    const ctx = createTestContext();
    const draw = await executor.execute(createTestEvent('.deck fate'), ctx);
    expect(draw.results[0]).toMatchObject({
      kind: 'deck.draw',
      data: { deckId: 'fate' },
    });
    expect(draw.updates[0]).toMatchObject({ type: 'deck-session' });

    const search = await executor.execute(createTestEvent('.deck search 命运'), ctx);
    expect(search.results[0]).toMatchObject({
      kind: 'deck.search',
      data: {
        query: '命运',
        matches: expect.arrayContaining([expect.objectContaining({ deckId: 'fate' })]),
      },
    });

    const reload = await executor.execute(createTestEvent('.deck reload'), ctx);
    expect(reload.results).toHaveLength(0);
    expect(reload.updates).toHaveLength(0);
    expect(reload.replies[0]?.templateKey).toBe('deck.reload_unsupported');
  });

  it('rejects missing SAN, skill, HP, and MaxHP state', async () => {
    const blankSheet = createCharacterSheet({
      id: 'sheet_blank',
      ownerId: 'user_ext_1',

      ruleSet: 'coc7',
      name: '空白卡',
      attributes: {},
    });
    const cocCtx = createTestContext({}, { sheet: blankSheet });
    const sanity = await executor.execute(createTestEvent('.sc 1/1d6'), cocCtx);
    expect(sanity.results).toHaveLength(0);
    expect(sanity.replies[0]?.templateKey).toBe('coc.sc.missing_san');

    const growth = await executor.execute(createTestEvent('.en 侦查'), cocCtx);
    expect(growth.results).toHaveLength(0);
    expect(growth.replies[0]?.templateKey).toBe('coc.en.missing_skill');

    const dndCtx = createTestContext({ ruleSet: 'dnd5e' }, { sheet: blankSheet });
    const hp = await executor.execute(createTestEvent('.hp'), dndCtx);
    expect(hp.results).toHaveLength(0);
    expect(hp.replies[0]?.templateKey).toBe('dnd5e.hp.missing');

    const rest = await executor.execute(createTestEvent('.longrest'), dndCtx);
    expect(rest.results).toHaveLength(0);
    expect(rest.replies[0]?.templateKey).toBe('dnd5e.longrest.missing_max_hp');
  });
  it('manages mentioned-user moderation through group-scoped policy updates', async () => {
    const target = {
      scene: 'groupAt' as const,
      scopeId: 'group_ext_1',
      externalId: 'user_target',
      name: '目标用户',
    };
    const added = await executor.execute(
      { ...createTestEvent('.black add 刷屏'), mentions: [target] },
      createTestContext({}, { delegatePrincipals: [target], delegatePolicyEntries: {} }),
    );
    expect(added.updates[0]).toMatchObject({
      type: 'policy-entry',
      expectedVersion: 0,
      changes: {
        scope: 'group',
        scopeId: 'group_ext_1',
        principalId: 'user_target',
        effect: 'deny',
        reason: '刷屏',
      },
    });

    const existing = {
      id: 'policy_existing',
      scope: 'group' as const,
      principalId: 'principal_target',
      effect: 'deny' as const,
      reason: '旧原因',
      version: 2,
    };
    const removed = await executor.execute(
      { ...createTestEvent('.ban rm'), mentions: [target] },
      createTestContext(
        {},
        {
          delegatePrincipals: [target],
          delegatePolicyEntries: { user_target: existing },
        },
      ),
    );
    expect(removed.updates).toEqual([
      {
        type: 'policy-entry-delete',
        entryId: 'policy_existing',
        expectedVersion: 2,
      },
    ]);
  });

  it('rejects incompatible administration and noncore rules without side effects', async () => {
    const ctx = createTestContext();
    for (const command of ['.dismiss', '.botlist', '.master', '.randalgo', '.ext']) {
      const decision = await executor.execute(createTestEvent(command), ctx);
      expect(decision.updates).toHaveLength(0);
      expect(decision.replies[0]?.templateKey).toBe('system.unsupported');
    }
    for (const command of ['.rsr', '.ek', '.ekgen', '.dx', '.ww', '.jsr', '.drl']) {
      const decision = await executor.execute(createTestEvent(command), ctx);
      expect(decision.updates).toHaveLength(0);
      expect(decision.replies[0]?.templateKey).toBe('ruleset.unsupported');
    }
    for (const command of ['.send', '.reply', '.welcome', '.team']) {
      const decision = await executor.execute(createTestEvent(command), ctx);
      expect(decision.updates).toHaveLength(0);
      expect(decision.replies[0]?.templateKey).toBe('messaging.unsupported');
    }
  });

  it('rejects unknown ruleset values', async () => {
    const decision = await executor.execute(
      createTestEvent('.set rule imaginary'),
      createTestContext(),
    );
    expect(decision.results).toHaveLength(0);
    expect(decision.updates).toHaveLength(0);
    expect(decision.replies[0]?.templateKey).toBe('set.error');
  });
});

describe('COC7 daily command compatibility', () => {
  const executor = new CommandExecutor();
  const sheet = createCharacterSheet({
    id: 'sheet_coc_daily',
    ownerId: 'user_ext_1',
    ruleSet: 'coc7',
    name: '调查员',
    attributes: { 侦查: 65, 图书馆使用: 50, 理智: 60 },
  });

  it('parses difficulty, bonus dice, modifiers, reasons, and command-level repetitions', async () => {
    const difficult = await executor.execute(
      createTestEvent('.ra 困难侦查 潜行接近'),
      createTestContext({}, { sheet }, undefined, sequenceRandom([40])),
    );
    expect(difficult.results[0]?.data).toMatchObject({
      skill: { name: '侦查' },
      difficulty: 'hard',
      requiredLevel: 2,
      reason: '潜行接近',
      success: false,
      target: { value: 65 },
    });

    const bonus = await executor.execute(
      createTestEvent('.ra b 侦查'),
      createTestContext({}, { sheet }, undefined, sequenceRandom([5, 8, 4])),
    );
    expect(bonus.results[0]?.data).toMatchObject({
      bonusDice: 1,
      roll: { total: 45, values: [85, 45] },
    });

    const modified = await executor.execute(
      createTestEvent('.ra 侦查+10 观察门锁'),
      createTestContext({}, { sheet }, undefined, sequenceRandom([70])),
    );
    expect(modified.results[0]?.data).toMatchObject({
      modifier: 10,
      reason: '观察门锁',
      target: { value: 75 },
    });

    const repeated = await executor.execute(
      createTestEvent('.ra 3#p 侦查'),
      createTestContext({}, { sheet }, undefined, sequenceRandom([5, 1, 9, 5, 2, 8, 5, 3, 7])),
    );
    expect(repeated.results).toHaveLength(1);
    expect(repeated.results[0]?.data).toMatchObject({
      repeat: 3,
      bonusDice: -1,
      items: [{ bonusDice: -1 }, { bonusDice: -1 }, { bonusDice: -1 }],
    });
    expect(repeated.replies).toHaveLength(1);
  });

  it('forces rulebook checks for rc and validates the active card ruleset', async () => {
    const rc = await executor.execute(
      createTestEvent('.rc 侦查'),
      createTestContext({ cocRule: '3' }, { sheet }, undefined, sequenceRandom([2])),
    );
    expect(rc.results[0]?.data).toMatchObject({ ruleId: '0' });

    const dndSheet = createCharacterSheet({
      id: 'sheet_wrong_rule',
      ownerId: 'user_ext_1',
      ruleSet: 'dnd5e',
      name: '错误卡',
      attributes: { 侦查: 65 },
    });
    const mismatch = await executor.execute(
      createTestEvent('.ra 侦查'),
      createTestContext({}, { sheet: dndSheet }, undefined, sequenceRandom([20])),
    );
    expect(mismatch.results).toHaveLength(0);
    expect(mismatch.replies[0]?.templateKey).toBe('character.rule_mismatch');
  });

  it('delivers rah and rch results only through trusted hidden-roll bindings', async () => {
    const ctx = createTestContext(
      {},
      {
        sheet,
        hiddenRollBinding: {
          id: 'bind_1',
          groupScopeId: 'group_ext_1',
          groupPrincipalId: 'principal_group_1',
          c2cPrincipalId: 'principal_c2c_1',
          userOpenid: 'openid_c2c_1',
          activeMessagesEnabled: true,
          version: 1,
        },
      },
      undefined,
      sequenceRandom([30]),
    );
    const decision = await executor.execute(createTestEvent('.rah 侦查'), ctx);

    expect(decision.results[0]?.data).toMatchObject({ hidden: true });
    expect(decision.replies[0]).toMatchObject({
      scene: 'c2c',
      targetId: 'openid_c2c_1',
      deliveryMode: 'active',
    });
    expect(decision.replies[1]?.condition).toEqual({ part: 1, status: 'sent' });
    expect(decision.replies[2]?.condition).toEqual({ part: 1, status: 'failed' });
  });

  it('resolves opposed checks using success level then skill value', async () => {
    const decision = await executor.execute(
      createTestEvent('.rav 侦查65 潜行55'),
      createTestContext({}, { sheet }, undefined, sequenceRandom([40, 30])),
    );

    expect(decision.results[0]?.kind).toBe('coc.opposed');
    expect(decision.results[0]?.data).toMatchObject({
      left: { skill: '侦查', target: 65, roll: 40 },
      right: { skill: '潜行', target: 55, roll: 30 },
      winner: 'left',
    });
  });

  it('supports SAN bonus dice, explicit rolls, cap, half, and fumble loss', async () => {
    const adjusted = await executor.execute(
      createTestEvent('.sc b 1/1d6 --half --cap=2'),
      createTestContext({}, { sheet }, undefined, sequenceRandom([0, 9, 8, 6])),
    );
    expect(adjusted.results[0]?.data).toMatchObject({
      bonusDice: 1,
      roll: 80,
      sanLoss: 2,
      cap: 2,
      half: true,
    });

    const explicit = await executor.execute(
      createTestEvent('.sc 50 1/1d6'),
      createTestContext({}, { sheet }, undefined, sequenceRandom([4])),
    );
    expect(explicit.results[0]?.data).toMatchObject({ roll: 50, sanLoss: 1 });

    const fumble = await executor.execute(
      createTestEvent('.sc 1/1d6'),
      createTestContext({}, { sheet }, undefined, sequenceRandom([100])),
    );
    expect(fumble.results[0]?.data).toMatchObject({ roll: 100, sanLoss: 6 });
  });

  it('advances multiple skills and applies separate failure and success increments', async () => {
    const batch = await executor.execute(
      createTestEvent('.en 侦查 图书馆使用'),
      createTestContext({}, { sheet }, undefined, sequenceRandom([96, 4, 97, 5])),
    );
    expect(batch.results[0]?.data).toMatchObject({
      items: [
        { skill: '侦查', oldValue: 65, newValue: 69, increment: 4, success: true },
        { skill: '图书馆使用', oldValue: 50, newValue: 55, increment: 5, success: true },
      ],
    });
    expect(batch.updates[0]).toMatchObject({
      type: 'character-sheet',
      changes: {
        attributes: expect.objectContaining({ 侦查: 69, 图书馆使用: 55 }),
      },
    });

    const failureIncrement = await executor.execute(
      createTestEvent('.en侦查60 +1/1d10'),
      createTestContext({}, { sheet }, undefined, sequenceRandom([20])),
    );
    expect(failureIncrement.results[0]?.data).toMatchObject({
      items: [{ skill: '侦查', oldValue: 60, newValue: 61, increment: 1, success: false }],
    });
  });

  it('uses the mentioned participant card for delegated checks', async () => {
    const delegatedSheet = createCharacterSheet({
      id: 'sheet_coc_delegate',
      ownerId: 'principal_delegate',
      ruleSet: 'coc7',
      name: '受托调查员',
      attributes: { 侦查: 70 },
    });
    const event: VerifiedEvent = {
      ...createTestEvent('.ra <@delegate_openid> 侦查'),
      mentions: [
        {
          scene: 'groupAt',
          scopeId: 'group_ext_1',
          externalId: 'delegate_openid',
          name: '受托玩家',
        },
      ],
    };
    const decision = await executor.execute(
      event,
      createTestContext(
        {},
        { delegateSheets: { delegate_openid: delegatedSheet } },
        undefined,
        sequenceRandom([45]),
      ),
    );

    expect(decision.results[0]?.data).toMatchObject({
      actor: '受托调查员',
      skill: { name: '侦查' },
      target: { value: 70 },
      roll: { total: 45 },
    });
  });
});
