import type { ExecutionContext, Message, MessageBatch } from '@cloudflare/workers-types';
import {
  type EventClaim,
  type QueueMessage,
  type SceneType,
  type VerifiedEvent,
  buildLogEntry,
  createSealDiceTextLogFormatter,
} from '@dicefunc/core';
import type { Env } from './bindings.js';
import { botDisplayName } from './copy.js';
import type { WorkerDependencies } from './index.js';
import { createDependencies } from './index.js';

async function deliverPendingReplies(
  env: Env,
  deps: WorkerDependencies,
  executionId: string,
): Promise<boolean> {
  const rows = await env.DB.prepare(`
    SELECT id, part, msg_seq, scene, target_id, origin_message_id, template_key,
           variant_id, text, deadline, delivery_mode, condition_part, condition_status, status,
           story_log_id, story_log_sequence, story_log_part
    FROM outgoing_messages
    WHERE bot_id = ?1 AND execution_id = ?2
    ORDER BY part, msg_seq
  `)
    .bind(env.QQ_APP_ID, executionId)
    .all<{
      id: string;
      part: number;
      msg_seq: number;
      scene: string | null;
      target_id: string | null;
      origin_message_id: string | null;
      template_key: string | null;
      variant_id: string | null;
      text: string | null;
      deadline: string;
      delivery_mode: 'passive' | 'active';
      condition_part: number | null;
      condition_status: 'sent' | 'failed' | null;
      status: string;
      story_log_id: string | null;
      story_log_sequence: number | null;
      story_log_part: number | null;
    }>();

  const statusByPart = new Map(rows.results.map((row) => [row.part, row.status]));
  let allTerminal = true;

  for (const row of rows.results) {
    if (row.status !== 'pending') {
      continue;
    }

    if (row.condition_part !== null && row.condition_status !== null) {
      const dependencyStatus = statusByPart.get(row.condition_part);
      if (dependencyStatus === undefined) {
        await env.DB.prepare(`
          UPDATE outgoing_messages
          SET status = 'failed', updated_at = datetime('now')
          WHERE bot_id = ?1 AND id = ?2 AND status = 'pending'
        `)
          .bind(env.QQ_APP_ID, row.id)
          .run();
        statusByPart.set(row.part, 'failed');
        continue;
      }
      if (dependencyStatus === 'pending') {
        allTerminal = false;
        continue;
      }

      const conditionMatches =
        row.condition_status === 'sent'
          ? dependencyStatus === 'sent'
          : dependencyStatus === 'failed' || dependencyStatus === 'expired';
      if (!conditionMatches) {
        await env.DB.prepare(`
          UPDATE outgoing_messages
          SET status = 'skipped', updated_at = datetime('now')
          WHERE bot_id = ?1 AND id = ?2 AND status = 'pending'
        `)
          .bind(env.QQ_APP_ID, row.id)
          .run();
        statusByPart.set(row.part, 'skipped');
        continue;
      }
    }

    const passiveMessageIdMissing = row.delivery_mode === 'passive' && !row.origin_message_id;
    if (!row.scene || !row.target_id || passiveMessageIdMissing || row.text === null) {
      await env.DB.prepare(`
        UPDATE outgoing_messages
        SET status = 'failed', updated_at = datetime('now')
        WHERE bot_id = ?1 AND id = ?2 AND status = 'pending'
      `)
        .bind(env.QQ_APP_ID, row.id)
        .run();
      statusByPart.set(row.part, 'failed');
      continue;
    }

    const outcome = await deps.replySender.send({
      executionId,
      part: row.part,
      msgSeq: row.msg_seq,
      scene: row.scene as SceneType,
      targetId: row.target_id,
      originMessageId: row.origin_message_id ?? undefined,
      templateKey: row.template_key ?? '',
      variantId: row.variant_id ?? undefined,
      text: row.text,
      deadline: new Date(row.deadline),
      deliveryMode: row.delivery_mode,
    });

    if (outcome.status === 'sent') {
      const statements = [
        env.DB.prepare(`
          UPDATE outgoing_messages
          SET status = 'sent', platform_message_id = ?3, updated_at = datetime('now')
          WHERE bot_id = ?1 AND id = ?2 AND status = 'pending'
        `).bind(env.QQ_APP_ID, row.id, outcome.platformMessageId),
      ];
      if (
        row.story_log_id !== null &&
        row.story_log_sequence !== null &&
        row.story_log_part !== null
      ) {
        statements.push(
          env.DB.prepare(`
              INSERT OR IGNORE INTO story_log_items (
                id, bot_id, log_id, sequence_number, sequence_part, direction,
                source_id, nickname, im_user_id, uniform_id, message_time, text,
                is_dice, command_id, command_info, raw_msg_id, channel,
                delivery_status, created_at
              )
              SELECT
                ?1, ?2, id, ?4, ?5, 'outbound',
                ?2, ?6, ?2, ?2, ?7, ?8,
                1, 0, NULL, ?9, '', 'sent', datetime('now')
              FROM story_logs
              WHERE bot_id = ?2 AND id = ?3
              LIMIT 1
            `).bind(
            `item_${row.story_log_id}_${row.story_log_sequence}_${row.story_log_part}`,
            env.QQ_APP_ID,
            row.story_log_id,
            row.story_log_sequence,
            row.story_log_part,
            botDisplayName,
            Math.floor(Date.now() / 1000),
            row.text,
            outcome.platformMessageId,
          ),
        );
      }
      await env.DB.batch(statements);
      statusByPart.set(row.part, 'sent');
    } else if (outcome.status === 'failed' || outcome.status === 'expired') {
      await env.DB.prepare(`
        UPDATE outgoing_messages
        SET status = ?3, updated_at = datetime('now')
        WHERE bot_id = ?1 AND id = ?2 AND status = 'pending'
      `)
        .bind(env.QQ_APP_ID, row.id, outcome.status)
        .run();
      statusByPart.set(row.part, outcome.status);
    } else {
      allTerminal = false;
    }
  }

  return allTerminal;
}

