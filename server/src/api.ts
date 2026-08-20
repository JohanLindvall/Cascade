import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import type { Config } from './config';
import { HttpError, type RtorrentService } from './service';
import type { Store } from './store';
import { XmlRpcFault, serializeCall, type XValue } from './xmlrpc';

function wrap(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `"${field}" is required`);
  }
  return value.trim();
}

function asBool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}

const HASH_RE = /^[0-9A-Fa-f]{40}$/;

function requireHash(req: Request): string {
  const hash = String(req.params.hash ?? '');
  if (!HASH_RE.test(hash)) throw new HttpError(400, 'invalid info hash');
  return hash.toUpperCase();
}

export function createApi(service: RtorrentService, config: Config, store: Store): Router {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 50 },
  });

  /* ------------------------------- reads ------------------------------- */

  router.get(
    '/state',
    wrap(async (_req, res) => {
      const state = await service.state();
      res.json(state);
    }),
  );

  router.get(
    '/status',
    wrap(async (_req, res) => res.json(await service.status())),
  );

  router.get(
    '/torrents',
    wrap(async (req, res) => {
      const view = typeof req.query.view === 'string' ? req.query.view : 'main';
      res.json(await service.torrents(view));
    }),
  );

  /* ---------------------------- preferences ---------------------------- */

  router.get(
    '/prefs',
    wrap(async (_req, res) => res.json(store.preferences())),
  );

  router.patch(
    '/prefs',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(store.updatePreferences(body));
    }),
  );

  router.get(
    '/game',
    wrap(async (_req, res) => res.json(service.game())),
  );

  router.get(
    '/capabilities',
    wrap(async (_req, res) => {
      await service.capabilities.ensure();
      res.json(service.backendSummary());
    }),
  );

  router.get(
    '/torrents/:hash/files',
    wrap(async (req, res) => res.json(await service.files(requireHash(req)))),
  );

  router.get(
    '/torrents/:hash/peers',
    wrap(async (req, res) => res.json(await service.peers(requireHash(req)))),
  );

  router.get(
    '/torrents/:hash/trackers',
    wrap(async (req, res) => res.json(await service.trackers(requireHash(req)))),
  );

  router.get(
    '/trackers',
    wrap(async (req, res) => {
      const raw = typeof req.query.hashes === 'string' ? req.query.hashes : '';
      const hashes = raw.split(',').filter((hash) => HASH_RE.test(hash));
      res.json(await service.trackerHosts(hashes));
    }),
  );

  /* -------------------------------- add -------------------------------- */

  router.post(
    '/torrents/upload',
    upload.array('torrents'),
    wrap(async (req, res) => {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const body = req.body as Record<string, string>;
      const start = asBool(body.start, true);
      const directory = body.directory?.trim() || undefined;
      const label = body.label?.trim() || undefined;

      const urls = (body.urls ?? '')
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter(Boolean);

      if (files.length === 0 && urls.length === 0) {
        throw new HttpError(400, 'no .torrent files or URLs supplied');
      }

      const errors: string[] = [];
      for (const file of files) {
        try {
          await service.addTorrentFile(file.buffer, { start, directory, label });
        } catch (error) {
          errors.push(`${file.originalname}: ${(error as Error).message}`);
        }
      }
      for (const url of urls) {
        try {
          await service.addTorrentUrl(url, { start, directory, label });
        } catch (error) {
          errors.push(`${url}: ${(error as Error).message}`);
        }
      }
      res.json({ added: files.length + urls.length - errors.length, errors });
    }),
  );

  router.post(
    '/torrents/url',
    wrap(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const url = requireString(body.url, 'url');
      await service.addTorrentUrl(url, {
        start: asBool(body.start, true),
        directory: typeof body.directory === 'string' ? body.directory : undefined,
        label: typeof body.label === 'string' ? body.label : undefined,
      });
      res.json({ ok: true });
    }),
  );

  /* ------------------------------ mutations ---------------------------- */

  router.post(
    '/torrents/:hash/action/:action',
    wrap(async (req, res) => {
      await service.action(requireHash(req), String(req.params.action));
      res.json({ ok: true });
    }),
  );

  router.post(
    '/torrents/action/:action',
    wrap(async (req, res) => {
      const body = req.body as { hashes?: unknown };
      const hashes = Array.isArray(body.hashes) ? body.hashes.map(String) : [];
      const action = String(req.params.action);
      const errors: string[] = [];
      for (const hash of hashes) {
        if (!HASH_RE.test(hash)) continue;
        try {
          await service.action(hash, action);
        } catch (error) {
          errors.push(`${hash}: ${(error as Error).message}`);
        }
      }
      res.json({ ok: errors.length === 0, errors });
    }),
  );

  router.delete(
    '/torrents/:hash',
    wrap(async (req, res) => {
      await service.remove(requireHash(req), asBool(req.query.deleteData));
      res.json({ ok: true });
    }),
  );

  router.post(
    '/torrents/remove',
    wrap(async (req, res) => {
      const body = req.body as { hashes?: unknown; deleteData?: unknown };
      const hashes = Array.isArray(body.hashes) ? body.hashes.map(String) : [];
      const deleteData = asBool(body.deleteData);
      const errors: string[] = [];
      for (const hash of hashes) {
        if (!HASH_RE.test(hash)) continue;
        try {
          await service.remove(hash, deleteData);
        } catch (error) {
          errors.push(`${hash}: ${(error as Error).message}`);
        }
      }
      res.json({ ok: errors.length === 0, errors });
    }),
  );

  router.patch(
    '/torrents/:hash',
    wrap(async (req, res) => {
      const hash = requireHash(req);
      const body = req.body as Record<string, unknown>;
      if (body.priority !== undefined) {
        await service.setPriority(hash, Number(body.priority));
      }
      if (body.label !== undefined) {
        await service.setLabel(hash, String(body.label));
      }
      if (body.throttle !== undefined) {
        await service.setTorrentThrottle(hash, String(body.throttle));
      }
      if (body.directory !== undefined) {
        await service.moveDirectory(hash, String(body.directory));
      }
      if (body.maxUploads !== undefined || body.maxDownloads !== undefined) {
        await service.setTorrentSlots(
          hash,
          body.maxUploads === undefined ? undefined : Number(body.maxUploads),
          body.maxDownloads === undefined ? undefined : Number(body.maxDownloads),
        );
      }
      res.json({ ok: true });
    }),
  );

  router.post(
    '/torrents/:hash/files/:index/priority',
    wrap(async (req, res) => {
      const priority = Number((req.body as { priority?: unknown }).priority);
      if (![0, 1, 2].includes(priority)) throw new HttpError(400, 'priority must be 0, 1 or 2');
      await service.setFilePriority(requireHash(req), Number(req.params.index), priority);
      res.json({ ok: true });
    }),
  );

  router.post(
    '/torrents/:hash/trackers/:index/enabled',
    wrap(async (req, res) => {
      const enabled = asBool((req.body as { enabled?: unknown }).enabled);
      await service.setTrackerEnabled(requireHash(req), Number(req.params.index), enabled);
      res.json({ ok: true });
    }),
  );

  router.post(
    '/torrents/:hash/trackers',
    wrap(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      await service.addTracker(requireHash(req), requireString(body.url, 'url'), Number(body.group ?? 0));
      res.json({ ok: true });
    }),
  );

  /* ------------------------------ settings ----------------------------- */

  router.get(
    '/settings',
    wrap(async (_req, res) => res.json(await service.settings())),
  );

  router.post(
    '/settings',
    wrap(async (req, res) => {
      await service.updateSettings(req.body ?? {});
      res.json(await service.settings());
    }),
  );

  /* --------------------------- throttle groups ------------------------- */

  router.get(
    '/throttles',
    wrap(async (_req, res) => {
      res.json({ groups: await serviceThrottles(service), rates: await service.throttleRates() });
    }),
  );

  router.post(
    '/throttles',
    wrap(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      await service.saveThrottle({
        name: requireString(body.name, 'name'),
        up: Math.max(0, Number(body.up) || 0),
        down: Math.max(0, Number(body.down) || 0),
      });
      res.json({ ok: true });
    }),
  );

  router.delete(
    '/throttles/:name',
    wrap(async (req, res) => {
      await service.deleteThrottle(String(req.params.name));
      res.json({ ok: true });
    }),
  );

  /* --------------------------------- log ------------------------------- */

  router.get(
    '/log',
    wrap(async (req, res) => {
      const lines = Math.min(2000, Math.max(1, Number(req.query.lines) || 300));
      res.json({ lines: await service.log(lines) });
    }),
  );

  /* ------------------------- raw rtorrent RPC -------------------------- */

  router.get(
    '/rpc/methods',
    wrap(async (_req, res) => {
      if (!config.allowRawRpc) throw new HttpError(403, 'raw RPC access is disabled');
      await service.capabilities.ensure();
      res.json({ methods: service.capabilities.methodNames() });
    }),
  );

  router.post(
    '/rpc',
    wrap(async (req, res) => {
      if (!config.allowRawRpc) throw new HttpError(403, 'raw RPC access is disabled');
      const body = req.body as { method?: unknown; params?: unknown };
      const method = requireString(body.method, 'method');
      const params = Array.isArray(body.params) ? (body.params as XValue[]) : [];
      try {
        const result = await service.client.call(method, params);
        res.json({ ok: true, result: jsonSafe(result) });
      } catch (error) {
        if (error instanceof XmlRpcFault) {
          res.status(200).json({
            ok: false,
            fault: { code: error.faultCode, message: error.faultString },
          });
          return;
        }
        throw error;
      }
    }),
  );

  router.post(
    '/rpc/help',
    wrap(async (req, res) => {
      if (!config.allowRawRpc) throw new HttpError(403, 'raw RPC access is disabled');
      const method = requireString((req.body as { method?: unknown }).method, 'method');
      const results = await service.client.multicallSettled([
        { methodName: 'system.methodHelp', params: [method] },
        { methodName: 'system.methodSignature', params: [method] },
      ]);
      const help = results[0] instanceof Error ? '' : String(results[0] ?? '');
      const signature = results[1] instanceof Error ? '' : jsonSafe(results[1] as XValue);
      res.json({ method, help, signature });
    }),
  );

  return router;
}

