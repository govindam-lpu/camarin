import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      MOCK_DELAY_MS: '0',
      JWT_SECRET: 'test-secret',
      LOCAL_STORAGE_DIR: './.test-uploads',
    },
    // First run downloads a mongod binary for mongodb-memory-server.
    hookTimeout: 120_000,
    testTimeout: 20_000,
  },
});
