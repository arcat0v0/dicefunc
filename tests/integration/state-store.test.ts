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

  it('resolves isGroupHost correctly based on principal role and scene', async () => {
    const ownerSnapshot = await store.loadSnapshot({
      botId: 'bot_perm_test',
      scene: 'groupAt',
      externalId: 'group_perm_1',
      principal: {
        scene: 'groupAt',
        scopeId: 'group_perm_1',
        externalId: 'user_owner',
        role: 'owner',
      },
    });
    expect(ownerSnapshot.permissions.isGroupHost).toBe(true);

    const adminSnapshot = await store.loadSnapshot({
      botId: 'bot_perm_test',
      scene: 'groupAt',
      externalId: 'group_perm_1',
      principal: {
        scene: 'groupAt',
        scopeId: 'group_perm_1',
        externalId: 'user_admin',
        role: 'admin',
      },
    });
    expect(adminSnapshot.permissions.isGroupHost).toBe(true);

    const memberSnapshot = await store.loadSnapshot({
      botId: 'bot_perm_test',
      scene: 'groupAt',
      externalId: 'group_perm_1',
      principal: {
        scene: 'groupAt',
        scopeId: 'group_perm_1',
        externalId: 'user_member',
        role: 'member',
      },
    });
    expect(memberSnapshot.permissions.isGroupHost).toBe(false);

    const c2cSnapshot = await store.loadSnapshot({
      botId: 'bot_perm_test',
      scene: 'c2c',
      externalId: 'user_c2c',
      principal: {
        scene: 'c2c',
        scopeId: 'user_c2c',
        externalId: 'user_c2c',
      },
    });
    expect(c2cSnapshot.permissions.isGroupHost).toBe(true);
  });

  it('loads bound cards for mentioned group participants', async () => {
    const senderScope = {
      botId: 'bot_delegate_test',
      scene: 'groupAt' as const,
      externalId: 'group_delegate_test',
      principal: {
        scene: 'groupAt' as const,
        scopeId: 'group_delegate_test',
        externalId: 'sender_delegate_test',
      },
    };
    const delegatePrincipal = {
      scene: 'groupAt' as const,
      scopeId: 'group_delegate_test',
      externalId: 'delegate_test',
      name: 'Delegate',
    };
    await store.claimEvent(
      {
        botId: senderScope.botId,
        scene: senderScope.scene,
        eventId: 'evt_delegate_test',
        messageId: 'msg_delegate_test',
        externalId: senderScope.externalId,
        timestamp: new Date(),
        text: '.ra <@delegate_test> 侦查',
        sender: senderScope.principal,
        mentions: [delegatePrincipal],
      },
      'digest_delegate_test',
    );
    const senderSnapshot = await store.loadSnapshot(senderScope);
    const delegateSnapshot = await store.loadSnapshot({
      ...senderScope,
      principal: delegatePrincipal,
    });
    const delegatePrincipalId = delegateSnapshot.principalId;
    if (!delegatePrincipalId) {
      throw new Error('Delegate principal was not created');
    }
    await env.DB.batch([
      env.DB.prepare(`
          INSERT INTO character_sheets (
            id, bot_id, owner_principal, rule_set, name, attributes
          ) VALUES (?1, ?2, ?3, 'coc7', '受托调查员', '{"侦查":70}')
        `).bind('sheet_delegate_test', senderScope.botId, delegatePrincipalId),
      env.DB.prepare(`
          INSERT INTO character_bindings (
            id, bot_id, conversation_id, principal_id, sheet_id
          ) VALUES (?1, ?2, ?3, ?4, ?5)
        `).bind(
        'binding_delegate_test',
        senderScope.botId,
        senderSnapshot.conversation.id,
        delegatePrincipalId,
        'sheet_delegate_test',
      ),
    ]);

    const snapshot = await store.loadSnapshot({
      ...senderScope,
      delegates: [delegatePrincipal],
    });

    expect(snapshot.delegateSheets?.delegate_test).toMatchObject({
      id: 'sheet_delegate_test',
      ownerId: delegatePrincipalId,
      ruleSet: 'coc7',
      name: '受托调查员',
      attributes: { 侦查: 70 },
    });
    const delegateLibrary = await store.loadSnapshot({
      ...senderScope,
      principal: delegatePrincipal,
    });
    expect(delegateLibrary.ownedSheets).toEqual([
      expect.objectContaining({
        id: 'sheet_delegate_test',
        ownerId: delegatePrincipalId,
      }),
    ]);
  });

  it('deletes only an owned version-matched character and its bindings', async () => {
    const event: VerifiedEvent = {
      botId: 'bot_character_delete',
      scene: 'groupAt',
      eventId: 'evt_character_delete',
      messageId: 'msg_character_delete',
      externalId: 'group_character_delete',
      timestamp: new Date(),
      text: '.pc del 旧卡',
      sender: {
        scene: 'groupAt',
        scopeId: 'group_character_delete',
        externalId: 'user_character_delete',
      },
    };
    const claim = await store.claimEvent(event, 'digest_character_delete');
    const snapshot = await store.loadSnapshot({
      botId: event.botId,
      scene: event.scene,
      externalId: event.externalId,
      principal: event.sender,
    });
    const principalId = snapshot.principalId;
    if (!principalId) {
      throw new Error('Principal was not created');
    }
    await env.DB.batch([
      env.DB.prepare(`
          INSERT INTO character_sheets (
            id, bot_id, owner_principal, rule_set, name, attributes, version
          ) VALUES ('sheet_character_delete', ?1, ?2, 'coc7', '旧卡', '{}', 3)
        `).bind(event.botId, principalId),
      env.DB.prepare(`
          INSERT INTO character_bindings (
            id, bot_id, conversation_id, principal_id, sheet_id
          ) VALUES ('binding_character_delete', ?1, ?2, ?3, 'sheet_character_delete')
        `).bind(event.botId, claim.conversationId, principalId),
    ]);

    const outcome = await store.commit({
      transactionId: 'tx_character_delete',
      eventId: claim.eventId,
      executionId: 'exec_character_delete',
      botId: event.botId,
      conversationId: claim.conversationId,
      conversationSeq: claim.conversationSeq,
      lease: null,
      updates: [
        {
          type: 'character-sheet-delete',
          sheetId: 'sheet_character_delete',
          ownerPrincipal: principalId,
          expectedVersion: 3,
        },
      ],
      results: [],
      replies: [],
      logItems: [],
      completeEvent: false,
    });

    expect(outcome.success).toBe(true);
    const rows = await env.DB.prepare(
      `SELECT
         (SELECT count(*) FROM character_sheets WHERE id = 'sheet_character_delete') AS sheets,
         (SELECT count(*) FROM character_bindings WHERE sheet_id = 'sheet_character_delete') AS bindings`,
    ).first<{ sheets: number; bindings: number }>();
    expect(rows).toEqual({ sheets: 0, bindings: 0 });
  });

  it('loads log history and atomically begins archive deletion', async () => {
    const event: VerifiedEvent = {
      botId: 'bot_log_delete',
      scene: 'groupAt',
      eventId: 'evt_log_delete',
      messageId: 'msg_log_delete',
      externalId: 'group_log_delete',
      timestamp: new Date(),
      text: '.log del old',
      sender: {
        scene: 'groupAt',
        scopeId: 'group_log_delete',
        externalId: 'user_log_delete',
      },
    };
    const claim = await store.claimEvent(event, 'digest_log_delete');
    await env.DB.batch([
      env.DB.prepare(`
          INSERT INTO story_logs (
            id, bot_id, conversation_id, name, status, revision, cursor
          ) VALUES ('log_delete', ?1, ?2, 'old', 'closed', 4, 2)
        `).bind(event.botId, claim.conversationId),
      env.DB.prepare(`
          INSERT INTO story_log_items (
            id, bot_id, log_id, sequence_number, sequence_part, direction,
            source_id, text, is_dice, delivery_status
          ) VALUES
            ('log_delete_item_1', ?1, 'log_delete', 1, 0, 'inbound', 'source_1', 'text_1', 0, 'sent'),
            ('log_delete_item_2', ?1, 'log_delete', 2, 0, 'outbound', 'source_2', 'text_2', 1, 'sent')
        `).bind(event.botId),
      env.DB.prepare(`
          INSERT INTO log_archives (
            id, bot_id, log_id, snapshot_cursor, format, object_key,
            digest, status, deletion_status
          ) VALUES (
            'archive_log_delete', ?1, 'log_delete', 2, 'txt',
            'archives/log_delete.manifest.json', 'digest', 'ready', 'none'
          )
        `).bind(event.botId),
      env.DB.prepare(`
          INSERT INTO archive_grants (
            token_hash, bot_id, archive_id, scope, expires_at
          ) VALUES (
            'token_log_delete', ?1, 'archive_log_delete', 'archive:read',
            datetime('now', '+1 hour')
          )
        `).bind(event.botId),
    ]);

    const snapshot = await store.loadSnapshot({
      botId: event.botId,
      scene: event.scene,
      externalId: event.externalId,
      principal: event.sender,
    });
    expect(snapshot.storyLogs).toEqual([
      expect.objectContaining({
        id: 'log_delete',
        name: 'old',
        itemCount: 2,
        rollCount: 1,
        archive: { id: 'archive_log_delete', status: 'ready' },
      }),
    ]);

    const outcome = await store.commit({
      transactionId: 'tx_log_delete',
      eventId: claim.eventId,
      executionId: 'exec_log_delete',
      botId: event.botId,
      conversationId: claim.conversationId,
      conversationSeq: claim.conversationSeq,
      lease: null,
      updates: [
        {
          type: 'story-log-delete',
          logId: 'log_delete',
          expectedVersion: 4,
          newVersion: 5,
          jobId: 'job_delete_log_evt_log_delete',
        },
      ],
      results: [],
      replies: [],
      logItems: [],
      completeEvent: false,
    });
    expect(outcome.success).toBe(true);

    const state = await env.DB.prepare(`
      SELECT
        (SELECT status FROM story_logs WHERE id = 'log_delete') AS log_status,
        (SELECT deletion_status FROM log_archives WHERE id = 'archive_log_delete') AS deletion_status,
        (SELECT revoked_at IS NOT NULL FROM archive_grants WHERE token_hash = 'token_log_delete') AS revoked,
        (SELECT type FROM jobs WHERE id = 'job_delete_log_evt_log_delete') AS job_type
    `).first<{
      log_status: string;
      deletion_status: string;
      revoked: number;
      job_type: string;
    }>();
    expect(state).toEqual({
      log_status: 'deleting',
      deletion_status: 'deleting',
      revoked: 1,
      job_type: 'archive-delete',
    });
  });

  it('persists and removes group-scoped mentioned-user policies', async () => {
    const target = {
      scene: 'groupAt' as const,
      scopeId: 'group_policy',
      externalId: 'user_policy_target',
      name: '目标用户',
    };
    const event: VerifiedEvent = {
      botId: 'bot_policy',
      scene: 'groupAt',
      eventId: 'evt_policy',
      messageId: 'msg_policy',
      externalId: 'group_policy',
      timestamp: new Date(),
      text: '.black add',
      sender: {
        scene: 'groupAt',
        scopeId: 'group_policy',
        externalId: 'user_policy_owner',
        role: 'owner',
      },
      mentions: [target],
    };
    const claim = await store.claimEvent(event, 'digest_policy');
    await env.DB.prepare(`
      INSERT INTO principals (
        id, bot_id, scene, scope_id, external_id, version
      ) VALUES (
        'principal_policy_target', ?1, 'groupAt', 'group_policy', 'user_policy_target', 1
      )
    `)
      .bind(event.botId)
      .run();

    const created = await store.commit({
      transactionId: 'tx_policy_create',
      eventId: claim.eventId,
      executionId: 'exec_policy_create',
      botId: event.botId,
      conversationId: claim.conversationId,
      conversationSeq: claim.conversationSeq,
      lease: null,
      updates: [
        {
          type: 'policy-entry',
          entryId: 'policy_group_target',
          expectedVersion: 0,
          changes: {
            scope: 'group',
            scopeId: 'group_policy',
            principalId: 'user_policy_target',
            effect: 'deny',
            reason: '刷屏',
          },
          newVersion: 1,
        },
      ],
      results: [],
      replies: [],
      logItems: [],
      completeEvent: false,
    });
    expect(created.success).toBe(true);

    const ownerSnapshot = await store.loadSnapshot({
      botId: event.botId,
      scene: event.scene,
      externalId: event.externalId,
      principal: event.sender,
      delegates: [target],
    });
    expect(ownerSnapshot.delegatePolicyEntries?.user_policy_target).toMatchObject({
      id: 'policy_group_target',
      scope: 'group',
      principalId: 'principal_policy_target',
      effect: 'deny',
      reason: '刷屏',
      version: 1,
    });

    const targetSnapshot = await store.loadSnapshot({
      botId: event.botId,
      scene: event.scene,
      externalId: event.externalId,
      principal: target,
    });
    expect(targetSnapshot.permissions.denied).toBe(true);

    const removed = await store.commit({
      transactionId: 'tx_policy_delete',
      eventId: claim.eventId,
      executionId: 'exec_policy_delete',
      botId: event.botId,
      conversationId: claim.conversationId,
      conversationSeq: claim.conversationSeq,
      lease: null,
      updates: [
        {
          type: 'policy-entry-delete',
          entryId: 'policy_group_target',
          expectedVersion: 1,
        },
      ],
      results: [],
      replies: [],
      logItems: [],
      completeEvent: false,
    });
    expect(removed.success).toBe(true);
    const after = await store.loadSnapshot({
      botId: event.botId,
      scene: event.scene,
      externalId: event.externalId,
      principal: target,
    });
    expect(after.permissions.denied).toBe(false);
  });
});
