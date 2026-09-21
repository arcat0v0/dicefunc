import {
  DefaultEventHandler,
  TemplateRenderer,
  createCharacterSheet,
  createConversationSession,
  createDefaultCommandRegistry,
  createWebCryptoRandomSource,
  createZhCNTemplates,
  systemClock,
} from '@dicefunc/core';
import type {
  CommandCommit,
  CommandScope,
  EventClaim,
  StateSnapshot,
  StateStore,
  VerifiedEvent,
} from '@dicefunc/core';
import { describe, expect, it } from 'vitest';

class MockStateStore implements StateStore {
  public committed: CommandCommit | undefined;
  constructor(private readonly sheet?: StateSnapshot['sheet']) {}

  async claimEvent(event: VerifiedEvent, _configDigest: string): Promise<EventClaim> {
    return {
      eventId: event.eventId,
      messageKey: 'msg_1',
      conversationId: 'conv_1',
      conversationSeq: 1,
      seed: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      jobId: 'job_1',
      status: 'claimed',
      alreadyProcessed: false,
    };
  }

  async loadSnapshot(scope: CommandScope): Promise<StateSnapshot> {
    const conv = createConversationSession({
      id: 'conv_1',
      botId: scope.botId,
      scene: scope.scene,
      externalId: scope.externalId,
    });
    return {
      conversation: conv,
      permissions: { isDiceMaster: true, isGroupHost: true, isTrusted: true, denied: false },
      recentlyUpdatedVersions: {},
      ...(this.sheet ? { sheet: this.sheet } : {}),
    };
  }

  async commit(commit: CommandCommit): Promise<{ success: boolean; conflict?: boolean }> {
    this.committed = commit;
    return { success: true };
  }
}

describe('TemplateRenderer', () => {
  it('interpolates nested variables and simple variables', async () => {
    const renderer = new TemplateRenderer({
      'test.greeting': {
        variants: [
          {
            id: 'v1',
            weight: 1,
            text: 'Hello {{user.name}}! Score: {{score}}, Unknown: [{{unknown.field}}]',
          },
        ],
      },
    });

    const res = await renderer.render('test.greeting', {
      user: { name: 'Alice' },
      score: 100,
    });

    expect(res.text).toBe('Hello Alice! Score: 100, Unknown: []');
    expect(res.variantId).toBe('v1');
  });

  it('selects variant based on random source', async () => {
    const renderer = new TemplateRenderer({
      'test.variants': {
        variants: [
          { id: 'v1', weight: 1, text: 'First' },
          { id: 'v2', weight: 3, text: 'Second' },
        ],
      },
    });

    const deterministicRandom = {
      async integer(min: number, max: number): Promise<number> {
        return 1;
      },
      async float(): Promise<number> {
        return 0;
      },
    };

    const res1 = await renderer.render('test.variants', {}, deterministicRandom);
    expect(res1.variantId).toBe('v1');
    expect(res1.text).toBe('First');

    const deterministicRandom2 = {
      async integer(min: number, max: number): Promise<number> {
        return 3;
      },
      async float(): Promise<number> {
        return 0.5;
      },
    };

    const res2 = await renderer.render('test.variants', {}, deterministicRandom2);
    expect(res2.variantId).toBe('v2');
    expect(res2.text).toBe('Second');
  });

  it('keeps the authoritative COC outcome instead of randomizing failure severity', async () => {
    const renderer = new TemplateRenderer(createZhCNTemplates());
    const summary = [
      '调查员进行「力量」检定',
      '骰点：D100 = 62',
      '目标值：55',
      '要求：常规成功',
      '结果：失败（未通过）',
    ].join('\n');
    const rendered = await renderer.render(
      'coc.check.failed',
      {
        summary,
        actor: { name: '调查员' },
        skill: { name: '力量' },
        roll: { total: 62 },
        target: { value: 55 },
      },
      {
        async integer(_minInclusive: number, maxInclusive: number): Promise<number> {
          return maxInclusive;
        },
        async bytes(length: number): Promise<Uint8Array> {
          return new Uint8Array(length);
        },
      },
    );

    expect(rendered.variantId).toBe('detailed');
    expect(rendered.text).toBe(summary);
    expect(rendered.text).not.toContain('大失败');
  });

  it('preserves the detailed COC reply through the event handling pipeline', async () => {
    const sheet = createCharacterSheet({
      id: 'sheet_coc',
      ownerId: 'user_1',
      ruleSet: 'coc7',
      name: '调查员',
      attributes: { 力量: 55 },
    });
    const mockStore = new MockStateStore(sheet);
    const handler = new DefaultEventHandler(
      mockStore,
      undefined,
      systemClock,
      'test-digest',
      new TemplateRenderer(createZhCNTemplates()),
    );
    const event: VerifiedEvent = {
      eventId: 'evt_coc_check',
      botId: 'bot_test',
      scene: 'groupAt',
      externalId: 'group_1',
      messageId: 'msg_coc_check',
      timestamp: new Date(),
      sender: {
        type: 'groupMember',
        externalId: 'user_1',
        name: '群成员',
      },
      text: '。ra力量',
      rawPayload: {},
    };

    const result = await handler.handle(event);

    expect(result.success).toBe(true);
    const text = mockStore.committed?.replies[0]?.text ?? '';
    expect(text).toContain('调查员进行「力量」检定');
    expect(text).toMatch(/骰点：D100 = \d+/);
    expect(text).toContain('目标值：55');
    expect(text).toContain('要求：常规成功');
    expect(text).toMatch(/结果：(大成功|极难成功|困难成功|常规成功|失败|大失败)/);
    expect(text).not.toContain('规则：');
  });

  it('renders classic templates in DefaultEventHandler pipeline', async () => {
    const mockStore = new MockStateStore();
    const renderer = new TemplateRenderer(createZhCNTemplates());
    const handler = new DefaultEventHandler(
      mockStore,
      undefined,
      systemClock,
      'test-digest',
      renderer,
    );

    const event: VerifiedEvent = {
      eventId: 'evt_roll',
      botId: 'bot_test',
      scene: 'groupAt',
      externalId: 'group_1',
      messageId: 'msg_1',
      timestamp: new Date(),
      sender: {
        type: 'groupMember',
        externalId: 'user_1',
        name: '张三',
      },
      text: '.r 1d100+2d6',
      rawPayload: {},
    };

    const result = await handler.handle(event);
    expect(result.success).toBe(true);
    expect(mockStore.committed).toBeDefined();
    const replies = mockStore.committed?.replies ?? [];
    expect(replies.length).toBeGreaterThan(0);
    const reply = replies[0];
    expect(reply?.templateKey).toBe('dice.roll');
    expect(reply?.variantId).toBeDefined();
    expect(reply?.text).toMatch(/张三 掷骰: 1d100\+2d6 = \[\d+\] \+ \[\d+, \d+\] = \d+/);
  });
});
