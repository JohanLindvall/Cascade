import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import type { Config } from './config';
import { HttpError } from './errors';
import type { LoadOptions, RtorrentService } from './service';
import type { Store } from './store';
import { boundedUploadStorage } from './uploads';
import { requireBool, requireInt, requireRecord, requireString } from './validation';
import { XmlRpcFault, serializeCall, type XValue } from './xmlrpc';

function wrap(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

const HASH_RE = /^[0-9A-Fa-f]{40}$/;

/** A file/tracker index from the path. */
function requireIndex(value: unknown): number {
  return requireInt(value, 'index', 0, 100_000);
}

/** d.tracker.insert keeps whatever string it is given; only these schemes can
 *  ever announce. The web UI checks the same rule before sending. */
const ANNOUNCE_URL_RE = /^(https?|udp):\/\/\S+$/i;

function requireAnnounceUrl(value: unknown): string {
  const url = requireString(value, 'url');
  let valid = ANNOUNCE_URL_RE.test(url);
  try { valid = valid && !!new URL(url).hostname; } catch { valid = false; }
  if (!valid) {
    throw new HttpError(400, '"url" must be an http(s):// or udp:// announce URL');
  }
  return url;
}

function requireHash(req: Request): string {
  const hash = String(req.params.hash ?? '');
  if (!HASH_RE.test(hash)) throw new HttpError(400, 'invalid info hash');
  return hash.toUpperCase();
}

/** Validate the entire batch before starting; repeat hashes must not repeat destructive actions. */
function bodyHashes(body: unknown): string[] {
  const hashes = (body as { hashes?: unknown })?.hashes;
  if (!Array.isArray(hashes) || hashes.length === 0 ||
      hashes.some((hash) => typeof hash !== 'string' || !HASH_RE.test(hash))) {
    throw new HttpError(400, '"hashes" must be a non-empty array of 40-digit hexadecimal info hashes');
  }
  return [...new Set(hashes.map((hash: string) => hash.toUpperCase()))];
}

/**
 * Apply an action to each hash, collecting failures by hash instead of
 * stopping at the first: one torrent rtorrent refuses must not leave the
 * rest of a selection untouched.
 */
async function bulk(
  hashes: string[],
  action: (hash: string) => Promise<void>,
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  for (const hash of hashes) {
    try {
      await action(hash);
    } catch (error) {
      errors.push(`${hash}: ${(error as Error).message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Add options as both the multipart form and the JSON body carry them. */
function loadOptionsFrom(body: Record<string, unknown>): LoadOptions {
  return {
    start: requireBool(body.start, 'start', true),
    directory: body.directory === undefined ? undefined : requireString(body.directory, 'directory', true) || undefined,
    label: body.label === undefined ? undefined : requireString(body.label, 'label', true) || undefined,
  };
}

function rpcParams(value: unknown): XValue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, '"params" must be an array');
  const check = (item: unknown, depth: number): void => {
    if (depth > 100) throw new HttpError(400, '"params" nesting is too deep');
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new HttpError(400, '"params" numbers must be finite');
    }
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) check(child, depth + 1);
    }
  };
  check(value, 0);
  return value as XValue[];
}

export function createApi(service: RtorrentService, config: Config, store: Store): Router {
  const router = Router();
  const upload = multer({
    storage: boundedUploadStorage(config.maxUploadBytes),
    limits: { fileSize: config.maxUploadBytes, files: 50, fields: 4, parts: 54 },
  });
  router.use((req, _res, next) => {
    if (req.body !== undefined) requireRecord(req.body);
    next();
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
      const hashes = [...new Set(raw.split(',').filter((hash) => HASH_RE.test(hash)).map((hash) => hash.toUpperCase()))];
      res.json(await service.trackerHosts(hashes));
    }),
  );

  /* -------------------------------- add -------------------------------- */

  router.post(
    '/torrents/upload',
    upload.array('torrents'),
    wrap(async (req, res) => {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const body = (req.body ?? {}) as Record<string, unknown>;
      const options = loadOptionsFrom(body);
      const urls = requireString(body.urls ?? '', 'urls', true)
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter(Boolean);

      if (files.length === 0 && urls.length === 0) {
        throw new HttpError(400, 'no .torrent files or URLs supplied');
      }
      if (files.length + urls.length > 50) {
        throw new HttpError(400, 'at most 50 .torrent files and URLs may be added in one batch');
      }

      const errors: string[] = [];
      const failedFiles: number[] = [];
      const failedUrls: number[] = [];
      for (const [index, file] of files.entries()) {
        try {
          await service.addTorrentFile(file.buffer, options);
        } catch (error) {
          failedFiles.push(index);
          errors.push(`${file.originalname}: ${(error as Error).message}`);
        }
      }
      for (const [index, url] of urls.entries()) {
        try {
          await service.addTorrentUrl(url, options);
        } catch (error) {
          failedUrls.push(index);
          errors.push(`${url}: ${(error as Error).message}`);
        }
      }
      res.json({ added: files.length + urls.length - errors.length, errors, failedFiles, failedUrls });
    }),
  );

  router.post(
    '/torrents/url',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      await service.addTorrentUrl(requireString(body.url, 'url'), loadOptionsFrom(body));
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
      const action = String(req.params.action);
      res.json(await bulk(bodyHashes(req.body), (hash) => service.action(hash, action)));
    }),
  );

  router.delete(
    '/torrents/:hash',
    wrap(async (req, res) => {
      await service.remove(requireHash(req), requireBool(req.query.deleteData, 'deleteData', false));
      res.json({ ok: true });
    }),
  );

  router.post(
    '/torrents/remove',
    wrap(async (req, res) => {
      const deleteData = requireBool((req.body as { deleteData?: unknown })?.deleteData, 'deleteData', false);
      res.json(await bulk(bodyHashes(req.body), (hash) => service.remove(hash, deleteData)));
    }),
  );

  router.patch(
    '/torrents/:hash',
    wrap(async (req, res) => {
      const hash = requireHash(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Parse all fields before the first RPC: a bad final field must not leave
      // earlier changes applied even though the HTTP request was rejected.
      const priority = body.priority === undefined ? undefined : requireInt(body.priority, 'priority', 0, 3);
      const label = body.label === undefined ? undefined : requireString(body.label, 'label', true);
      const throttle = body.throttle === undefined ? undefined : requireString(body.throttle, 'throttle', true);
      const directory = body.directory === undefined ? undefined : requireString(body.directory, 'directory');
      const slots = (value: unknown, field: string) =>
        value === undefined ? undefined : requireInt(value, field, 0, 100_000);
      const maxUploads = slots(body.maxUploads, 'maxUploads');
      const maxDownloads = slots(body.maxDownloads, 'maxDownloads');
      if (priority !== undefined) {
        // d.priority: 0 off, 1 low, 2 normal, 3 high.
        await service.setPriority(hash, priority);
      }
      if (label !== undefined) {
        await service.setLabel(hash, label);
      }
      if (throttle !== undefined) {
        await service.setTorrentThrottle(hash, throttle);
      }
      if (directory !== undefined) {
        await service.setDirectory(hash, directory);
      }
      if (maxUploads !== undefined || maxDownloads !== undefined) {
        await service.setTorrentSlots(hash, maxUploads, maxDownloads);
      }
      res.json({ ok: true });
    }),
  );

  router.post(
    '/torrents/:hash/files/:index/priority',
    wrap(async (req, res) => {
      // f.priority: 0 skip, 1 normal, 2 high.
      const priority = requireInt((req.body as { priority?: unknown })?.priority, 'priority', 0, 2);
      await service.setFilePriority(requireHash(req), requireIndex(req.params.index), priority);
      res.json({ ok: true });
    }),
  );

  router.post(
    '/torrents/:hash/trackers/:index/enabled',
    wrap(async (req, res) => {
      const enabled = requireBool((req.body as { enabled?: unknown })?.enabled, 'enabled');
      await service.setTrackerEnabled(requireHash(req), requireIndex(req.params.index), enabled);
      res.json({ ok: true });
    }),
  );

  router.post(
    '/torrents/:hash/trackers',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      await service.addTracker(
        requireHash(req),
        requireAnnounceUrl(body.url),
        requireInt(body.group ?? 0, 'group', 0, 100_000),
      );
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
      res.json({ groups: store.throttles(), rates: await service.throttleRates() });
    }),
  );

  router.post(
    '/throttles',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      await service.saveThrottle({
        name: requireString(body.name, 'name'),
        up: requireInt(body.up, 'up'),
        down: requireInt(body.down, 'down'),
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

  router.patch('/throttles/:name', wrap(async (req, res) => {
    const body = requireRecord(req.body);
    const patch: { up?: number; down?: number } = {};
    if (body.up !== undefined) patch.up = requireInt(body.up, 'up');
    if (body.down !== undefined) patch.down = requireInt(body.down, 'down');
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'supply an up or down rate');
    await service.patchThrottle(String(req.params.name), patch);
    res.json({ ok: true });
  }));

  /* --------------------------------- log ------------------------------- */

  router.get(
    '/log',
    wrap(async (req, res) => {
      const lines = Math.min(2000, Math.max(1, Number(req.query.lines) || 300));
      res.json({ lines: await service.log(lines) });
    }),
  );

  router.get(
    '/log/scopes',
    wrap(async (_req, res) => {
      await service.capabilities.ensure();
      res.json(service.logScopes());
    }),
  );

  router.post(
    '/log/scopes',
    wrap(async (req, res) => {
      const scopes = (req.body as { scopes?: unknown })?.scopes;
      if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) {
        throw new HttpError(400, '"scopes" must be an array of log scope names');
      }
      const result = await service.setLogScopes(scopes);
      res.json({ ...service.logScopes(), ...result });
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
      const body = (req.body ?? {}) as { method?: unknown; params?: unknown };
      const method = requireString(body.method, 'method');
      const params = rpcParams(body.params);
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
      const method = requireString((req.body as { method?: unknown })?.method, 'method');
      const results = await service.client.multicallSettled([
        { methodName: 'system.methodHelp', params: [method] },
        { methodName: 'system.methodSignature', params: [method] },
      ]);
      const help = results[0] instanceof Error ? '' : String(results[0] ?? '');
      const signature = results[1] instanceof Error ? '' : jsonSafe(results[1] as XValue);
      res.json({ method, help, signature });
    }),
  );

  // Unknown API paths must answer JSON, not fall through to the SPA fallback.
  router.use((req, res) => {
    res.status(404).json({ error: `no such endpoint: ${req.method} ${req.path}` });
  });

  return router;
}

/** Buffers (base64 values) are not JSON-friendly; render them as base64 strings. */
function jsonSafe(value: XValue): unknown {
  if (Buffer.isBuffer(value)) return { $base64: value.toString('base64') };
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
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
          serializeCall(requireString(json.method, 'method'), rpcParams(json.params)),
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
