import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The live demo (`--mode demo`): the same index.html — and so the same
 * pre-paint theme script — booted through src/demo/entry.ts, which installs
 * the simulated server before it loads the app. The production build never
 * sees the demo's modules: nothing outside src/demo imports them.
 */
function demoEntry(): Plugin {
  return {
    name: 'cascade-demo-entry',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const entry = '/src/main.tsx';
        const title = '<title>Cascade</title>';
        // A renamed entry must fail the build, not ship the app without its server.
        if (!html.includes(entry)) throw new Error(`index.html no longer loads ${entry}; update the demo's entry swap`);
        // The demo's own name in tabs, history, bookmarks and link previews, not that of every install.
        if (!html.includes(title)) throw new Error(`index.html no longer has ${title}; update the demo's title swap`);
        return html.replace(entry, '/src/demo/entry.ts').replace(
          title,
          '<title>Cascade — live demo</title>\n    <meta name="description" content="Try Cascade, a web UI for rtorrent, in your browser: ' +
            'the real interface over a simulated rtorrent, so nothing is downloaded." />',
        );
      },
    },
  };
}

/** The Dockerfile's default rtorrent, so the demo presents the release the image ships. */
function rtorrentVersion(): string {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const version = /^ARG RTORRENT_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
  if (!version) throw new Error('no ARG RTORRENT_VERSION in the Dockerfile');
  return version;
}

// Relative base so the UI can be served from any WEB_BASE_PATH prefix.
export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  return {
    base: './',
    plugins: demo ? [react(), demoEntry()] : [react()],
    define: demo ? { __CASCADE_RTORRENT_VERSION__: JSON.stringify(rtorrentVersion()) } : {},
    build: {
      outDir: demo ? 'dist-demo' : 'dist',
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
  };
});
