import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  test: {
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'ui/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
