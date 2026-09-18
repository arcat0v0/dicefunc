export interface Env {
  QQ_APP_SECRET: string;
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  STORY_LOG_BUCKET: R2Bucket;
  CONFIG_BUCKET: R2Bucket;
  COMMAND_QUEUE: Queue<unknown>;
  ARCHIVE_QUEUE: Queue<unknown>;
}

// Type definitions for Cloudflare Workers bindings
export type { D1Database, KVNamespace, R2Bucket, Queue };
