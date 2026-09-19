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
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
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

    const token = authHeader.slice(7).trim();
    if (!token) {
      deps.logger.log(
        buildLogEntry({
          level: 'warn',
          event: 'http.archive.unauthorized',
          component: 'http-archive',
          environment: c.env.ENVIRONMENT,
          outcome: 'empty_token',
          httpStatus: 404,
        }),
      );
      return c.text('Not Found', 404);
    }

    const tokenBytes = new TextEncoder().encode(token);
    const hashBuffer = await crypto.subtle.digest('SHA-256', tokenBytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const tokenHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    const grant = await c.env.DB.prepare(`
      SELECT g.token_hash, g.bot_id, g.archive_id, g.scope, g.expires_at, g.revoked_at, a.object_key, a.format
      FROM archive_grants g
      LEFT JOIN log_archives a ON a.id = g.archive_id AND a.bot_id = g.bot_id
      WHERE g.bot_id = ?1 AND g.token_hash = ?2 AND g.archive_id = ?3
      LIMIT 1
    `)
      .bind(c.env.QQ_APP_ID, tokenHash, archiveId)
      .first<{
        token_hash: string;
        bot_id: string;
        archive_id: string;
        scope: string;
        expires_at: string;
        revoked_at: string | null;
        object_key: string | null;
        format: string | null;
      }>();

    if (!grant) {
      deps.logger.log(
        buildLogEntry({
          level: 'warn',
          event: 'http.archive.not_found',
          component: 'http-archive',
          environment: c.env.ENVIRONMENT,
          outcome: 'grant_not_found',
          httpStatus: 404,
        }),
      );
      return c.text('Not Found', 404);
    }

    if (grant.revoked_at !== null && grant.revoked_at !== '') {
      deps.logger.log(
        buildLogEntry({
          level: 'warn',
          event: 'http.archive.revoked',
          component: 'http-archive',
          environment: c.env.ENVIRONMENT,
          outcome: 'token_revoked',
          httpStatus: 404,
        }),
      );
      return c.text('Not Found', 404);
    }

    const expiresTime = new Date(grant.expires_at).getTime();
    if (Number.isNaN(expiresTime) || expiresTime <= Date.now()) {
      deps.logger.log(
        buildLogEntry({
          level: 'warn',
          event: 'http.archive.expired',
          component: 'http-archive',
          environment: c.env.ENVIRONMENT,
          outcome: 'token_expired',
          httpStatus: 404,
        }),
      );
      return c.text('Not Found', 404);
    }

    if (grant.scope !== 'read' && grant.scope !== 'archive:read' && !grant.scope.includes('read')) {
      deps.logger.log(
        buildLogEntry({
          level: 'warn',
          event: 'http.archive.forbidden_scope',
          component: 'http-archive',
          environment: c.env.ENVIRONMENT,
          outcome: 'invalid_scope',
          httpStatus: 404,
        }),
      );
      return c.text('Not Found', 404);
    }

    const auditId = `audit_${crypto.randomUUID()}`;
    try {
      await c.env.DB.prepare(`
        INSERT INTO log_audit_events (id, bot_id, action, resource_id, actor_scope_id, result, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
      `)
        .bind(auditId, c.env.QQ_APP_ID, 'archive.download', archiveId, grant.scope, 'success')
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

    const objectKey = grant.object_key ?? archiveId;
    const r2Object = await c.env.STORY_LOG_BUCKET.get(objectKey);
    if (!r2Object) {
      deps.logger.log(
        buildLogEntry({
          level: 'warn',
          event: 'http.archive.object_missing',
          component: 'http-archive',
          environment: c.env.ENVIRONMENT,
          outcome: 'r2_not_found',
          httpStatus: 404,
        }),
      );
      return c.text('Not Found', 404);
    }

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
    headers.set('Content-Disposition', 'attachment');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Content-Type', r2Object.httpMetadata?.contentType ?? 'application/octet-stream');

    return new Response(r2Object.body, {
      status: 200,
      headers,
    });
  });

  return app;
}
