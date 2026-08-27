import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      'gateswarm-lite': fileURLToPath(new URL('./packages/gateswarm-lite/src/index.ts', import.meta.url)),
      'gateswarm-router': fileURLToPath(new URL('./packages/gateswarm-router/src/index.ts', import.meta.url)),
      'gateswarm-mcp': fileURLToPath(new URL('./packages/gateswarm-mcp/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'public/index.html',
        dashboard: 'public/dashboard.html',
      },
    },
  },
  server: {
    port: 4174,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live-ollama.test.ts'],
  },
});
