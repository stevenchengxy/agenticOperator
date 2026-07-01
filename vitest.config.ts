import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    // Polyfill in-memory localStorage/sessionStorage when the env's is missing/broken (Node 26's
    // native experimental localStorage shadows happy-dom's). No-op on Node 22.
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: [
      '**/node_modules/**',
      '.next',
      'Action_and_Event_Manager',
      'event_manager',
      'resume-parser-agent',
      'raas_v4',
    ],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});
