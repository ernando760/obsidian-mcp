import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: { obsidian: fileURLToPath(new URL('./tests/obsidian.ts', import.meta.url)) } },
  test: { pool: 'threads', maxWorkers: 1, minWorkers: 1, include: ['tests/**/*.test.ts'], testTimeout: process.platform === 'win32' ? 60000 : 10000 },
});
