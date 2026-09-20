import type { ExecutionContext, Message, MessageBatch } from '@cloudflare/workers-types';
import type { EventClaim, QueueMessage, SceneType, VerifiedEvent } from '@dicefunc/core';
import { buildLogEntry } from '@dicefunc/core';
import type { Env } from './bindings.js';
import type { WorkerDependencies } from './index.js';
import { createDependencies } from './index.js';

async function deliverPendingReplies(
  env: Env,
  deps: WorkerDependencies,
  executionId: string,
): Promise<boolean> {
  const rows = await env.DB.prepare(`
    SELECT id, part, msg_seq, scene, target_id, origin_message_id, template_key,
           variant_id, text, deadline, delivery_mode, condition_part, condition_status, status
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
      await env.DB.prepare(`
        UPDATE outgoing_messages
        SET status = 'sent', platform_message_id = ?3, updated_at = datetime('now')
        WHERE bot_id = ?1 AND id = ?2 AND status = 'pending'
      `)
        .bind(env.QQ_APP_ID, row.id, outcome.platformMessageId)
        .run();
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
      created_at: string;
    };

    let row: ReceivedEventRow | null | undefined;
    try {
      row = await env.DB.prepare(`
        SELECT id, bot_id, event_id, message_key, conversation_seq, status, payload, config_digest, seed,
               sender_scene, sender_scope_id, sender_external_id, sender_role, created_at
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
      timestamp: new Date(row.created_at),
      text: row.payload ?? '',
      sender: {
        scene: row.sender_scene ?? scene,
        scopeId: row.sender_scope_id ?? externalId,
        externalId: row.sender_external_id ?? externalId,
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
    msg.ack();
    return;
  }

  const logId = lease.job.resourceId;

  try {
    const itemsResult = await env.DB.prepare(`
      SELECT id, sequence_number, direction, source_id, text, created_at
      FROM story_log_items
      WHERE bot_id = ?1 AND log_id = ?2 AND chunk_id IS NULL
      ORDER BY sequence_number ASC
      LIMIT 100
    `)
      .bind(env.QQ_APP_ID, logId)
      .all<{
        id: string;
        sequence_number: number;
        direction: string;
        source_id: string;
        text: string | null;
        created_at: string;
      }>();

    const items = itemsResult.results ?? [];
    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    if (!firstItem || !lastItem) {
      await deps.stateStore.completeJob(env.QQ_APP_ID, jobId, lease.fencingToken, 'completed');
      msg.ack();
      return;
    }

    const firstSeq = firstItem.sequence_number;
    const lastSeq = lastItem.sequence_number;
    const objectKey = `${logId}/${firstSeq}-${lastSeq}.jsonl`;

    const jsonlContent = `${items
      .map((it) =>
        JSON.stringify({
          id: it.id,
          seq: it.sequence_number,
          dir: it.direction,
          src: it.source_id,
          text: it.text,
          time: it.created_at,
        }),
      )
      .join('\n')}\n`;

    const bodyBytes = new TextEncoder().encode(jsonlContent);
    const hashBuffer = await crypto.subtle.digest('SHA-256', bodyBytes);
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const receipt = await deps.archiveStore.put({
      key: objectKey,
      body: bodyBytes,
      format: 'json',
      digest: hashHex,
    });

    const chunkId = `chunk_${logId}_${firstSeq}_${lastSeq}`;
    const nowIso = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO story_chunks (id, bot_id, log_id, first_seq, last_seq, object_key, sha256, bytes, verified_at, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
        ON CONFLICT(bot_id, log_id, first_seq) DO UPDATE SET
          last_seq = ?5,
          object_key = ?6,
          sha256 = ?7,
          bytes = ?8,
          verified_at = ?9
      `).bind(
        chunkId,
        env.QQ_APP_ID,
        logId,
        firstSeq,
        lastSeq,
        receipt.key,
        receipt.digest,
        receipt.bytes,
        nowIso,
      ),
      env.DB.prepare(`
        UPDATE story_log_items
        SET chunk_id = ?1
        WHERE bot_id = ?2 AND log_id = ?3 AND sequence_number BETWEEN ?4 AND ?5
      `).bind(chunkId, env.QQ_APP_ID, logId, firstSeq, lastSeq),
      env.DB.prepare(`
        UPDATE story_logs
        SET cursor = MAX(COALESCE(cursor, 0), ?1),
            updated_at = datetime('now')
        WHERE bot_id = ?2 AND id = ?3
      `).bind(lastSeq, env.QQ_APP_ID, logId),
    ]);

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
    msg.retry();
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
