import type {
  CharacterSheet,
  CommandCommit,
  CommandScope,
  CommitOutcome,
  ConversationSession,
  EventClaim,
  JobLease,
  Permissions,
  PolicyEntry,
  SceneType,
  StateSnapshot,
  StateStore,
  StoredJob,
  VerifiedEvent,
} from '@dicefunc/core';
import { createConversationSession } from '@dicefunc/core';

function parseSqliteUtc(str: string): Date {
  const clean = str.trim();
  if (clean.includes('T') && clean.endsWith('Z')) {
    return new Date(clean);
  }
  return new Date(`${clean.replace(' ', 'T')}Z`);
}

export class D1StateStore implements StateStore {
  constructor(private readonly db: D1Database) {}

  async claimEvent(event: VerifiedEvent, configDigest: string): Promise<EventClaim> {
    const conversationId = `conv_${event.botId}_${event.scene}_${event.externalId}`;
    const messageKey = `${event.scene}:${event.externalId}:${event.messageId}`;
    const receivedEventId = `rev_${event.botId}_${event.eventId}`;
    const jobId = `job_${event.botId}_${event.eventId}`;

    const seedBytes = new Uint8Array(32);
    crypto.getRandomValues(seedBytes);
    let seed = '';
    for (let i = 0; i < seedBytes.length; i++) {
      const b = seedBytes[i];
      if (b !== undefined) {
        seed += b.toString(16).padStart(2, '0');
      }
    }

    const upsertConversationStmt = this.db
      .prepare(`
      INSERT INTO conversations (
        id, bot_id, scene, external_id, receive_seq, rule_set, dice_sides, enabled, version, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 1, 'coc7', 100, 1, 1, datetime('now'), datetime('now'))
      ON CONFLICT(bot_id, scene, external_id) DO UPDATE SET
        receive_seq = conversations.receive_seq + 1,
        updated_at = datetime('now')
      RETURNING receive_seq
    `)
      .bind(conversationId, event.botId, event.scene, event.externalId);

    const insertEventStmt = this.db
      .prepare(`
      INSERT INTO received_events (
        id, bot_id, event_id, message_key, conversation_seq, status,
        payload, config_digest, seed, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        COALESCE((SELECT receive_seq FROM conversations WHERE bot_id = ?2 AND scene = ?5 AND external_id = ?6), 1),
        'pending', ?7, ?8, ?9, datetime('now'), datetime('now')
      )
    `)
      .bind(
        receivedEventId,
        event.botId,
        event.eventId,
        messageKey,
        event.scene,
        event.externalId,
        event.text,
        configDigest,
        seed,
      );

    const insertJobStmt = this.db
      .prepare(`
      INSERT INTO jobs (
        id, bot_id, type, resource_id, status, attempts, max_attempts,
        next_attempt_at, deadline, fencing_token, created_at, updated_at
      ) VALUES (
        ?1, ?2, 'command', ?3, 'pending', 0, 3,
        datetime('now'), datetime('now', '+300 seconds'), '0', datetime('now'), datetime('now')
      )
    `)
      .bind(jobId, event.botId, event.eventId);

    try {
      const batchRes = await this.db.batch([
        upsertConversationStmt,
        insertEventStmt,
        insertJobStmt,
      ]);
      const firstRes = batchRes[0];
      let conversationSeq = 1;
      if (
        firstRes?.results?.[0] &&
        typeof firstRes.results[0] === 'object' &&
        'receive_seq' in firstRes.results[0]
      ) {
        const rawSeq = firstRes.results[0].receive_seq;
        if (typeof rawSeq === 'number') {
          conversationSeq = rawSeq;
        }
      }

      return {
        eventId: event.eventId,
        messageKey,
        conversationId,
        conversationSeq,
        seed,
        jobId,
        status: 'claimed',
        alreadyProcessed: false,
      };
    } catch {
      const existing = await this.db
        .prepare(`
        SELECT event_id, message_key, conversation_seq, status, seed
        FROM received_events
        WHERE bot_id = ?1 AND (event_id = ?2 OR message_key = ?3)
        LIMIT 1
      `)
        .bind(event.botId, event.eventId, messageKey)
        .first<{
          event_id: string;
          message_key: string;
          conversation_seq: number;
          status: string;
          seed: string | null;
        }>();

      if (existing) {
        const isFinished = true;
        const jobRow = await this.db
          .prepare(`
          SELECT id FROM jobs WHERE bot_id = ?1 AND resource_id = ?2 AND type = 'command' LIMIT 1
        `)
          .bind(event.botId, existing.event_id)
          .first<{ id: string }>();

        return {
          eventId: existing.event_id,
          messageKey: existing.message_key,
          conversationId,
          conversationSeq: existing.conversation_seq,
          seed: existing.seed ?? seed,
          jobId: jobRow?.id ?? jobId,
          status: existing.status as 'claimed' | 'processing' | 'completed' | 'failed',
          alreadyProcessed: isFinished,
        };
      }

      throw new Error(`claimEvent failed for event ${event.eventId}`);
    }
  }

