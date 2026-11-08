import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // Real Postgres + Temporal + HTTP fakes: each test file gets its own database,
    // task queue and fake servers, so files can run in parallel processes.
    pool: 'forks',
    maxWorkers: 3, // Real integration suites share PostgreSQL's finite connection budget.
    testTimeout: 45_000,
    hookTimeout: 90_000,
  },
});
