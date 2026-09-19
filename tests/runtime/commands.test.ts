import {
  CommandConflictError,
  type CommandContext,
  type CommandDecision,
  CommandExecutor,
  type ConversationSession,
  DefaultCommandRegistry,
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
