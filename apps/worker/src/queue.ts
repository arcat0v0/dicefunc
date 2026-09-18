import type { ExecutionContext, Message, MessageBatch } from '@cloudflare/workers-types';
import type { QueueMessage, SceneType, VerifiedEvent } from '@dicefunc/core';
import { buildLogEntry } from '@dicefunc/core';
import type { Env } from './bindings.js';
import type { WorkerDependencies } from './index.js';
import { createDependencies } from './index.js';

async function handleCommandMessage(
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

  const row = await env.DB.prepare(`
    SELECT id, bot_id, event_id, message_key, conversation_seq, status, payload, config_digest, seed
    FROM received_events
    WHERE bot_id = ?1 AND event_id = ?2
    LIMIT 1
  `)
    .bind(env.QQ_APP_ID, lease.job.resourceId)
    .first<{
      id: string;
      bot_id: string;
      event_id: string;
      message_key: string;
      conversation_seq: number;
      status: string;
      payload: string | null;
      config_digest: string;
      seed: string | null;
    }>();

  if (!row) {
    await deps.stateStore.completeJob(
      env.QQ_APP_ID,
      jobId,
      lease.fencingToken,
      'dead',
      'EVENT_NOT_FOUND',
    );
    msg.ack();
    return;
  }

  const parts = row.message_key.split(':');
  const scene = (parts[0] ?? 'groupAt') as SceneType;
  const messageId = parts[parts.length - 1] ?? row.event_id;
  const externalId = parts.length > 2 ? parts.slice(1, -1).join(':') : (parts[1] ?? '');

  const verifiedEvent: VerifiedEvent = {
    botId: row.bot_id,
    scene,
    eventId: row.event_id,
    messageId,
    externalId,
    timestamp: new Date(),
    text: row.payload ?? '',
    sender: {
      scene,
      scopeId: externalId,
      externalId,
    },
  };

  const result = await deps.eventHandler.handle(verifiedEvent);

  if (result.success) {
    await deps.stateStore.completeJob(env.QQ_APP_ID, jobId, lease.fencingToken, 'completed');
    msg.ack();
    return;
  }

  const isRetryable =
    result.error?.retryable !== false && lease.job.attempts < lease.job.maxAttempts;

  if (isRetryable) {
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
      .bind(backoffSeconds, result.error?.code ?? 'RETRY', env.QQ_APP_ID, jobId, lease.fencingToken)
      .run();
    msg.retry();
  } else {
    await deps.stateStore.completeJob(
      env.QQ_APP_ID,
      jobId,
      lease.fencingToken,
      'dead',
      result.error?.code ?? 'EXECUTION_FAILED',
    );
    msg.ack();
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
