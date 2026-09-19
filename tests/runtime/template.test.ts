import {
  DefaultEventHandler,
  TemplateRenderer,
  createClassicTemplates,
  createConversationSession,
  createDefaultCommandRegistry,
  createWebCryptoRandomSource,
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

  it('renders classic templates in DefaultEventHandler pipeline', async () => {
    const mockStore = new MockStateStore();
    const renderer = new TemplateRenderer(createClassicTemplates());
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
      text: '.r 1d20',
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
    expect(reply?.text).toContain('掷骰');
  });
});