  async loadSnapshot(scope: CommandScope): Promise<StateSnapshot> {
    const [convRes, prinRes] = await this.db.batch([
      this.db
        .prepare(`
        SELECT id, bot_id, scene, external_id, rule_set, dice_sides, enabled, version, created_at, updated_at
        FROM conversations
        WHERE bot_id = ?1 AND scene = ?2 AND external_id = ?3
        LIMIT 1
      `)
        .bind(scope.botId, scope.scene, scope.externalId),
      this.db
        .prepare(`
        SELECT id FROM principals
        WHERE bot_id = ?1 AND scene = ?2 AND scope_id = ?3 AND external_id = ?4
        LIMIT 1
      `)
        .bind(
          scope.botId,
          scope.principal.scene,
          scope.principal.scopeId,
          scope.principal.externalId,
        ),
    ]);

    const convRow = ((convRes?.results?.[0] as unknown) ?? null) as {
      id: string;
      bot_id: string;
      scene: string;
      external_id: string;
      rule_set: string;
      dice_sides: number;
      enabled: number;
      version: number;
      created_at: string;
      updated_at: string;
    } | null;

    const prinRow = ((prinRes?.results?.[0] as unknown) ?? null) as { id: string } | null;

    let conversationId: string;
    let conversation: ConversationSession;
    if (!convRow) {
      conversationId = `conv_${scope.botId}_${scope.scene}_${scope.externalId}`;
      conversation = createConversationSession({
        id: conversationId,
        botId: scope.botId,
        scene: scope.scene,
        externalId: scope.externalId,
        ruleSet: 'coc7',
        diceSides: 100,
        enabled: true,
      });
    } else {
      conversationId = convRow.id;
      conversation = {
        id: convRow.id,
        botId: convRow.bot_id,
        scene: convRow.scene as SceneType,
        externalId: convRow.external_id,
        ruleSet: convRow.rule_set,
        diceSides: convRow.dice_sides,
        enabled: convRow.enabled === 1,
        version: convRow.version,
        createdAt: new Date(convRow.created_at),
        updatedAt: new Date(convRow.updated_at),
      };
    }

    let principalId: string;
    if (!prinRow) {
      principalId = `prin_${scope.botId}_${scope.principal.scene}_${scope.principal.scopeId}_${scope.principal.externalId}`;
      await this.db
        .prepare(`
        INSERT INTO principals (id, bot_id, scene, scope_id, external_id, version, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 1, datetime('now'), datetime('now'))
        ON CONFLICT(bot_id, scene, scope_id, external_id) DO NOTHING
      `)
        .bind(
          principalId,
          scope.botId,
          scope.principal.scene,
          scope.principal.scopeId,
          scope.principal.externalId,
        )
        .run();
    } else {
      principalId = prinRow.id;
    }

    const [activeLogRes, bindingRes, policyRes] = await this.db.batch([
      this.db
        .prepare(`
        SELECT id FROM story_logs
        WHERE bot_id = ?1 AND conversation_id = ?2 AND status IN ('new', 'recording', 'paused')
        LIMIT 1
      `)
        .bind(scope.botId, conversationId),
      this.db
        .prepare(`
        SELECT sheet_id, version FROM character_bindings
        WHERE bot_id = ?1 AND conversation_id = ?2 AND principal_id = ?3
        LIMIT 1
      `)
        .bind(scope.botId, conversationId, principalId),
      this.db
        .prepare(`
        SELECT id, scope_type, scope_id, principal_id, action, reason, version
        FROM policy_entries
        WHERE bot_id = ?1 AND (
          scope_type = 'bot'
          OR (scope_type = 'group' AND scope_id = ?2)
          OR (scope_type = 'user' AND scope_id = ?3)
          OR principal_id = ?4
        )
      `)
        .bind(scope.botId, scope.externalId, scope.principal.externalId, principalId),
    ]);

    const activeLogRow = ((activeLogRes?.results?.[0] as unknown) ?? null) as { id: string } | null;
    if (activeLogRow) {
      conversation = { ...conversation, activeLogId: activeLogRow.id };
    }

    const bindingRow = ((bindingRes?.results?.[0] as unknown) ?? null) as {
      sheet_id: string;
      version: number;
    } | null;

    let characterBinding: { readonly sheetId: string | null; readonly version: number } | undefined;
    let sheet: CharacterSheet | undefined;

    if (bindingRow) {
      characterBinding = {
        sheetId: bindingRow.sheet_id.length > 0 ? bindingRow.sheet_id : null,
        version: bindingRow.version,
      };

      if (characterBinding.sheetId !== null) {
        const sheetRow = await this.db
          .prepare(`
          SELECT id, owner_principal, rule_set, name, attributes, version, created_at, updated_at
          FROM character_sheets
          WHERE bot_id = ?1 AND id = ?2
          LIMIT 1
        `)
          .bind(scope.botId, characterBinding.sheetId)
          .first<{
            id: string;
            owner_principal: string;
            rule_set: string;
            name: string;
            attributes: string;
            version: number;
            created_at: string;
            updated_at: string;
          }>();

        if (sheetRow) {
          let parsedAttributes: Record<string, number> = {};
          try {
            parsedAttributes = JSON.parse(sheetRow.attributes) as Record<string, number>;
          } catch {}

          sheet = {
            id: sheetRow.id,
            ownerId: sheetRow.owner_principal,
            ruleSet: sheetRow.rule_set,
            name: sheetRow.name,
            attributes: Object.freeze(parsedAttributes),
            version: sheetRow.version,
            createdAt: new Date(sheetRow.created_at),
            updatedAt: new Date(sheetRow.updated_at),
          };
        }
      }
    }

    const policyRows = (policyRes?.results ?? []) as Array<{
      id: string;
      scope_type: string;
      scope_id: string;
      principal_id: string | null;
      action: string;
      reason: string | null;
      version: number;
    }>;

    const policyEntries: PolicyEntry[] = policyRows.map((row) => {
      const scopeType: 'bot' | 'group' | 'user' =
        row.scope_type === 'bot' || row.scope_type === 'group' || row.scope_type === 'user'
          ? row.scope_type
          : 'bot';
      const effect: 'deny' | 'trust' = row.action === 'deny' ? 'deny' : 'trust';
      return {
        id: row.id,
        scope: scopeType,
        effect,
        ...(row.principal_id ? { principalId: row.principal_id } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
        version: row.version,
      };
    });

    let denied = false;
    let isTrusted = false;
    for (const pe of policyEntries) {
      if (pe.effect === 'deny') {
        denied = true;
      } else if (pe.effect === 'trust') {
        isTrusted = true;
      }
    }

    const permissions: Permissions = {
      isDiceMaster: false,
      isGroupHost: false,
      isTrusted,
      denied,
    };

    return {
      conversation,
      ...(characterBinding !== undefined ? { characterBinding } : {}),
      ...(sheet !== undefined ? { sheet } : {}),
      policyEntries,
      permissions,
    };
  }

  async commit(plan: CommandCommit): Promise<CommitOutcome> {
    const statements: D1PreparedStatement[] = [];

    for (const update of plan.updates) {
      if (update.type === 'conversation-settings') {
        statements.push(
          this.db
            .prepare(`
            INSERT INTO commit_guards (bot_id, transaction_id, resource_type, resource_id, expected_version, actual_version)
            SELECT ?1, ?2, 'conversation', ?3, ?4, COALESCE((SELECT version FROM conversations WHERE bot_id = ?1 AND id = ?3), -1)
          `)
            .bind(plan.botId, plan.transactionId, update.conversationId, update.expectedVersion),
        );

        const ruleSet = update.changes.ruleSet ?? null;
        const diceSides = update.changes.diceSides ?? null;
        const enabled =
          update.changes.enabled !== undefined ? (update.changes.enabled ? 1 : 0) : null;

        statements.push(
          this.db
            .prepare(`
            UPDATE conversations
            SET rule_set = COALESCE(?1, rule_set),
                dice_sides = COALESCE(?2, dice_sides),
                enabled = COALESCE(?3, enabled),
                version = ?4,
                updated_at = datetime('now')
            WHERE bot_id = ?5 AND id = ?6
          `)
            .bind(
              ruleSet,
              diceSides,
              enabled,
              update.newVersion,
              plan.botId,
              update.conversationId,
            ),
        );
      } else if (update.type === 'character-sheet') {
        statements.push(
          this.db
            .prepare(`
            INSERT INTO commit_guards (bot_id, transaction_id, resource_type, resource_id, expected_version, actual_version)
            SELECT ?1, ?2, 'character', ?3, ?4, COALESCE((SELECT version FROM character_sheets WHERE bot_id = ?1 AND id = ?3), -1)
          `)
            .bind(plan.botId, plan.transactionId, update.sheetId, update.expectedVersion),
        );

        const name = update.changes.name ?? null;
        const attributes =
          update.changes.attributes !== undefined
            ? JSON.stringify(update.changes.attributes)
            : null;

        statements.push(
          this.db
            .prepare(`
            UPDATE character_sheets
            SET name = COALESCE(?1, name),
                attributes = COALESCE(?2, attributes),
                version = ?3,
                updated_at = datetime('now')
            WHERE bot_id = ?4 AND id = ?5
          `)
            .bind(name, attributes, update.newVersion, plan.botId, update.sheetId),
        );
      } else if (update.type === 'character-binding') {
        statements.push(
          this.db
            .prepare(`
            INSERT INTO commit_guards (bot_id, transaction_id, resource_type, resource_id, expected_version, actual_version)
            SELECT ?1, ?2, 'binding', ?3, ?4, COALESCE((SELECT version FROM character_bindings WHERE bot_id = ?1 AND conversation_id = ?5 AND principal_id = ?6), -1)
          `)
            .bind(
              plan.botId,
              plan.transactionId,
              `${update.conversationId}:${update.principalId}`,
              update.expectedVersion,
              update.conversationId,
              update.principalId,
            ),
        );

        const bindingId = `bind_${plan.botId}_${update.conversationId}_${update.principalId}`;
        const sheetId = update.changes.sheetId ?? '';

        statements.push(
          this.db
            .prepare(`
            INSERT INTO character_bindings (id, bot_id, conversation_id, principal_id, sheet_id, version, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), datetime('now'))
            ON CONFLICT(bot_id, conversation_id, principal_id) DO UPDATE SET
              sheet_id = excluded.sheet_id,
              version = excluded.version,
              updated_at = datetime('now')
          `)
            .bind(
              bindingId,
              plan.botId,
              update.conversationId,
              update.principalId,
              sheetId,
              update.newVersion,
            ),
        );
      } else if (update.type === 'policy-entry') {
        statements.push(
          this.db
            .prepare(`
            INSERT INTO commit_guards (bot_id, transaction_id, resource_type, resource_id, expected_version, actual_version)
            SELECT ?1, ?2, 'policy', ?3, ?4, COALESCE((SELECT version FROM policy_entries WHERE bot_id = ?1 AND id = ?3), -1)
          `)
            .bind(plan.botId, plan.transactionId, update.entryId, update.expectedVersion),
        );

        const reason = update.changes.reason ?? null;

        statements.push(
          this.db
            .prepare(`
            UPDATE policy_entries
            SET action = ?1,
                reason = COALESCE(?2, reason),
                version = ?3,
                updated_at = datetime('now')
            WHERE bot_id = ?4 AND id = ?5
          `)
            .bind(update.changes.effect, reason, update.newVersion, plan.botId, update.entryId),
        );
      } else if (update.type === 'deck-session') {
        statements.push(
          this.db
            .prepare(`
            INSERT INTO commit_guards (bot_id, transaction_id, resource_type, resource_id, expected_version, actual_version)
            SELECT ?1, ?2, 'deck', ?3, ?4, COALESCE((SELECT version FROM deck_sessions WHERE bot_id = ?1 AND id = ?3), -1)
          `)
            .bind(plan.botId, plan.transactionId, update.sessionId, update.expectedVersion),
        );

        statements.push(
          this.db
            .prepare(`
            UPDATE deck_sessions
            SET remaining = ?1,
                version = ?2,
                updated_at = datetime('now')
            WHERE bot_id = ?3 AND id = ?4
          `)
            .bind(
              JSON.stringify(update.changes.remaining),
              update.newVersion,
              plan.botId,
              update.sessionId,
            ),
        );
      } else if (update.type === 'story-log') {
        statements.push(
          this.db
            .prepare(`
            INSERT INTO commit_guards (bot_id, transaction_id, resource_type, resource_id, expected_version, actual_version)
            SELECT ?1, ?2, 'story_log', ?3, ?4, COALESCE((SELECT version FROM story_logs WHERE bot_id = ?1 AND id = ?3), -1)
          `)
            .bind(plan.botId, plan.transactionId, update.logId, update.expectedVersion),
        );

        statements.push(
          this.db
            .prepare(`
            UPDATE story_logs
            SET status = ?1,
                revision = ?2,
                updated_at = datetime('now')
            WHERE bot_id = ?3 AND id = ?4
          `)
            .bind(update.changes.status, update.newVersion, plan.botId, update.logId),
        );
      }
    }

    for (const result of plan.results) {
      const resultId = `res_${result.executionId}_${result.kind}`;
      statements.push(
        this.db
          .prepare(`
          INSERT INTO command_results (id, bot_id, execution_id, result_type, result_data, rule_version, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
        `)
          .bind(
            resultId,
            plan.botId,
            result.executionId,
            result.kind,
            JSON.stringify(result.data),
            result.ruleVersion,
          ),
      );
    }

    for (const reply of plan.replies) {
      const messageId = `msg_${reply.executionId}_${reply.part}_${reply.msgSeq}`;
      statements.push(
        this.db
          .prepare(`
          INSERT INTO outgoing_messages (
            id, bot_id, execution_id, part, msg_seq,
            scene, target_id, origin_message_id, template_key, variant_id, text,
            deadline, status, created_at, updated_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'pending', datetime('now'), datetime('now'))
        `)
          .bind(
            messageId,
            plan.botId,
            reply.executionId,
            reply.part,
            reply.msgSeq,
            reply.scene,
            reply.targetId,
            reply.originMessageId,
            reply.templateKey,
            reply.variantId ?? null,
            reply.text,
            reply.deadline.toISOString(),
          ),
      );
    }

    for (const item of plan.logItems) {
      const itemId = `item_${plan.botId}_${item.sourceId}_${item.seq}`;
      statements.push(
        this.db
          .prepare(`
          INSERT INTO story_log_items (id, bot_id, log_id, sequence_number, direction, source_id, text, delivery_status, created_at)
          SELECT ?1, ?2, id, ?4, ?5, ?6, ?7, ?8, datetime('now')
          FROM story_logs
          WHERE bot_id = ?2 AND conversation_id = ?3 AND status IN ('new', 'recording', 'paused')
          LIMIT 1
        `)
          .bind(
            itemId,
            plan.botId,
            plan.conversationId,
            item.seq,
            item.direction,
            item.sourceId,
            item.text,
            item.deliveryStatus,
          ),
      );
    }

    if (plan.completeEvent) {
      if (plan.lease !== null) {
        statements.push(
          this.db
            .prepare(`
            UPDATE received_events
            SET status = 'completed',
                result_id = ?1,
                transaction_id = ?2,
                updated_at = datetime('now')
            WHERE bot_id = ?3 AND event_id = ?4 AND CAST(COALESCE(fencing_token, '0') AS INTEGER) <= ?5
          `)
            .bind(
              plan.executionId,
              plan.transactionId,
              plan.botId,
              plan.eventId,
              plan.lease.fencingToken,
            ),
        );
      } else {
        statements.push(
          this.db
            .prepare(`
            UPDATE received_events
            SET status = 'completed',
                result_id = ?1,
                transaction_id = ?2,
                updated_at = datetime('now')
            WHERE bot_id = ?3 AND event_id = ?4
          `)
            .bind(plan.executionId, plan.transactionId, plan.botId, plan.eventId),
        );
      }
    }

    statements.push(
      this.db
        .prepare(`
        DELETE FROM commit_guards WHERE bot_id = ?1 AND transaction_id = ?2
      `)
        .bind(plan.botId, plan.transactionId),
    );

    try {
      await this.db.batch(statements);

      const updatedVersions: Record<string, number> = {};
      for (const u of plan.updates) {
        if (u.type === 'conversation-settings') {
          updatedVersions[u.conversationId] = u.newVersion;
        } else if (u.type === 'character-sheet') {
          updatedVersions[u.sheetId] = u.newVersion;
        } else if (u.type === 'character-binding') {
          updatedVersions[`${u.conversationId}:${u.principalId}`] = u.newVersion;
        } else if (u.type === 'policy-entry') {
          updatedVersions[u.entryId] = u.newVersion;
        } else if (u.type === 'deck-session') {
          updatedVersions[u.sessionId] = u.newVersion;
        } else if (u.type === 'story-log') {
          updatedVersions[u.logId] = u.newVersion;
        }
      }

      return {
        success: true,
        executionId: plan.executionId,
        updatedVersions,
        conflict: false,
        errors: [],
      };
    } catch (error) {
      return {
        success: false,
        executionId: plan.executionId,
        updatedVersions: {},
        conflict: true,
        errors: [
          {
            type: 'version_conflict',
            resource: 'batch',
            details: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  async getJob(botId: string, jobId: string): Promise<StoredJob | null> {
    const row = await this.db
      .prepare(`
      SELECT id, type, resource_id, status, attempts, max_attempts, next_attempt_at, deadline, fencing_token
      FROM jobs
      WHERE bot_id = ?1 AND id = ?2
      LIMIT 1
    `)
      .bind(botId, jobId)
      .first<{
        id: string;
        type: string;
        resource_id: string;
        status: string;
        attempts: number;
        max_attempts: number;
        next_attempt_at: string;
        deadline: string;
        fencing_token: string | null;
      }>();

    if (!row) {
      return null;
    }

    return {
      jobId: row.id,
      type: row.type as 'command' | 'archive-chunk',
      resourceId: row.resource_id,
      status: row.status as 'pending' | 'processing' | 'completed' | 'failed' | 'dead',
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      nextAttemptAt: parseSqliteUtc(row.next_attempt_at),
      deadline: parseSqliteUtc(row.deadline),
      fencingToken: Number.parseInt(String(row.fencing_token ?? '0'), 10) || 0,
    };
  }

  async acquireJob(botId: string, jobId: string, leaseSeconds: number): Promise<JobLease | null> {
    const leaseToken = `lease_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;

    const row = await this.db
      .prepare(`
      UPDATE jobs
      SET status = 'processing',
          attempts = attempts + 1,
          lease = ?1,
          lease_expires_at = datetime('now', '+' || ?2 || ' seconds'),
          fencing_token = CAST(CAST(COALESCE(fencing_token, '0') AS INTEGER) + 1 AS TEXT),
          updated_at = datetime('now')
      WHERE bot_id = ?3 AND id = ?4
        AND attempts < max_attempts
        AND status NOT IN ('completed', 'dead')
        AND (
          (status != 'processing' AND datetime(next_attempt_at) <= datetime('now'))
          OR (status = 'processing' AND (lease_expires_at IS NULL OR datetime(lease_expires_at) < datetime('now')))
        )
      RETURNING id, type, resource_id, status, attempts, max_attempts, next_attempt_at, deadline, fencing_token, lease_expires_at
    `)
      .bind(leaseToken, leaseSeconds, botId, jobId)
      .first<{
        id: string;
        type: string;
        resource_id: string;
        status: string;
        attempts: number;
        max_attempts: number;
        next_attempt_at: string;
        deadline: string;
        fencing_token: string | null;
        lease_expires_at: string | null;
      }>();

    if (!row) {
      return null;
    }

    const nextFencing = Number.parseInt(String(row.fencing_token ?? '0'), 10) || 0;
    const updatedJob: StoredJob = {
      jobId: row.id,
      type: row.type as 'command' | 'archive-chunk',
      resourceId: row.resource_id,
      status: 'processing',
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      nextAttemptAt: parseSqliteUtc(row.next_attempt_at),
      deadline: parseSqliteUtc(row.deadline),
      fencingToken: nextFencing,
    };

    return {
      job: updatedJob,
      leaseToken,
      fencingToken: nextFencing,
    };
  }

  async completeJob(
    botId: string,
    jobId: string,
    fencingToken: number,
    status: 'completed' | 'failed' | 'dead',
    errorCode?: string,
  ): Promise<boolean> {
    const res = await this.db
      .prepare(`
      UPDATE jobs
      SET status = ?1,
          error_code = ?2,
          lease = NULL,
          lease_expires_at = NULL,
          updated_at = datetime('now')
      WHERE bot_id = ?3 AND id = ?4 AND CAST(COALESCE(fencing_token, '0') AS INTEGER) <= ?5
    `)
      .bind(status, errorCode ?? null, botId, jobId, fencingToken)
      .run();

    return (res.meta.changes ?? 0) > 0;
  }

  async listRecoverableJobs(botId: string, limit: number): Promise<StoredJob[]> {
    const rows = await this.db
      .prepare(`
      SELECT id, type, resource_id, status, attempts, max_attempts, next_attempt_at, deadline, fencing_token
      FROM jobs
      WHERE bot_id = ?1
        AND attempts < max_attempts
        AND (
          (status IN ('pending', 'failed') AND datetime(next_attempt_at) <= datetime('now'))
          OR (status = 'processing' AND datetime(lease_expires_at) < datetime('now'))
        )
      ORDER BY next_attempt_at ASC
      LIMIT ?2
    `)
      .bind(botId, limit)
      .all<{
        id: string;
        type: string;
        resource_id: string;
        status: string;
        attempts: number;
        max_attempts: number;
        next_attempt_at: string;
        deadline: string;
        fencing_token: string | null;
      }>();

    return (rows.results ?? []).map((row) => ({
      jobId: row.id,
      type: row.type as 'command' | 'archive-chunk',
      resourceId: row.resource_id,
      status: row.status as 'pending' | 'processing' | 'completed' | 'failed' | 'dead',
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      nextAttemptAt: new Date(row.next_attempt_at),
      deadline: new Date(row.deadline),
      fencingToken: Number.parseInt(String(row.fencing_token ?? '0'), 10) || 0,
    }));
  }

  async purgeExpiredData(
    botId: string,
    retention: {
      readonly resultDays: number;
      readonly dedupDays: number;
      readonly auditDays: number;
    },
  ): Promise<{
    results: number;
    events: number;
    audits: number;
  }> {
    const resultsRes = await this.db
      .prepare(`
      DELETE FROM command_results
      WHERE bot_id = ?1 AND datetime(created_at) < datetime('now', '-' || ?2 || ' days')
    `)
      .bind(botId, retention.resultDays)
      .run();

    const eventsRes = await this.db
      .prepare(`
      DELETE FROM received_events
      WHERE bot_id = ?1 AND status IN ('completed', 'failed') AND datetime(created_at) < datetime('now', '-' || ?2 || ' days')
    `)
      .bind(botId, retention.dedupDays)
      .run();

    const auditsRes = await this.db
      .prepare(`
      DELETE FROM log_audit_events
      WHERE bot_id = ?1 AND datetime(created_at) < datetime('now', '-' || ?2 || ' days')
    `)
      .bind(botId, retention.auditDays)
      .run();

    return {
      results: resultsRes.meta.changes ?? 0,
      events: eventsRes.meta.changes ?? 0,
      audits: auditsRes.meta.changes ?? 0,
    };
  }
}
