import { defineConfig } from 'vite';

export default defineConfig({
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
