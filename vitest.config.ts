import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Keeps the suite independent of whether a password is set on this machine.
    setupFiles: ['tests/setup.ts'],
  },
});
