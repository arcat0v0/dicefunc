import type { QueueMessage } from '@dicefunc/core';

export interface Env {
  ENVIRONMENT: string;
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  STORY_LOG_BUCKET: R2Bucket;
  CONFIG_BUCKET: R2Bucket;
  COMMAND_QUEUE: Queue<QueueMessage>;
  ARCHIVE_QUEUE: Queue<QueueMessage>;
  QQ_APP_ID: string;
  QQ_APP_SECRET: string;
  BOT_TIMEZONE?: string;
  PUBLIC_BASE_URL?: string;
}
