/**
 * The express application: auth, the JSON API, the XML-RPC passthrough and
 * the static SPA, with every error mapped to a JSON body. Kept apart from
 * index.ts so a test can mount it on a port of its own without starting the
 * poller or reading the environment.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createApi, createRpcProxy } from './api';
import { basicAuth } from './auth';
import type { Config } from './config';
import { isCrossSiteRequest } from './crossSite';
import { HttpError } from './errors';
import type { RtorrentService } from './service';
import type { Store } from './store';
import { XmlRpcFault } from './xmlrpc';

export function createApp(service: RtorrentService, config: Config, store: Store): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Cheap, compatible hardening on every response: no MIME sniffing of what
  // is served, and no URL (which carries the base path) leaking in Referer to
  // anything outside this origin. Framing is deliberately left alone —
  // dashboards embed Cascade in iframes.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const router = express.Router();

  // Health stays outside Basic auth so container healthchecks and orchestrator
  // probes work when WEB_USER/WEB_PASS are set. It reveals nothing but liveness.
  router.get('/healthz', (_req, res) => {
    res.json({ ok: true, rtorrent: service.capabilities.ready });
  });

  // Before auth, so a hostile page learns nothing — not even whether a
  // password is set. See crossSite.ts for what is refused and why.
  router.use((req, res, next) => {
    const forwarded = req.get('x-forwarded-host')?.split(',')[0]?.trim();
    const refused = isCrossSiteRequest({
      method: req.method,
      origin: req.get('origin'),
      fetchSite: req.get('sec-fetch-site'),
      host: forwarded || req.get('host'),
    });
    if (!refused) return next();
    res.status(403).json({ error: 'cross-site request refused' });
  });

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

  // Static SPA assets, with a history fallback for client-side routing.
  //
  // Vite writes content-hashed files under assets/, so those are immutable: a
  // rebuild changes their names, never their bytes. Everything else — above all
  // the shell that names those hashes — must revalidate on every load, or a
  // browser that cached yesterday's index.html asks for hashed files that no
  // longer exist after a redeploy and shows a blank page until a hard reload.
  // no-cache still gives 304s (the files carry real mtimes), so it costs a
  // conditional request, not a re-download.
  const indexHtml = path.join(config.webRoot, 'index.html');
  router.use(
    express.static(config.webRoot, {
      index: false,
      setHeaders: (res, filePath) => {
        const hashed = filePath.startsWith(path.join(config.webRoot, 'assets') + path.sep);
        res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );
  router.get('*', (_req, res) => {
    if (!fs.existsSync(indexHtml)) {
      res.status(500).type('text/plain').send(`web assets not found at ${config.webRoot}`);
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });

  app.use(config.basePath === '/' ? '/' : config.basePath, router);
  app.use(errorHandler);
  return app;
}

/**
 * Every failure answers JSON with a status that means something: HttpErrors
 * carry their own, an rtorrent fault is a 502 with rtorrent's message, an
 * oversized upload is a 413, and only the unexpected is a 500.
 */
function errorHandler(error: Error, _req: Request, res: Response, _next: NextFunction): void {
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
  // express.json answers a malformed body with a SyntaxError carrying a status.
  const status = (error as { status?: number }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: error.message || 'bad request' });
    return;
  }
  console.error('[cascade]', error);
  res.status(500).json({ error: error.message || 'internal error' });
}
