import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/e2e/**/*.test.{ts,mjs}'], environment: 'node', testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
});
