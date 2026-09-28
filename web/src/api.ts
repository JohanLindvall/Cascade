import type {
  LogScopeChange,
  LogScopes,
  Peer,
  Settings,
  ThrottleGroup,
  ThrottleRate,
  TorrentFile,
  Tracker,
  UploadResult,
} from './types';

// Resolve against the document base so the UI works under any WEB_BASE_PATH.
export const API_BASE = new URL('api/', document.baseURI).toString();

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface RequestInitEx extends RequestInit {
  /** Abort the request after this long; a hung server must not stall polling. */
  timeoutMs?: number;
}

/**
 * The timeout, joined with the caller's own signal when there is one: a
 * caller that wants to cancel must not lose the timeout by passing it.
 */
function requestSignal(timeoutMs: number, signal: AbortSignal | null | undefined): AbortSignal | undefined {
  // AbortSignal.timeout and .any are baseline in every browser this UI
  // targets, but a missing implementation should degrade, not crash.
  const timeout = 'timeout' in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined;
  if (!signal) return timeout;
  if (!timeout) return signal;
  return 'any' in AbortSignal ? AbortSignal.any([timeout, signal]) : signal;
}

/** The caller's own cancel, which is passed on as it is rather than reported as a failure. */
function isAbort(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * What a failed response says went wrong: the server's JSON error, else a
 * short plain-text answer (Basic auth's "authentication required"), else the
 * status line — never a proxy's HTML error page.
 */
async function errorMessage(response: Response): Promise<string> {
  const status = `${response.status} ${response.statusText}`.trim();
  let text: string;
  try {
    text = (await response.text()).trim();
  } catch (error) {
    // The request's signal is still armed while the body is read: a cancel
    // must stay a cancel. A deadline or a dropped connection here still left
    // the status, which says more than "no response" would.
    if (isAbort(error)) throw error;
    return status;
  }
  try {
    const body = JSON.parse(text) as { error?: unknown } | null;
    if (typeof body?.error === 'string' && body.error) return body.error;
  } catch {
    // Not JSON; the text itself may still say it.
  }
  return text && text.length <= 200 && !text.startsWith('<') ? text : status;
}

/**
 * One call to the Cascade API: resolved against the document base, bounded
 * by a timeout, and turned into an ApiError carrying the server's own message
 * when it fails. Everything that talks to /api goes through here. A request
 * the caller aborted rejects with the AbortError itself, so the caller can
 * tell it from a failure.
 */
export async function request<T>(path: string, init?: RequestInitEx): Promise<T> {
  const { timeoutMs = 35_000, signal, ...rest } = init ?? {};
  // What cut the request short, whether before the headers or while the body
  // was read: the signal stays armed until the body is in, so a deadline or a
  // cancel can land in either phase and must read the same in both.
  const cutShort = (error: unknown): Error => {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return new ApiError(`no response after ${Math.round(timeoutMs / 1000)}s — server busy?`, 0);
    }
    return isAbort(error) ? error : new ApiError('cannot reach the Cascade server', 0);
  };
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: 'same-origin',
      ...rest,
      signal: requestSignal(timeoutMs, signal),
    });
  } catch (error) {
    throw cutShort(error);
  }
  if (!response.ok) throw new ApiError(await errorMessage(response), response.status);
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch (error) {
    // Only a body that did not parse is the server's (or a proxy's login
    // page's) doing; a stall or a cancel mid-body is not a content problem.
    if (error instanceof SyntaxError) {
      throw new ApiError(`the server answered ${path.split('?')[0]} with something other than JSON`, response.status);
    }
    throw cutShort(error);
  }
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
    request<UploadResult>('torrents/upload', {
      method: 'POST',
      body: form,
      // Uploads carry payloads and wait for rtorrent to confirm each load.
      timeoutMs: Math.max(120_000, 30_000 + 12_000 * (form.getAll('torrents').length +
        String(form.get('urls') ?? '').split(/[\r\n]+/).filter((line) => line.trim()).length)),
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

  throttles: () => request<{ groups: ThrottleGroup[]; rates: Record<string, ThrottleRate> }>('throttles'),
  saveThrottle: (group: ThrottleGroup) => json<{ ok: boolean }>('throttles', 'POST', group),
  patchThrottle: (name: string, patch: Partial<Pick<ThrottleGroup, 'up' | 'down'>>) =>
    json<{ ok: boolean }>(`throttles/${encodeURIComponent(name)}`, 'PATCH', patch),
  deleteThrottle: (name: string) =>
    json<{ ok: boolean }>(`throttles/${encodeURIComponent(name)}`, 'DELETE'),

  log: (lines = 500) => request<{ lines: string[] }>(`log?lines=${lines}`),
  logScopes: () => request<LogScopes>('log/scopes'),
  setLogScopes: (scopes: string[]) => json<LogScopeChange>('log/scopes', 'POST', { scopes }),

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
