import { createApp } from './app';
import { loadConfig } from './config';
import { renderHelp } from './options';
import { describeTarget } from './scgi';
import { RtorrentService } from './service';
import { Store } from './store';

// Before anything is opened or read: `docker run --rm cascade --help` should
// print and exit whatever the environment looks like.
if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h' || arg === 'help')) {
  console.log(renderHelp());
  process.exit(0);
}

const config = loadConfig();
const store = new Store(config.stateFile);
const service = new RtorrentService(config, store);
const app = createApp(service, config, store);

const server = app.listen(config.port, config.host, () => {
  console.log(`[cascade] listening on http://${config.host}:${config.port}${config.basePath}`);
  console.log(`[cascade] rtorrent SCGI endpoint: ${describeTarget(config.scgi)}`);
  if (!config.user || !config.password) {
    console.log('[cascade] authentication disabled (set WEB_USER and WEB_PASS to enable)');
  }
  service.startPolling();
});

function shutdown(signal: string): void {
  console.log(`[cascade] ${signal} received, shutting down`);
  service.stopPolling();
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
