import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineWorkersConfig({
  resolve: {
    alias: {
      '@dicefunc/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
      '@dicefunc/adapters': path.resolve(__dirname, '../../packages/adapters/src/index.ts'),
      '@dicefunc/config': path.resolve(__dirname, '../../packages/config/src/index.ts'),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    poolOptions: {
      workers: {
        isolatedStorage: true,
        miniflare: {
          compatibilityDate: '2026-09-18',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: {
            DB: 'dicefunc-db',
          },
          kvNamespaces: ['CONFIG_KV'],
          r2Buckets: ['STORY_LOG_BUCKET', 'CONFIG_BUCKET'],
          queueProducers: {
            COMMAND_QUEUE: 'command-queue',
            ARCHIVE_QUEUE: 'archive-queue',
          },
          queueConsumers: {
            'command-queue': {
              maxBatchSize: 10,
              maxRetries: 3,
              deadLetterQueue: 'command-dlq',
            },
            'archive-queue': {
              maxBatchSize: 5,
              maxRetries: 5,
              deadLetterQueue: 'archive-dlq',
            },
          },
        },
      },
    },
  },
});
