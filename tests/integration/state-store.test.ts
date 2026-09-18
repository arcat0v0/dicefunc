import { env } from 'cloudflare:test';
import { D1StateStore } from '@dicefunc/adapters';
import type { CommandCommit, VerifiedEvent } from '@dicefunc/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyInitialSchema } from './helper.js';

describe('D1StateStore integration', () => {
  let store: D1StateStore;

  beforeAll(async () => {
    await applyInitialSchema(env.DB);
    store = new D1StateStore(env.DB);
  });

  it('ensures claimEvent is idempotent with unchanged sequence and single row', async () => {
    const event: VerifiedEvent = {
      botId: 'bot_test_1',
      scene: 'groupAt',
      eventId: 'evt_idempotent_1',
      messageId: 'msg_idempotent_1',
      externalId: 'group_idem_1',
      timestamp: new Date(),
      text: '.r 1d100',
      sender: {
        scene: 'groupAt',
        scopeId: 'group_idem_1',
        externalId: 'user_idem_1',
      },
    };

    const claim1 = await store.claimEvent(event, 'digest_test_1');
    expect(claim1.alreadyProcessed).toBe(false);
    expect(claim1.conversationSeq).toBe(1);

    const claim2 = await store.claimEvent(event, 'digest_test_1');
    expect(claim2.alreadyProcessed).toBe(true);
    expect(claim2.conversationSeq).toBe(1);

    const eventRows = await env.DB.prepare(
      'SELECT count(*) as count FROM received_events WHERE bot_id = ? AND event_id = ?',
    )
      .bind('bot_test_1', 'evt_idempotent_1')
      .first<{ count: number }>();
    expect(eventRows?.count).toBe(1);

    const convRow = await env.DB.prepare(
      'SELECT receive_seq FROM conversations WHERE bot_id = ? AND scene = ? AND external_id = ?',
    )
      .bind('bot_test_1', 'groupAt', 'group_idem_1')
      .first<{ receive_seq: number }>();
    expect(convRow?.receive_seq).toBe(1);
  });

  it('rolls back entire batch when commit guard fails on version conflict', async () => {
    const event: VerifiedEvent = {
      botId: 'bot_test_2',
      scene: 'groupAt',
      eventId: 'evt_conflict_1',
      messageId: 'msg_conflict_1',
      externalId: 'group_conflict_1',
      timestamp: new Date(),
      text: '.set rule dnd5e',
      sender: {
        scene: 'groupAt',
        scopeId: 'group_conflict_1',
        externalId: 'user_conflict_1',
      },
    };

    const claim = await store.claimEvent(event, 'digest_test_2');

    const failingCommit: CommandCommit = {
      transactionId: 'tx_conflict_1',
      eventId: claim.eventId,
      executionId: 'exec_conflict_1',
      botId: 'bot_test_2',
      conversationId: claim.conversationId,
      conversationSeq: claim.conversationSeq,
      lease: null,
      updates: [
        {
          type: 'conversation-settings',
          conversationId: claim.conversationId,
          expectedVersion: 999,
          changes: { ruleSet: 'dnd5e' },
          newVersion: 1000,
        },
        {
          type: 'character-sheet',
          sheetId: 'sheet_rollback_test',
          expectedVersion: 1,
          changes: {
            name: 'Hero Character',
            attributes: { STR: 18 },
          },
          newVersion: 2,
        },
      ],
      results: [],
      replies: [],
      logItems: [],
      completeEvent: false,
    };

    const outcome = await store.commit(failingCommit);
    expect(outcome.success).toBe(false);
    expect(outcome.conflict).toBe(true);

    const sheetRows = await env.DB.prepare(
      'SELECT count(*) as count FROM character_sheets WHERE id = ?',
    )
      .bind('sheet_rollback_test')
      .first<{ count: number }>();
    expect(sheetRows?.count).toBe(0);
  });

  it('successfully commits valid updates and returns updatedVersions', async () => {
    const event: VerifiedEvent = {
      botId: 'bot_test_3',
      scene: 'groupAt',
      eventId: 'evt_valid_1',
      messageId: 'msg_valid_1',
      externalId: 'group_valid_1',
      timestamp: new Date(),
      text: '.set sides 20',
      sender: {
        scene: 'groupAt',
        scopeId: 'group_valid_1',
        externalId: 'user_valid_1',
      },
    };

    const claim = await store.claimEvent(event, 'digest_test_3');

    const validCommit: CommandCommit = {
      transactionId: 'tx_valid_1',
      eventId: claim.eventId,
      executionId: 'exec_valid_1',
      botId: 'bot_test_3',
      conversationId: claim.conversationId,
      conversationSeq: claim.conversationSeq,
      lease: null,
      updates: [
        {
          type: 'conversation-settings',
          conversationId: claim.conversationId,
          expectedVersion: 1,
          changes: { diceSides: 20 },
          newVersion: 2,
        },
      ],
      results: [],
      replies: [],
      logItems: [],
      completeEvent: true,
    };

    const outcome = await store.commit(validCommit);
    expect(outcome.success).toBe(true);
    expect(outcome.conflict).toBe(false);
    expect(outcome.updatedVersions[claim.conversationId]).toBe(2);

    const convRow = await env.DB.prepare(
      'SELECT dice_sides, version FROM conversations WHERE id = ?',
    )
      .bind(claim.conversationId)
      .first<{ dice_sides: number; version: number }>();
    expect(convRow?.dice_sides).toBe(20);
    expect(convRow?.version).toBe(2);
  });
});
