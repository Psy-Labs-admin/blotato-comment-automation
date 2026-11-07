import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Real Postgres + Temporal + HTTP fakes: each test file gets its own database,
    // task queue and fake servers, so files can run in parallel processes.
    pool: 'forks',
    testTimeout: 45_000,
    hookTimeout: 90_000,
  },
});
