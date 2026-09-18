import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { buildLogEntry } from '@dicefunc/core';
import type { Env } from './bindings.js';
import type { WorkerDependencies } from './index.js';
import { createDependencies } from './index.js';

export async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  dependencies?: WorkerDependencies,
): Promise<void> {
  const deps = dependencies ?? createDependencies(env);

  const recoverableLimit = 20;
  const recoverableJobs = await deps.stateStore.listRecoverableJobs(
    env.QQ_APP_ID,
    recoverableLimit,
  );

  for (const job of recoverableJobs) {
    if (job.type === 'command') {
      await deps.jobQueue.enqueueCommand({
        jobId: job.jobId,
        type: 'command',
        schemaVersion: 1,
      });
    } else if (job.type === 'archive-chunk') {
      await deps.jobQueue.enqueueArchive({
        jobId: job.jobId,
        type: 'archive-chunk',
        schemaVersion: 1,
      });
    }
  }

  deps.logger.log(
    buildLogEntry({
      level: 'info',
      event: 'scheduled.recover_jobs',
      component: 'scheduled',
      environment: env.ENVIRONMENT,
      outcome: 'success',
      metadata: {
        recoveredCount: recoverableJobs.length,
      },
    }),
  );

  const purgeResult = await deps.stateStore.purgeExpiredData(env.QQ_APP_ID, {
    resultDays: 7,
    dedupDays: 30,
    auditDays: 90,
  });

  deps.logger.log(
    buildLogEntry({
      level: 'info',
      event: 'scheduled.purge_expired',
      component: 'scheduled',
      environment: env.ENVIRONMENT,
      outcome: 'success',
      metadata: {
        results: purgeResult.results,
        events: purgeResult.events,
        audits: purgeResult.audits,
      },
    }),
  );
}
