import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    open: true,
    watch: {
      ignored: ['**/output/**', '**/dist/**'],
    },
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/events': 'http://127.0.0.1:8787',
    },
  },
});
