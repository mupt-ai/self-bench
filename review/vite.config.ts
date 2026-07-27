import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../src/selfbench/review_dist', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: ['avyays-mac-mini.tailf3cee5.ts.net'],
    proxy: {
      '/api': 'http://127.0.0.1:8765',
    },
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: ['avyays-mac-mini.tailf3cee5.ts.net'],
  },
});
