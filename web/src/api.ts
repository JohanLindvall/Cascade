import type {
  LogScopes,
  Peer,
  Settings,
  StateResponse,
  ThrottleGroup,
  TorrentFile,
  Tracker,
} from './types';

// Resolve against the document base so the UI works under any WEB_BASE_PATH.
export const API_BASE = new URL('api/', document.baseURI).toString();

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestInitEx extends RequestInit {
  /** Abort the request after this long; a hung server must not stall polling. */
  timeoutMs?: number;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  // AbortSignal.timeout is baseline in every browser this UI targets, but a
  // missing implementation should degrade to "no timeout", not a crash.
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * One call to the Cascade API: resolved against the document base, bounded
 * by a timeout, and turned into an ApiError carrying the server's own message
 * when it fails. Everything that talks to /api goes through here.
 */
export async function request<T>(path: string, init?: RequestInitEx): Promise<T> {
  const { timeoutMs = 15_000, ...rest } = init ?? {};
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: 'same-origin',
      signal: timeoutSignal(timeoutMs),
      ...rest,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ApiError(`no response after ${Math.round(timeoutMs / 1000)}s — server busy?`, 0);
    }
    throw new ApiError('cannot reach the Cascade server', 0);
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // Non-JSON error body; keep the status text.
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** What a bulk operation reports: which torrents failed, as "<hash>: <reason>". */
export interface BulkResult {
  ok: boolean;
  errors: string[];
}

function json<T>(path: string, method: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Keep the query string bounded no matter how many torrents are loaded. */
const TRACKER_CHUNK = 80;

export const api = {
  state: () => request<StateResponse>('state'),
  files: (hash: string) => request<TorrentFile[]>(`torrents/${hash}/files`),
  peers: (hash: string) => request<Peer[]>(`torrents/${hash}/peers`),
  trackers: (hash: string) => request<Tracker[]>(`torrents/${hash}/trackers`),
  trackerHosts: async (hashes: string[]) => {
    const map: Record<string, string> = {};
    for (let i = 0; i < hashes.length; i += TRACKER_CHUNK) {
      const chunk = hashes.slice(i, i + TRACKER_CHUNK);
      Object.assign(
        map,
        await request<Record<string, string>>(`trackers?hashes=${chunk.join(',')}`),
      );
    }
    return map;
  },

  upload: (form: FormData) =>
    request<{ added: number; errors: string[] }>('torrents/upload', {
      method: 'POST',
      body: form,
      // Uploads carry payloads and wait for rtorrent to confirm each load.
      timeoutMs: 120_000,
    }),

  bulkAction: (hashes: string[], action: string) =>
    json<BulkResult>(`torrents/action/${action}`, 'POST', { hashes }),
  remove: (hashes: string[], deleteData: boolean) =>
    json<BulkResult>('torrents/remove', 'POST', { hashes, deleteData }),
  patch: (hash: string, patch: Record<string, unknown>) =>
    json<{ ok: boolean }>(`torrents/${hash}`, 'PATCH', patch),
  /**
   * Apply one patch to several torrents, one request each, collecting the
   * failures the way the server's bulk routes do instead of stopping at the
   * first — which left the rest unpatched and nobody told.
   */
  patchEach: async (hashes: string[], patch: Record<string, unknown>): Promise<BulkResult> => {
    const errors: string[] = [];
    for (const hash of hashes) {
      try {
        await api.patch(hash, patch);
      } catch (error) {
        errors.push(`${hash}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { ok: errors.length === 0, errors };
  },

  setFilePriority: (hash: string, index: number, priority: number) =>
    json<{ ok: boolean }>(`torrents/${hash}/files/${index}/priority`, 'POST', { priority }),
  setTrackerEnabled: (hash: string, index: number, enabled: boolean) =>
    json<{ ok: boolean }>(`torrents/${hash}/trackers/${index}/enabled`, 'POST', { enabled }),
  addTracker: (hash: string, url: string) =>
    json<{ ok: boolean }>(`torrents/${hash}/trackers`, 'POST', { url }),

  settings: () => request<Settings>('settings'),
  saveSettings: (patch: Settings) => json<Settings>('settings', 'POST', patch),

  throttles: () =>
    request<{ groups: ThrottleGroup[]; rates: Record<string, { up: number; down: number }> }>(
      'throttles',
    ),
  saveThrottle: (group: ThrottleGroup) => json<{ ok: boolean }>('throttles', 'POST', group),
  deleteThrottle: (name: string) =>
    json<{ ok: boolean }>(`throttles/${encodeURIComponent(name)}`, 'DELETE'),

  log: (lines = 500) => request<{ lines: string[] }>(`log?lines=${lines}`),
  logScopes: () => request<LogScopes>('log/scopes'),
  setLogScopes: (scopes: string[]) =>
    json<LogScopes & { stillActive: string[]; failed: string[] }>('log/scopes', 'POST', {
      scopes,
    }),

  rpcMethods: () => request<{ methods: string[] }>('rpc/methods'),
  rpc: (method: string, params: unknown[]) =>
    json<{ ok: boolean; result?: unknown; fault?: { code: number; message: string } }>(
      'rpc',
      'POST',
      { method, params },
    ),
  rpcHelp: (method: string) =>
    json<{ method: string; help: string; signature: unknown }>('rpc/help', 'POST', { method }),
};
