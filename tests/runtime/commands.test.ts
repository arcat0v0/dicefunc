import {
  CommandConflictError,
  type CommandContext,
  type CommandDecision,
  CommandExecutor,
  type ConversationSession,
  DefaultCommandRegistry,
  type StateSnapshot,
  type VerifiedEvent,
  createConversationSession,
  createDefaultCommandRegistry,
  createWebCryptoRandomSource,
  systemClock,
} from '@dicefunc/core';
import { describe, expect, it } from 'vitest';

function createTestContext(
  conversationOverrides: Partial<ConversationSession> = {},
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
    characterSheets: [],
    characterBindings: [],
    deckSessions: [],
    encounters: [],
    policyEntries: [],
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
