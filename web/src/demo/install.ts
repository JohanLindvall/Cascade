/**
 * Puts the simulated server in place of the real one: fetch and EventSource
 * answer the API's URLs from a session running in this page, and pass every
 * other URL on. Imported by entry.ts before the app, so nothing of the app
 * runs without it.
 */
import { API_BASE } from '../api.ts';
import { DemoServer } from './backend.ts';
import { demoEventSource, demoFetch, type Transport } from './transport.ts';

/** One session for every visitor: the same torrents and the same timeline from the moment the page is first shown. */
const SEED = 0xca5cade;
/** The server's preferences file, kept in this browser so a chosen theme outlasts a reload. */
const PREFERENCES_KEY = 'cascade.demo.prefs';

function savedPreferences(): unknown {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined; // Blocked or unreadable storage starts from the defaults.
  }
}

function startServer(): DemoServer {
  return new DemoServer({
    now: () => Date.now(),
    timers: {
      set: (run, ms) => window.setTimeout(run, ms),
      clear: (handle) => window.clearTimeout(handle as number | undefined),
    },
    seed: SEED,
    version: __CASCADE_RTORRENT_VERSION__,
    preferences: savedPreferences(),
    onPreferences: (preferences) => {
      try {
        localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
      } catch {
        // Private mode or a full quota: they last for this visit.
      }
    },
  });
}

let server: DemoServer | undefined;

const transport: Transport = {
  // Started by the first request rather than at load: a page opened in a
  // background tab asks for nothing until it is shown (the stream and the
  // polls wait for that), and a session started at load would have run its
  // first finish and badge before anyone could see them.
  get server() {
    return (server ??= startServer());
  },
  apiBase: API_BASE,
  baseUri: document.baseURI,
  // A server on the local network: quick, but not so quick that loading states never show.
  latency: () => 20 + Math.random() * 50,
};

window.fetch = demoFetch(transport, window.fetch.bind(window));
window.EventSource = demoEventSource(transport, window.EventSource);
