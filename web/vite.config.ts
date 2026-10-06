// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Where pages.yml publishes the demo: a link preview needs absolute URLs. A
 * fork that publishes its own sets CASCADE_DEMO_URL.
 */
const DEMO_SITE = (process.env.CASCADE_DEMO_URL ?? 'https://johanlindvall.github.io/Cascade/').replace(/\/?$/, '/');
/** The image a shared link unfurls with, also the repository's social preview. */
const PREVIEW = 'social-preview.png';

/**
 * The live demo (`--mode demo`): the same index.html — and so the same
 * pre-paint theme script — booted through src/demo/entry.ts, which installs
 * the simulated server before it loads the app. The production build never
 * sees the demo's modules: nothing outside src/demo imports them.
 */
function demoEntry(): Plugin {
  const description =
    'Try Cascade, a web UI for rtorrent, in your browser: the real interface over a simulated rtorrent, so nothing is downloaded.';
  const head = [
    '<title>Cascade — live demo</title>',
    `<meta name="description" content="${description}" />`,
    `<link rel="canonical" href="${DEMO_SITE}" />`,
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="Cascade" />',
    '<meta property="og:title" content="Cascade — live demo" />',
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${DEMO_SITE}" />`,
    `<meta property="og:image" content="${new URL(PREVIEW, DEMO_SITE)}" />`,
    '<meta property="og:image:width" content="1280" />',
    '<meta property="og:image:height" content="640" />',
    '<meta property="og:image:alt" content="Cascade\'s torrent list: downloads under way, seeding torrents and live transfer rates" />',
    '<meta name="twitter:card" content="summary_large_image" />',
  ].join('\n    ');
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
        return html.replace(entry, '/src/demo/entry.ts').replace(title, head);
      },
    },
    // Only the demo publishes the preview; docs/ holds it for the repository settings too.
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: PREVIEW, source: readFileSync(new URL(`../docs/${PREVIEW}`, import.meta.url)) });
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
