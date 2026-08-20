import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the UI can be served from any WEB_BASE_PATH prefix.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
