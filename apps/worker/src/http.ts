import { handleQQWebhook } from '@dicefunc/adapters';
import type { QQWebhookDependencies, QQWebhookInput } from '@dicefunc/adapters';
import { buildLogEntry } from '@dicefunc/core';
import { Hono } from 'hono';
import type { Env } from './bindings.js';
import type { WorkerDependencies } from './index.js';
import { handleCommandMessage } from './queue.js';
export function createHttpApp(deps: WorkerDependencies): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/health', (c) => {
    return c.text('ok');
  });

  app.post('/webhooks/qq', async (c) => {
    const rawBody = await c.req.arrayBuffer();
    const signature =
      c.req.header('x-signature-ed25519') ?? c.req.header('X-Signature-Ed25519') ?? undefined;
    const timestamp =
      c.req.header('x-signature-timestamp') ?? c.req.header('X-Signature-Timestamp') ?? undefined;

    const input: QQWebhookInput = {
      rawBody,
      signature,
      timestamp,
    };

    const webhookDeps: QQWebhookDependencies = {
      stateStore: deps.stateStore,
      queue: deps.jobQueue,
      botId: c.env.QQ_APP_ID,
      botSecret: c.env.QQ_APP_SECRET ?? null,
      configDigest: 'dev-bundle',
    };

    const result = await handleQQWebhook(input, webhookDeps, deps.logger);
    if (result.enqueuedJobId && result.preloaded) {
      c.executionCtx.waitUntil(
        handleCommandMessage(result.enqueuedJobId, undefined, c.env, deps, result.preloaded).catch(
          (err) => {
            deps.logger.log(
              buildLogEntry({
                level: 'warn',
                event: 'qq.webhook.background_dispatch_failed',
                component: 'qq-webhook',
                environment: c.env.ENVIRONMENT,
                jobId: result.enqueuedJobId,
                outcome: 'retryable',
                errorCode: err instanceof Error ? err.name : 'BACKGROUND_DISPATCH_ERROR',
              }),
            );
          },
        ),
      );
    }

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  });

  app.get('/archives/:id', async (c) => {
    const archiveId = c.req.param('id');
    const authHeader = c.req.header('authorization') ?? c.req.header('Authorization');
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const token = headerToken || c.req.query('token')?.trim() || '';

    if (!token) {
      deps.logger.log(
        buildLogEntry({
          level: 'warn',
          event: 'http.archive.unauthorized',
          component: 'http-archive',
          environment: c.env.ENVIRONMENT,
          outcome: 'missing_token',
          httpStatus: 404,
        }),
      );
      return c.text('Not Found', 404);
    }

    const tokenBytes = new TextEncoder().encode(token);
    const hashBuffer = await crypto.subtle.digest('SHA-256', tokenBytes);
    const tokenHash = Array.from(new Uint8Array(hashBuffer), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const grant = await c.env.DB.prepare(`
      SELECT g.archive_id, g.scope, g.expires_at, g.revoked_at,
             a.log_id, a.status, a.format, a.deletion_status, a.snapshot_cursor
      FROM archive_grants g
      JOIN log_archives a ON a.id = g.archive_id AND a.bot_id = g.bot_id
      WHERE g.bot_id = ?1 AND g.token_hash = ?2 AND g.archive_id = ?3
      LIMIT 1
    `)
      .bind(c.env.QQ_APP_ID, tokenHash, archiveId)
      .first<{
        archive_id: string;
        scope: string;
        expires_at: string;
        revoked_at: string | null;
        log_id: string;
        status: string;
        format: string;
        deletion_status: string;
        snapshot_cursor: number;
      }>();

    const expiresTime = grant ? new Date(grant.expires_at).getTime() : Number.NaN;
    const authorized =
      grant !== null &&
      grant !== undefined &&
      (!grant.revoked_at || grant.revoked_at.length === 0) &&
      Number.isFinite(expiresTime) &&
      expiresTime > Date.now() &&
      (grant.scope === 'read' || grant.scope === 'archive:read' || grant.scope.includes('read')) &&
      grant.status === 'ready' &&
      grant.deletion_status === 'none';

    if (!authorized || !grant) {
      deps.logger.log(
        buildLogEntry({
          level: 'warn',
          event: 'http.archive.unauthorized',
          component: 'http-archive',
          environment: c.env.ENVIRONMENT,
          outcome: 'invalid_grant',
          httpStatus: 404,
        }),
      );
      return c.text('Not Found', 404);
    }

    const auditId = `audit_${crypto.randomUUID()}`;
    try {
      await c.env.DB.prepare(`
        INSERT INTO log_audit_events (
          id, bot_id, action, resource_id, actor_scope_id, result, created_at
        )
        VALUES (?1, ?2, 'archive.download', ?3, ?4, 'success', datetime('now'))
      `)
        .bind(auditId, c.env.QQ_APP_ID, archiveId, grant.scope)
        .run();
    } catch {
      deps.logger.log(
        buildLogEntry({
          level: 'error',
          event: 'http.archive.audit_failed',
          component: 'http-archive',
          environment: c.env.ENVIRONMENT,
          outcome: 'audit_insert_error',
          errorCode: 'AUDIT_WRITE_ERROR',
          httpStatus: 500,
        }),
      );
      return c.text('Internal Server Error', 500);
    }

    const chunkResult = await c.env.DB.prepare(`
      SELECT object_key, sha256, bytes
      FROM story_chunks
      WHERE bot_id = ?1 AND log_id = ?2 AND last_seq <= ?3
      ORDER BY first_seq ASC
    `)
      .bind(c.env.QQ_APP_ID, grant.log_id, grant.snapshot_cursor)
      .all<{ object_key: string; sha256: string; bytes: number }>();
    const chunks = chunkResult.results ?? [];

    for (const chunk of chunks) {
      const object = await c.env.STORY_LOG_BUCKET.head(chunk.object_key);
      if (
        !object ||
        object.size !== chunk.bytes ||
        object.customMetadata?.digest !== chunk.sha256
      ) {
        deps.logger.log(
          buildLogEntry({
            level: 'error',
            event: 'http.archive.object_invalid',
            component: 'http-archive',
            environment: c.env.ENVIRONMENT,
            outcome: 'archive_incomplete',
            errorCode: 'ARCHIVE_OBJECT_INVALID',
            httpStatus: 409,
          }),
        );
        return c.text('Archive unavailable', 409);
      }
    }

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (const chunk of chunks) {
            const object = await c.env.STORY_LOG_BUCKET.get(chunk.object_key);
            if (!object) {
              throw new Error('Archive object missing');
            }
            const reader = object.body.getReader();
            while (true) {
              const part = await reader.read();
              if (part.done) {
                break;
              }
              controller.enqueue(part.value);
            }
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    deps.logger.log(
      buildLogEntry({
        level: 'info',
        event: 'http.archive.success',
        component: 'http-archive',
        environment: c.env.ENVIRONMENT,
        outcome: 'success',
        httpStatus: 200,
      }),
    );

    const headers = new Headers();
    headers.set('Cache-Control', 'private, no-store');
    const isTextArchive = grant.format === 'txt';
    headers.set(
      'Content-Disposition',
      `attachment; filename="${archiveId}.${isTextArchive ? 'txt' : 'jsonl'}"`,
    );
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set(
      'Content-Type',
      isTextArchive ? 'text/plain; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
    );

    return new Response(body, {
      status: 200,
      headers,
    });
  });

  return app;
}
