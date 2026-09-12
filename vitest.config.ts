import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/server/**/*.test.ts', 'tests/verification/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
