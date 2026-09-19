import {
  type CommandContext,
  CommandExecutor,
  type ConversationSession,
  type CustomReplyRule,
  type StateSnapshot,
  type VerifiedEvent,
  createConversationSession,
  createWebCryptoRandomSource,
  getBuiltinDeck,
  listBuiltinDecks,
  systemClock,
} from '@dicefunc/core';
import { describe, expect, it } from 'vitest';

function createTestContext(
  conversationOverrides: Partial<ConversationSession> = {},
  snapshotOverrides: Partial<StateSnapshot> = {},
): CommandContext {
  const baseConversation = createConversationSession({
    id: 'conv_deck_1',
    botId: 'bot_test_1',
    scene: 'groupAt',
    externalId: 'group_deck_1',
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
    eventId: 'evt_deck_1',
    messageId: 'msg_deck_1',
    externalId: 'group_deck_1',
    timestamp: new Date(),
    text,
    sender: {
      scene: 'groupAt',
      scopeId: 'group_deck_1',
      externalId: 'user_deck_1',
    },
  };
}

describe('Deck commands (.draw, .deck)', () => {
  const executor = new CommandExecutor();

  it('provides built-in decks tarot and fate', () => {
    const decks = listBuiltinDecks();
    expect(decks.length).toBeGreaterThanOrEqual(2);

    const tarot = getBuiltinDeck('tarot');
    expect(tarot).toBeDefined();
    expect(tarot?.cards.length).toBe(22);

    const fate = getBuiltinDeck('fate');
    expect(fate).toBeDefined();
    expect(fate?.cards.length).toBe(7);
  });

  it('draws card from default tarot deck on .draw', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.draw'), ctx);

    expect(decision.updates).toHaveLength(1);
    const sessionUpdate = decision.updates[0];
    expect(sessionUpdate?.type).toBe('deck-session');
    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('塔罗牌');
    expect(decision.replies[0]?.text).toContain('剩余: 21 张');
  });

  it('draws multiple cards on .draw 2', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.draw 2'), ctx);

    expect(decision.updates).toHaveLength(1);
    const sessionUpdate = decision.updates[0];
    expect(sessionUpdate?.type).toBe('deck-session');
    expect(decision.replies[0]?.text).toContain('剩余: 20 张');
  });

  it('draws from specified deck on .draw fate', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.draw fate'), ctx);

    expect(decision.updates).toHaveLength(1);
    const sessionUpdate = decision.updates[0];
    expect(sessionUpdate?.type).toBe('deck-session');
    expect(decision.replies[0]?.text).toContain('命运签');
    expect(decision.replies[0]?.text).toContain('剩余: 6 张');
  });

  it('resets deck on .deck reset', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.deck reset tarot'), ctx);

    expect(decision.updates).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('已重置洗牌');
    expect(decision.replies[0]?.text).toContain('22 张');
  });

  it('lists available decks on .deck list', async () => {
    const ctx = createTestContext();
    const decision = await executor.execute(createTestEvent('.deck list'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toContain('tarot');
    expect(decision.replies[0]?.text).toContain('fate');
  });
});

describe('Custom reply pipeline', () => {
  const testRules: readonly CustomReplyRule[] = [
    {
      id: 'greeting_exact',
      enabled: true,
      priority: 100,
      match: { exact: '你好' },
      action: { text: '你好！我是 DiceFunc 跑团机器人。' },
    },
    {
      id: 'help_contains',
      enabled: true,
      priority: 50,
      match: { contains: '怎么使用' },
      action: { text: '请使用 .help 查看命令帮助。' },
    },
    {
      id: 'c2c_only',
      enabled: true,
      priority: 80,
      scenes: ['c2c'],
      match: { exact: '私聊测试' },
      action: { text: '私聊通道正常！' },
    },
  ];

  const executorWithRules = new CommandExecutor(undefined, testRules);

  it('matches exact text and replies without command prefix', async () => {
    const ctx = createTestContext();
    const decision = await executorWithRules.execute(createTestEvent('你好'), ctx);

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toBe('你好！我是 DiceFunc 跑团机器人。');
    expect(decision.results[0]?.kind).toBe('custom.reply');
  });

  it('matches contains text', async () => {
    const ctx = createTestContext();
    const decision = await executorWithRules.execute(
      createTestEvent('请问这个骰娘怎么使用啊'),
      ctx,
    );

    expect(decision.replies).toHaveLength(1);
    expect(decision.replies[0]?.text).toBe('请使用 .help 查看命令帮助。');
  });

  it('respects scenes restriction', async () => {
    const ctx = createTestContext();
    const groupDecision = await executorWithRules.execute(createTestEvent('私聊测试'), ctx);
    expect(groupDecision.replies).toHaveLength(0);

    const c2cEvent: VerifiedEvent = {
      ...createTestEvent('私聊测试'),
      scene: 'c2c',
    };
    const c2cDecision = await executorWithRules.execute(c2cEvent, ctx);
    expect(c2cDecision.replies).toHaveLength(1);
    expect(c2cDecision.replies[0]?.text).toBe('私聊通道正常！');
  });
});
