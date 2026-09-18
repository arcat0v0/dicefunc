import { DefaultEventHandler } from '../packages/core/src/application/handle-event';
import { D1StateStore } from '../../packages/adapters/src/d1/state-store';
import { R2ArchiveStore } from '../../packages/adapters/src/r2/archive-store';

export interface QueueMessage {
  type: 'command' | 'reply' | 'archive' | 'purge';
  eventId?: string;
  executionId?: string;
  logId?: string;
  data?: unknown;
}

export async function processQueue(message: QueueMessage, env: Env): Promise<void> {
  try {
    if (message.type === 'command' && message.eventId) {
      await handleCommandEvent(message, env);
    } else if (message.type === 'archive' && message.logId) {
      await handleArchiveTask(message, env);
    }
  } catch (error) {
    console.error(`Failed to process ${message.type} job:`, error);
    throw error;
  }
}

async function handleCommandEvent(
  message: QueueMessage,
  env: Env
): Promise<void> {
  if (!message.eventId || !message.data) {
    throw new Error('Missing eventId or data for command event');
  }
  
  const stateStore = new D1StateStore(env.DB);
  const handler = new DefaultEventHandler(stateStore);
  
  const verifiedEvent = message.data as Record<string, unknown>;
  
  const outcome = await handler.handle({
    botId: 'default_bot',
    scene: 'groupAt',
    externalId: verifiedEvent.externalId || 'unknown',
    messageId: message.eventId,
    timestamp: new Date(),
    text: verifiedEvent.text || undefined,
    sender: {
      scene: 'groupAt',
      scopeId: verifiedEvent.sender?.scopeId || 'unknown',
      externalId: verifiedEvent.sender?.externalId || 'unknown'
    },
    rawBody: new TextEncoder().encode(JSON.stringify(verifiedEvent))
  });
  
  if (!outcome.success) {
    console.error(`Event handling failed:`, outcome.error);
  }
}

async function handleArchiveTask(
  message: QueueMessage,
  env: Env
): Promise<void> {
  if (!message.logId) {
    throw new Error('Missing logId for archive task');
  }
  
  const archiveStore = new R2ArchiveStore(env.STORY_LOG_BUCKET);
  
  // TODO: Implement full archive logic
  console.log(`Archiving story log: ${message.logId}`);
}
