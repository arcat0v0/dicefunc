import {
  CommandConflictError,
  type CommandContext,
  type CommandDecision,
  CommandExecutor,
  type ConversationSession,
  DefaultCommandRegistry,
  type HiddenRollLinkReader,
  type StateSnapshot,
  type VerifiedEvent,
  createCharacterSheet,
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
    random: createWebCryptoRandomSource(),
    clock: systemClock,
    permissions: {
      isGroupHost: true,
      isDiceMaster: true,
      denied: false,
      trusted: true,
    },
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

  it('provides command overview on .help', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.help'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('help');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('DiceFunc Commands');
  });

  it('provides user and scene identifiers on .userid', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.userid'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('userid');
    expect(decision.replies).toHaveLength(1);
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
      expect(update.changes.attributes).toEqual({ 力量: 65, HP: 12 });
      expect(update.newVersion).toBe(2);
    }
    expect(decision.replies[0]?.text).toContain('力量: 65');
    expect(decision.replies[0]?.text).toContain('HP: 12');
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

    expect(decision.updates).toHaveLength(1);
    const logUpdate = decision.updates[0];
    expect(logUpdate?.type).toBe('story-log');
    if (logUpdate?.type === 'story-log') {
      expect(logUpdate.changes.status).toBe('closed');
    }
    expect(decision.replies[0]?.text).toContain('已关闭');
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
    expect(decision.replies[0]?.text).toMatch(/1D100\s*=\s*\d+/);
    expect(decision.replies[0]?.text).toContain('60');
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

  it('refuses a bound group roll after active-message authorization is disabled', async () => {
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

    expect(decision.results).toHaveLength(0);
    expect(ctx.budget.consumed.diceRolls).toBe(0);
    expect(decision.replies[0]?.templateKey).toBe('dice.hidden.authorization_required');
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

  it('requires active-message authorization before issuing a private token', async () => {
    const ctx = createTestContext(
      { scene: 'c2c', externalId: 'user_ext_1' },
      { principalId: 'c2c_principal_1', c2cActiveMessagesEnabled: false },
    );
    const decision = await executor.execute(createC2cTestEvent('.rhbind'), ctx);

    expect(decision.updates).toHaveLength(0);
    expect(decision.replies[0]?.templateKey).toBe('dice.hidden.binding.authorization_required');
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

  it('consumes a private token to bind the current group principal', async () => {
    const token = 'A'.repeat(43);
    const hiddenRollLinks: HiddenRollLinkReader = {
      findHiddenRollLinkChallenge: async () => ({
        id: 'challenge_1',
        c2cPrincipalId: 'c2c_principal_1',
        userOpenid: 'user_c2c_1',
        version: 1,
        expiresAt: new Date(Date.now() + 600_000),
        activeMessagesEnabled: true,
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

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('理智检定指令：');
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
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('爱德华 的理智检定:');
    expect(decision.replies[0]?.text).toContain('理智变化: 60 ➯');
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

    expect(decision.replies[0]?.text).toContain('临时性疯狂');
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

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('技能成长指令：');
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
      const hp = update.changes.attributes?.HP;
      expect(hp).toBeGreaterThanOrEqual(11);
      expect(hp).toBeLessThanOrEqual(14);
    }
    expect(decision.replies[0]?.text).toContain('HP:');
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
    const ctx = createTestContext({}, { sheet });
    const decision = await executor.execute(createTestEvent('.pc save 战斗卡'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('character.save');
    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('character-sheet');
    if (update?.type === 'character-sheet') {
      expect(update.changes.name).toBe('战斗卡');
      expect(update.changes.attributes).toEqual({ 力量: 50 });
    }
    expect(decision.replies[0]?.text).toContain('已保存角色卡「战斗卡」');
  });

  it('binds saved character on .pc load <name>', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.pc load 战斗卡'), ctx);

    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.kind).toBe('character.load');
    expect(decision.updates).toHaveLength(1);
    const update = decision.updates[0];
    expect(update?.type).toBe('character-binding');
    expect(decision.replies[0]?.text).toContain('已将当前会话绑定至角色卡「战斗卡」');
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
});