export async function handleCommandMessage(
  jobId: string,
  msg: Message<QueueMessage> | undefined,
  env: Env,
  deps: WorkerDependencies,
  preloaded?: { verifiedEvent: VerifiedEvent; claim: EventClaim } | undefined,
): Promise<void> {
  const tokenReady = deps.tokenProvider.getAccessToken().catch(() => undefined);
  const lease = await deps.stateStore.acquireJob(env.QQ_APP_ID, jobId, 60);
  if (!lease) {
    if (!msg) {
      return;
    }

    const job = await deps.stateStore.getJob(env.QQ_APP_ID, jobId);
    if (job && job.status !== 'completed' && job.status !== 'dead') {
      const delaySeconds =
        job.status === 'processing'
          ? 60
          : Math.min(
              300,
              Math.max(1, Math.ceil((job.nextAttemptAt.getTime() - Date.now()) / 1000)),
            );
      msg.retry({ delaySeconds });
    } else {
      msg.ack();
    }
    return;
  }

  let verifiedEvent: VerifiedEvent;
  let claim: EventClaim;
  let isRowCompleted = false;
  let eventId = lease.job.resourceId;

  if (preloaded) {
    verifiedEvent = preloaded.verifiedEvent;
    claim = preloaded.claim;
    eventId = preloaded.claim.eventId;
  } else {
    type ReceivedEventRow = {
      id: string;
      bot_id: string;
      event_id: string;
      message_key: string;
      conversation_seq: number;
      status: string;
      payload: string | null;
      config_digest: string;
      seed: string | null;
      sender_scene: SceneType | null;
      sender_scope_id: string | null;
      sender_external_id: string | null;
      sender_role?: string | null;
      sender_name?: string | null;
      event_timestamp?: string | null;
      created_at: string;
    };

    let row: ReceivedEventRow | null | undefined;
    try {
      row = await env.DB.prepare(`
        SELECT id, bot_id, event_id, message_key, conversation_seq, status, payload, config_digest, seed,
               sender_scene, sender_scope_id, sender_external_id, sender_role, sender_name,
               event_timestamp, created_at
        FROM received_events
        WHERE bot_id = ?1 AND event_id = ?2
        LIMIT 1
      `)
        .bind(env.QQ_APP_ID, lease.job.resourceId)
        .first<ReceivedEventRow>();
    } catch {
      row = await env.DB.prepare(`
        SELECT id, bot_id, event_id, message_key, conversation_seq, status, payload, config_digest, seed,
               sender_scene, sender_scope_id, sender_external_id, created_at
        FROM received_events
        WHERE bot_id = ?1 AND event_id = ?2
        LIMIT 1
      `)
        .bind(env.QQ_APP_ID, lease.job.resourceId)
        .first<ReceivedEventRow>();
    }

    if (!row) {
      await deps.stateStore.completeJob(
        env.QQ_APP_ID,
        jobId,
        lease.fencingToken,
        'dead',
        'EVENT_NOT_FOUND',
      );
      msg?.ack();
      return;
    }

    isRowCompleted = row.status === 'completed';
    eventId = row.event_id;
    const parts = row.message_key.split(':');
    const scene = (parts[0] ?? 'groupAt') as SceneType;
    const messageId = parts[parts.length - 1] ?? row.event_id;
    const externalId = parts.length > 2 ? parts.slice(1, -1).join(':') : (parts[1] ?? '');

    verifiedEvent = {
      botId: row.bot_id,
      scene,
      eventId: row.event_id,
      messageId,
      externalId,
      timestamp: new Date(row.event_timestamp ?? row.created_at),
      text: row.payload ?? '',
      sender: {
        scene: row.sender_scene ?? scene,
        scopeId: row.sender_scope_id ?? externalId,
        externalId: row.sender_external_id ?? externalId,
        ...(row.sender_name ? { name: row.sender_name } : {}),
        ...(row.sender_role ? { role: row.sender_role } : {}),
      },
    };

    claim = {
      eventId: row.event_id,
      messageKey: row.message_key,
      conversationId: `conv_${row.bot_id}_${scene}_${externalId}`,
      conversationSeq: row.conversation_seq,
      seed: row.seed ?? '',
      jobId,
      status: 'claimed',
      alreadyProcessed: false,
    };
  }
  let retryCode: string;
  if (isRowCompleted) {
    retryCode = '';
  } else {
    const result = await deps.eventHandler.executeClaimed(verifiedEvent, claim);
    if (!result.success) {
      retryCode = result.error?.code ?? 'EXECUTION_FAILED';
      if (result.error?.retryable === false) {
        await deps.stateStore.completeJob(
          env.QQ_APP_ID,
          jobId,
          lease.fencingToken,
          'dead',
          retryCode,
        );
        msg?.ack();
        return;
      }
    } else {
      retryCode = '';
    }
  }

  if (retryCode === '') {
    const archiveJob = await deps.stateStore.getJob(env.QQ_APP_ID, `job_archive_${eventId}`);
    if (archiveJob?.type === 'archive-chunk' && archiveJob.status === 'pending') {
      try {
        await deps.jobQueue.enqueueArchive({
          jobId: archiveJob.jobId,
          type: 'archive-chunk',
          schemaVersion: 1,
        });
      } catch {
        retryCode = 'ARCHIVE_ENQUEUE_FAILED';
      }
    }
  }

  if (retryCode === '') {
    await tokenReady;
    const executionId = `exec_${eventId}`;
    const allTerminal = await deliverPendingReplies(env, deps, executionId);
    if (allTerminal) {
      await deps.stateStore.completeJob(env.QQ_APP_ID, jobId, lease.fencingToken, 'completed');
      msg?.ack();
      return;
    }
    retryCode = 'REPLY_DELIVERY_PENDING';
  }

  if (lease.job.attempts < lease.job.maxAttempts) {
    const backoffSeconds = Math.min(300, 2 ** lease.job.attempts * 5);
    await env.DB.prepare(`
      UPDATE jobs
      SET status = 'pending',
          next_attempt_at = datetime('now', '+' || ?1 || ' seconds'),
          error_code = ?2,
          lease = NULL,
          lease_expires_at = NULL,
          updated_at = datetime('now')
      WHERE bot_id = ?3 AND id = ?4 AND CAST(COALESCE(fencing_token, '0') AS INTEGER) <= ?5
    `)
      .bind(backoffSeconds, retryCode, env.QQ_APP_ID, jobId, lease.fencingToken)
      .run();
    msg?.retry({ delaySeconds: backoffSeconds });
  } else {
    await deps.stateStore.completeJob(env.QQ_APP_ID, jobId, lease.fencingToken, 'dead', retryCode);
    msg?.ack();
  }
}

