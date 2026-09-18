import { VerifiedEvent, Principal, SceneType } from '../packages/core/src/ports/state-store';
import { handleWebhook as qqHandleWebhook } from '../../packages/adapters/src/qq/webhook';

export interface WebhookContext {
  body: string;
  signature?: string;
  timestamp?: string;
  env: WorkerEnv;
}

export interface WorkerEnv {
  QQ_APP_SECRET: string;
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  COMMAND_QUEUE: Queue<unknown>;
}

export interface WebhookResponse {
  ret: number;
  msg: string;
  data?: {
    nonce_str: string;
    timestamp: number;
  };
}

export async function handleWebhook(context: WebhookContext): Promise<WebhookResponse> {
  return await qqHandleWebhook(context);
}
