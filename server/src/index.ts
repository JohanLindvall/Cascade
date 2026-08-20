import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createApi, createRpcProxy } from './api';
import { basicAuth } from './auth';
import { config } from './config';
import { HttpError, RtorrentService } from './service';
import { Store } from './store';
import { XmlRpcFault } from './xmlrpc';
import { describeTarget } from './scgi';

const store = new Store(config.stateFile);
const service = new RtorrentService(config, store);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

const router = express.Router();
router.use(basicAuth(config));

// The XML-RPC proxy needs the untouched body; mount it before the JSON parser.
router.post(
  '/RPC2',
  express.raw({ type: ['text/xml', 'application/xml', 'application/octet-stream'], limit: '16mb' }),
  express.json({ limit: '1mb' }),
  createRpcProxy(service, config),
);

router.use(express.json({ limit: '4mb' }));
router.use('/api', createApi(service, config, store));

router.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    rtorrent: service.capabilities.ready,
    endpoint: describeTarget(config.scgi),
  });
});

// Static SPA assets, with a history fallback for client-side routing.
const indexHtml = path.join(config.webRoot, 'index.html');
router.use(express.static(config.webRoot, { index: false, maxAge: '1h' }));
router.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (!fs.existsSync(indexHtml)) {
    res.status(500).type('text/plain').send(`web assets not found at ${config.webRoot}`);
    return;
  }
  res.sendFile(indexHtml);
});

app.use(config.basePath === '/' ? '/' : config.basePath, router);

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof XmlRpcFault) {
    res.status(502).json({ error: error.faultString, faultCode: error.faultCode });
    return;
  }
  const multerCode = (error as { code?: string }).code;
  if (multerCode === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'torrent file exceeds the upload size limit' });
    return;
  }
  console.error('[cascade]', error);
  res.status(500).json({ error: error.message || 'internal error' });
});

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