async function handleArchiveMessage(
  jobId: string,
  msg: Message<QueueMessage>,
  env: Env,
  deps: WorkerDependencies,
): Promise<void> {
  const lease = await deps.stateStore.acquireJob(env.QQ_APP_ID, jobId, 60);
  if (!lease) {
    const job = await deps.stateStore.getJob(env.QQ_APP_ID, jobId);
    if (job && job.status !== 'completed' && job.status !== 'dead') {
      msg.retry({ delaySeconds: 60 });
    } else {
      msg.ack();
    }
    return;
  }

  const archiveId = lease.job.resourceId;

  try {
    const archive = await env.DB.prepare(`
      SELECT id, log_id, snapshot_cursor, object_key, status, deletion_status
      FROM log_archives
      WHERE bot_id = ?1 AND id = ?2
      LIMIT 1
    `)
      .bind(env.QQ_APP_ID, archiveId)
      .first<{
        id: string;
        log_id: string;
        snapshot_cursor: number;
        object_key: string;
        status: string;
        deletion_status: string;
      }>();

    if (!archive) {
      await deps.stateStore.completeJob(
        env.QQ_APP_ID,
        jobId,
        lease.fencingToken,
        'dead',
        'ARCHIVE_NOT_FOUND',
      );
      msg.ack();
      return;
    }

    if (archive.status === 'ready') {
      await deps.stateStore.completeJob(env.QQ_APP_ID, jobId, lease.fencingToken, 'completed');
      msg.ack();
      return;
    }

    if (archive.deletion_status !== 'none') {
      await deps.stateStore.completeJob(
        env.QQ_APP_ID,
        jobId,
        lease.fencingToken,
        'dead',
        'ARCHIVE_DELETING',
      );
      msg.ack();
      return;
    }

    await env.DB.prepare(`
      UPDATE log_archives
      SET status = 'uploading', error_code = NULL, updated_at = datetime('now')
      WHERE bot_id = ?1 AND id = ?2 AND status IN ('pending', 'uploading', 'failed')
    `)
      .bind(env.QQ_APP_ID, archiveId)
      .run();

    const itemsResult = await env.DB.prepare(`
      WITH pending AS (
        SELECT id, sequence_number, sequence_part, direction, source_id, nickname,
               im_user_id, message_time, text, created_at,
               ROW_NUMBER() OVER (
                 ORDER BY sequence_number ASC, sequence_part ASC
               ) AS row_number
        FROM story_log_items
        WHERE bot_id = ?1 AND log_id = ?2
          AND sequence_number <= ?3 AND chunk_id IS NULL
      ),
      boundary AS (
        SELECT sequence_number
        FROM pending
        WHERE row_number = 100
      )
      SELECT id, sequence_number, sequence_part, direction, source_id, nickname,
             im_user_id, message_time, text, created_at
      FROM pending
      WHERE row_number <= 100
         OR sequence_number = (SELECT sequence_number FROM boundary)
      ORDER BY sequence_number ASC, sequence_part ASC
    `)
      .bind(env.QQ_APP_ID, archive.log_id, archive.snapshot_cursor)
      .all<{
        id: string;
        sequence_number: number;
        sequence_part: number;
        direction: string;
        source_id: string;
        nickname: string;
        im_user_id: string;
        message_time: number;
        text: string | null;
        created_at: string;
      }>();

    const items = itemsResult.results ?? [];
    const firstItem = items[0];
    const lastItem = items[items.length - 1];

    if (firstItem && lastItem) {
      const firstSeq = firstItem.sequence_number;
      const lastSeq = lastItem.sequence_number;
      const objectKey = `${archive.log_id}/${firstSeq}-${lastSeq}.txt`;
      const formatLogItem = createSealDiceTextLogFormatter(env.BOT_TIMEZONE?.trim() || 'UTC');
      const textContent = items
        .map((item) => {
          const sqliteTime = item.created_at.includes('T')
            ? item.created_at
            : `${item.created_at.replace(' ', 'T')}Z`;
          const parsedTime = Math.floor(new Date(sqliteTime).getTime() / 1000);
          return formatLogItem({
            nickname: item.nickname || item.source_id,
            imUserId: item.im_user_id || item.source_id,
            time: item.message_time > 0 ? item.message_time : parsedTime,
            message: item.text ?? '',
          });
        })
        .join('');
      const bodyBytes = new TextEncoder().encode(textContent);
      const hashBuffer = await crypto.subtle.digest('SHA-256', bodyBytes);
      const hashHex = Array.from(new Uint8Array(hashBuffer), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const receipt = await deps.archiveStore.put({
        key: objectKey,
        body: bodyBytes,
        format: 'txt',
        digest: hashHex,
      });
      const chunkId = `chunk_${archive.log_id}_${firstSeq}_${lastSeq}`;
      const nowIso = new Date().toISOString();

      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO story_chunks (
            id, bot_id, log_id, first_seq, last_seq, item_count, object_key,
            sha256, bytes, verified_at, created_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))
          ON CONFLICT(bot_id, log_id, first_seq) DO UPDATE SET
            last_seq = ?5,
            item_count = ?6,
            object_key = ?7,
            sha256 = ?8,
            bytes = ?9,
            verified_at = ?10
        `).bind(
          chunkId,
          env.QQ_APP_ID,
          archive.log_id,
          firstSeq,
          lastSeq,
          items.length,
          receipt.key,
          receipt.digest,
          receipt.bytes,
          nowIso,
        ),
        env.DB.prepare(`
          UPDATE story_log_items
          SET chunk_id = ?1
          WHERE bot_id = ?2 AND log_id = ?3
            AND sequence_number BETWEEN ?4 AND ?5
            AND sequence_number <= ?6
        `).bind(chunkId, env.QQ_APP_ID, archive.log_id, firstSeq, lastSeq, archive.snapshot_cursor),
        env.DB.prepare(`
          UPDATE story_logs
          SET cursor = MAX(COALESCE(cursor, 0), ?1),
              updated_at = datetime('now')
          WHERE bot_id = ?2 AND id = ?3
        `).bind(lastSeq, env.QQ_APP_ID, archive.log_id),
      ]);
    }

    const counts = await env.DB.prepare(`
      SELECT COUNT(*) AS item_count,
             COALESCE(SUM(CASE WHEN chunk_id IS NULL THEN 1 ELSE 0 END), 0) AS remaining_count
      FROM story_log_items
      WHERE bot_id = ?1 AND log_id = ?2 AND sequence_number <= ?3
    `)
      .bind(env.QQ_APP_ID, archive.log_id, archive.snapshot_cursor)
      .first<{ item_count: number; remaining_count: number }>();

    if ((counts?.remaining_count ?? 0) > 0) {
      await env.DB.prepare(`
        UPDATE jobs
        SET status = 'pending',
            attempts = 0,
            next_attempt_at = datetime('now'),
            error_code = NULL,
            lease = NULL,
            lease_expires_at = NULL,
            updated_at = datetime('now')
        WHERE bot_id = ?1 AND id = ?2
          AND CAST(COALESCE(fencing_token, '0') AS INTEGER) = ?3
      `)
        .bind(env.QQ_APP_ID, jobId, lease.fencingToken)
        .run();
      await deps.jobQueue.enqueueArchive({
        jobId,
        type: 'archive-chunk',
        schemaVersion: 1,
      });
      msg.ack();
      return;
    }

    const chunkResult = await env.DB.prepare(`
      SELECT first_seq, last_seq, item_count, object_key, sha256, bytes
      FROM story_chunks
      WHERE bot_id = ?1 AND log_id = ?2 AND last_seq <= ?3
      ORDER BY first_seq ASC
    `)
      .bind(env.QQ_APP_ID, archive.log_id, archive.snapshot_cursor)
      .all<{
        first_seq: number;
        last_seq: number;
        item_count: number;
        object_key: string;
        sha256: string;
        bytes: number;
      }>();
    const chunks = chunkResult.results ?? [];
    const archivedItemCount = chunks.reduce((total, chunk) => total + chunk.item_count, 0);
    if (archivedItemCount < (counts?.item_count ?? 0)) {
      throw new Error('Archive chunk coverage is incomplete');
    }

    const manifestBody = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        archiveId,
        logId: archive.log_id,
        snapshotCursor: archive.snapshot_cursor,
        itemCount: counts?.item_count ?? 0,
        chunks: chunks.map((chunk) => ({
          firstSeq: chunk.first_seq,
          lastSeq: chunk.last_seq,
          itemCount: chunk.item_count,
          objectKey: chunk.object_key,
          sha256: chunk.sha256,
          bytes: chunk.bytes,
        })),
      }),
    );
    const manifestHashBuffer = await crypto.subtle.digest('SHA-256', manifestBody);
    const manifestHash = Array.from(new Uint8Array(manifestHashBuffer), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const manifestReceipt = await deps.archiveStore.put({
      key: archive.object_key,
      body: manifestBody,
      format: 'json',
      digest: manifestHash,
    });

    await env.DB.prepare(`
      UPDATE log_archives
      SET status = 'ready',
          format = 'txt',
          object_key = ?1,
          digest = ?2,
          error_code = NULL,
          updated_at = datetime('now')
      WHERE bot_id = ?3 AND id = ?4
        AND status = 'uploading' AND deletion_status = 'none'
    `)
      .bind(manifestReceipt.key, manifestReceipt.digest, env.QQ_APP_ID, archiveId)
      .run();
    await deps.stateStore.completeJob(env.QQ_APP_ID, jobId, lease.fencingToken, 'completed');
    msg.ack();
  } catch {
    deps.logger.log(
      buildLogEntry({
        level: 'error',
        event: 'queue.archive.failed',
        component: 'queue-archive',
        environment: env.ENVIRONMENT,
        jobId,
        outcome: 'error',
        errorCode: 'ARCHIVE_RETRY',
      }),
    );

    if (lease.job.attempts >= lease.job.maxAttempts) {
      await env.DB.prepare(`
        UPDATE log_archives
        SET status = 'failed', error_code = 'ARCHIVE_RETRY', updated_at = datetime('now')
        WHERE bot_id = ?1 AND id = ?2
      `)
        .bind(env.QQ_APP_ID, archiveId)
        .run();
      await deps.stateStore.completeJob(
        env.QQ_APP_ID,
        jobId,
        lease.fencingToken,
        'dead',
        'ARCHIVE_RETRY',
      );
      msg.ack();
      return;
    }

    const backoffSeconds = Math.min(300, 2 ** lease.job.attempts * 5);
    await env.DB.prepare(`
      UPDATE jobs
      SET status = 'failed',
          next_attempt_at = datetime('now', '+' || ?1 || ' seconds'),
          error_code = 'ARCHIVE_RETRY',
          lease = NULL,
          lease_expires_at = NULL,
          updated_at = datetime('now')
      WHERE bot_id = ?2 AND id = ?3
        AND CAST(COALESCE(fencing_token, '0') AS INTEGER) = ?4
    `)
      .bind(backoffSeconds, env.QQ_APP_ID, jobId, lease.fencingToken)
      .run();
    msg.retry({ delaySeconds: backoffSeconds });
  }
}

export async function queue(
  batch: MessageBatch<QueueMessage>,
  env: Env,
  ctx: ExecutionContext,
  dependencies?: WorkerDependencies,
): Promise<void> {
  const deps = dependencies ?? createDependencies(env);

  for (const msg of batch.messages) {
    const body = msg.body as Partial<QueueMessage> | undefined;
    if (
      !body ||
      typeof body.jobId !== 'string' ||
      !body.jobId ||
      (body.type !== 'command' && body.type !== 'archive-chunk')
    ) {
      msg.ack();
      continue;
    }

    if (body.type === 'command') {
      await handleCommandMessage(body.jobId, msg, env, deps);
    } else if (body.type === 'archive-chunk') {
      await handleArchiveMessage(body.jobId, msg, env, deps);
    }
  }
}
