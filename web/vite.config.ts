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
  // `npm run dev` proxies the API to a running container: localhost:8080, or
  // CASCADE_DEV_TARGET for another port or host.
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.CASCADE_DEV_TARGET ?? 'http://localhost:8080',
    },
  },
});