async function serviceThrottles(service: RtorrentService) {
  const state = await service.state();
  return state.throttles;
}

/** Buffers (base64 values) are not JSON-friendly; render them as base64 strings. */
function jsonSafe(value: XValue): unknown {
  if (Buffer.isBuffer(value)) return { $base64: value.toString('base64') };
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = jsonSafe(item as XValue);
    return result;
  }
  return value;
}

/** Raw XML-RPC proxy so external clients can drive rtorrent over HTTP. */
export function createRpcProxy(service: RtorrentService, config: Config) {
  return wrap(async (req: Request, res: Response) => {
    if (!config.allowRawRpc) throw new HttpError(403, 'raw RPC access is disabled');
    const body = req.body;
    const payload = Buffer.isBuffer(body)
      ? body
      : typeof body === 'string'
        ? Buffer.from(body, 'utf8')
        : null;
    if (!payload || payload.length === 0) {
      // Allow a friendly JSON form too: {"method": "...", "params": [...]}.
      const json = req.body as { method?: unknown; params?: unknown };
      if (json && typeof json.method === 'string') {
        const response = await service.client.raw(
          serializeCall(json.method, Array.isArray(json.params) ? (json.params as XValue[]) : []),
        );
        res.type('text/xml').send(response);
        return;
      }
      throw new HttpError(400, 'expected an XML-RPC methodCall body');
    }
    const response = await service.client.raw(payload);
    res.type('text/xml').send(response);
  });
}
