import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    pool: 'threads',
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node'
  }
});
