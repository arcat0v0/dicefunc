import {
  CloudflareQueuesClient,
  D1StateStore,
  QQReplySender,
  QQTokenProvider,
  R2ArchiveStore,
  RuntimeLoggerAdapter,
} from '@dicefunc/adapters';
import {
  CommandExecutor,
  type CommandRegistry,
  DefaultEventHandler,
  createDefaultCommandRegistry,
} from '@dicefunc/core';
import type { Env } from './bindings.js';
import { createHttpApp } from './http.js';
import { queue } from './queue.js';
import { scheduled } from './scheduled.js';

export interface WorkerDependencies {
  readonly stateStore: D1StateStore;
  readonly jobQueue: CloudflareQueuesClient;
  readonly archiveStore: R2ArchiveStore;
  readonly logger: RuntimeLoggerAdapter;
  readonly tokenProvider: QQTokenProvider;
  readonly replySender: QQReplySender;
  readonly commandRegistry: CommandRegistry;
  readonly commandExecutor: CommandExecutor;
  readonly eventHandler: DefaultEventHandler;
}

let cachedTokenProvider: { appId: string; provider: QQTokenProvider } | undefined;

function getTokenProvider(env: Env): QQTokenProvider {
  if (cachedTokenProvider?.appId === env.QQ_APP_ID) {
    return cachedTokenProvider.provider;
  }

  const provider = new QQTokenProvider({
    appId: env.QQ_APP_ID,
    clientSecret: env.QQ_APP_SECRET,
    httpClient: globalThis.fetch.bind(globalThis),
    storage: env.CONFIG_KV,
  });
  cachedTokenProvider = { appId: env.QQ_APP_ID, provider };
  return provider;
}

export function createDependencies(env: Env): WorkerDependencies {
  const stateStore = new D1StateStore(env.DB);
  const jobQueue = new CloudflareQueuesClient(env.COMMAND_QUEUE, env.ARCHIVE_QUEUE);
  const archiveStore = new R2ArchiveStore(env.STORY_LOG_BUCKET);
  const logger = new RuntimeLoggerAdapter({ environment: env.ENVIRONMENT });
  const tokenProvider = getTokenProvider(env);
  const replySender = new QQReplySender({
    tokenProvider,
    httpClient: globalThis.fetch.bind(globalThis),
    logger,
    environment: env.ENVIRONMENT,
  });
  const commandRegistry = createDefaultCommandRegistry();
  const commandExecutor = new CommandExecutor(commandRegistry);
  const eventHandler = new DefaultEventHandler(stateStore, commandExecutor);

  return {
    stateStore,
    jobQueue,
    archiveStore,
    logger,
    tokenProvider,
    replySender,
    commandRegistry,
    commandExecutor,
    eventHandler,
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const deps = createDependencies(env);
    const app = createHttpApp(deps);
    return app.fetch(request, env, ctx);
  },
  queue,
  scheduled,
};
