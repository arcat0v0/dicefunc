import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@dicefunc/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@dicefunc/adapters': path.resolve(__dirname, 'packages/adapters/src/index.ts'),
      '@dicefunc/config': path.resolve(__dirname, 'packages/config/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/runtime/**/*.test.ts'],
  },
});
