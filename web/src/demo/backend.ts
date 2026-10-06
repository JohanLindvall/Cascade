/**
 * The Cascade server, simulated: every route the UI calls, answered as the Go
 * server answers it (server/internal/httpapi/routes.go and the service behind
 * it) — the same shapes, typed with the real contracts so a change to the API
 * fails the typecheck here; the same checks in the same order, refused with
 * the same status and words; and rtorrent's own faults where rtorrent would
 * refuse, relayed as the server relays them (a 502 carrying the fault). Pure
 * and DOM-free: the clock and the timers are handed in, so the node test runner
 * drives it request by request.
 */
import type {
  BackendSummary, GlobalStatus, LogScopeChange, StateResponse, ThrottleGroup, Torrent, UploadResult,
} from '../contracts.ts';
import { normalizePreferences, sanitizePreferences, type Preferences } from '../preferences.ts';
import type { JsonObject, StreamEvent } from '../stream.ts';
import { Hub, type Subscription, type Timers } from './hub.ts';
import { Rpc, RpcFault } from './rpc.ts';
import { Session, VIEWS, viewsOf, type AddOptions } from './session.ts';
import { SETTINGS, coerce, refusal, supportsMap, type SettingSpec } from './settings.ts';
import { parseMagnet, parseTorrent } from './torrentfile.ts';
import { Fault, HttpError, bool, int, record, text } from './validate.ts';

/** How often the state is read without a preference: the demo's CASCADE_STATE_POLL_MS. */
export const DEFAULT_POLL_MS = 1000;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const UPLOAD_MAX_FILES = 50;
const UPLOAD_MAX_FIELDS = 4;
const JSON_LIMIT = 4 << 20;
const HASH = /^[0-9A-Fa-f]{40}$/;

/** One part of a multipart upload, as the browser's FormData holds it. */
export type UploadPart =
  | { name: string; value: string }
  | { name: string; filename: string; data: Uint8Array };

export interface DemoRequest {
  method: string;
  /** The path under api/, as sent: "torrents/<hash>/files". */
  path: string;
  query: URLSearchParams;
  contentType?: string;
  /** The body's text, when it is not a multipart upload. */
  body?: string;
  parts?: UploadPart[];
}

export interface DemoResponse {
  status: number;
  /** The JSON answer; a text answer gives text and its type instead. */
  body?: unknown;
  text?: string;
  contentType?: string;
}

export interface DemoServerOptions {
  /** The clock, epoch ms. */
  now: () => number;
  timers: Timers;
  seed: number;
  /** The rtorrent release to present, the Dockerfile's default. */
  version: string;
  /** The preferences saved last time, repaired before use. */
  preferences?: unknown;
  /** Called with the preferences whenever a PATCH changes them, to keep them for next time. */
  onPreferences?: (preferences: Preferences) => void;
}

/** What a request turned away as sent changed nothing, so it wakes nothing (refusedAsSent in server.go). */
export function refusedAsSent(status: number): boolean {
  return status === 400 || status === 404 || status === 409 || status === 413 || status === 415;
}

/** libtorrent's version for an rtorrent release: 0.9.x pairs with 0.13.x, 0.10.x with 0.14.x, later ones share it. */
export function libraryVersion(version: string): string {
  if (version.startsWith('0.9.')) return `0.13.${version.slice(4)}`;
  if (version.startsWith('0.10.')) return `0.14.${version.slice(5)}`;
  return version;
}

const prefix = (value: string, n: number) => [...value].slice(0, n).join('');

/** One request's parsed body and its path's values, with the server's field readers. */
class Call {
  readonly request: DemoRequest;
  readonly params: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly hasBody: boolean;

  constructor(request: DemoRequest, params: Record<string, string>, body: Record<string, unknown>, hasBody: boolean) {
    this.request = request;
    this.params = params;
    this.body = body;
    this.hasBody = hasBody;
  }

  has(name: string): boolean {
    return Object.hasOwn(this.body, name);
  }

  /** An absent field reads as null, so a required one is refused like one of the wrong type. */
  value(name: string): unknown {
    return this.has(name) ? this.body[name] : null;
  }

  text(name: string, allowEmpty: boolean): string {
    return text(this.value(name), name, allowEmpty);
  }

  integer(name: string, min: number, max: number): number {
    return int(this.value(name), name, min, max);
  }

  boolean(name: string): boolean {
    return bool(this.value(name), name);
  }

  optionalInteger(name: string, max: number): number | null {
    return this.has(name) ? this.integer(name, 0, max) : null;
  }

  optionalText(name: string, allowEmpty: boolean): string | null {
    return this.has(name) ? this.text(name, allowEmpty) : null;
  }

  /** A query parameter given exactly once; a repeated one is a list, which no route takes. */
  query(name: string): string | null {
    const values = this.request.query.getAll(name);
    return values.length === 1 ? values[0] : null;
  }

  hash(): string {
    const hash = this.params.hash ?? '';
    if (!HASH.test(hash)) throw new HttpError(400, 'invalid info hash');
    return hash.toUpperCase();
  }

  index(): number {
    return int(this.params.index ?? '', 'index', 0, 100_000);
  }
}

type Handler = (call: Call) => unknown;

/** An answer that is not JSON: the stream's first event, for a plain fetch of it. */
class TextAnswer {
  readonly text: string;
  readonly contentType: string;

  constructor(text: string, contentType: string) {
    this.text = text;
    this.contentType = contentType;
  }
}

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

function segments(path: string): string[] {
  return path.replace(/^\/+|\/+$/g, '').split('/');
}

/** A bulk route's hashes: all checked before anything starts, and each once. */
function bodyHashes(body: Record<string, unknown>): string[] {
  const list = body.hashes;
  const refuse = new HttpError(400, '"hashes" must be a non-empty array of 40-digit hexadecimal info hashes');
  if (!Array.isArray(list) || list.length === 0) throw refuse;
  const hashes: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || !HASH.test(item)) throw refuse;
    if (!hashes.includes(item.toUpperCase())) hashes.push(item.toUpperCase());
  }
  return hashes;
}

/** How a failure reads in a bulk answer: an rtorrent fault as its Go error prints, else its message. */
function reason(error: unknown): string {
  if (error instanceof HttpError && error.faultCode !== undefined) return `rtorrent fault ${error.faultCode}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function bulk(hashes: string[], action: (hash: string) => void): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const hash of hashes) {
    try {
      action(hash);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      errors.push(`${hash}: ${reason(error)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function loadOptions(body: Record<string, unknown>): AddOptions {
  const options: AddOptions = { start: true, directory: '', label: '' };
  if (Object.hasOwn(body, 'start')) options.start = bool(body.start, 'start');
  if (Object.hasOwn(body, 'directory')) options.directory = text(body.directory, 'directory', true);
  if (Object.hasOwn(body, 'label')) options.label = text(body.label, 'label', true);
  return options;
}

/** The directory rides into rtorrent inside a command string, so a line break or a "$" is refused. */
function checkLoadOptions(options: AddOptions): void {
  if (/\p{Cc}/u.test(options.directory)) throw new HttpError(400, '"directory" contains control characters');
  if (options.directory.startsWith('$')) {
    throw new HttpError(400, '"directory" must be a literal path, not an rtorrent command (use ./ for a relative path beginning with $)');
  }
}

/** The non-blank lines of the "urls" field, which may be absent or null. */
function uploadUrls(body: Record<string, unknown>): string[] {
  const value = body.urls ?? '';
  return text(value, 'urls', true).split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
}

/** A group as rtorrent can hold it: a name it takes, and whole KiB/s rounded up (quirk 3). */
function normalizeThrottle(name: string, up: unknown, down: unknown): ThrottleGroup {
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(name) || name === 'NULL' || name === '.' || name === '..') {
    throw new HttpError(400, 'throttle name must be 1-32 chars of [A-Za-z0-9_.-] and cannot be NULL, . or ..');
  }
  const kib = (value: unknown, field: string) => Math.ceil(int(value, field, 0, Number.MAX_SAFE_INTEGER - 1023) / 1024) * 1024;
  return { name, up: kib(up, 'up'), down: kib(down, 'down') };
}

function announceUrl(value: unknown): string {
  const link = text(value, 'url', false);
  let host = '';
  try {
    host = new URL(link).hostname;
  } catch {
    // Refused below.
  }
  if (!/^(https?|udp):\/\/\S+$/i.test(link) || host === '') {
    throw new HttpError(400, '"url" must be an http(s):// or udp:// announce URL');
  }
  return link;
}

function rpcParams(call: Call): unknown[] {
  if (!call.has('params')) return [];
  const list = call.body.params;
  if (!Array.isArray(list)) throw new HttpError(400, '"params" must be an array');
  const depth = (value: unknown, level: number): void => {
    if (level > 100) throw new HttpError(400, '"params" nesting is too deep');
    if (Array.isArray(value)) for (const item of value) depth(item, level + 1);
    else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) depth(item, level + 1);
  };
  depth(list, 0);
  return list;
}

export class DemoServer {
  readonly session: Session;
  private readonly rpc: Rpc;
  private readonly hub: Hub;
  private readonly routes: Route[] = [];
  private readonly now: () => number;
  private readonly version: string;
  private prefs: Preferences;
  private readonly onPreferences: ((preferences: Preferences) => void) | undefined;

  constructor(options: DemoServerOptions) {
    this.now = options.now;
    this.version = options.version;
    this.session = new Session({ seed: options.seed, now: options.now() });
    this.prefs = normalizePreferences(options.preferences ?? {});
    this.onPreferences = options.onPreferences;
    this.rpc = new Rpc({
      session: this.session,
      clientVersion: options.version,
      libraryVersion: libraryVersion(options.version),
      apiVersion: '28',
      load: (link, start, directory, label) => {
        try {
          this.addLink(link, { start, directory, label });
        } catch {
          // load.* answers 0 whatever it was given; what it could not use shows only in the log.
          this.session.note('E', 'Could not create download, the input is not a valid torrent.');
        }
      },
    });
    this.hub = new Hub(() => this.state() as unknown as JsonObject, options.timers, options.now().toString(36), DEFAULT_POLL_MS);
    this.defineRoutes();
  }

  /** The whole state, as GET api/state answers it. */
  state(): StateResponse {
    this.session.advance(this.now());
    const { torrents, status } = this.session.snapshot();
    const global: GlobalStatus = {
      ...status,
      policy: { rawRpc: true, deleteData: true },
      statePollMs: this.prefs.statePollMs ?? DEFAULT_POLL_MS,
      statePollDefaultMs: DEFAULT_POLL_MS,
      backend: this.backend(),
      history: status.history,
    };
    return { status: global, torrents, throttles: this.session.throttles(), game: this.session.game() };
  }

  backend(): BackendSummary {
    return {
      clientVersion: this.version,
      libraryVersion: libraryVersion(this.version),
      apiVersion: '28',
      flavor: 'modern dialect (0.9.7+)',
      methodCount: this.rpc.methods().length,
      rpcFacility: 'xmlrpc-c 1.51.8',
      endpoint: 'unix:/run/rtorrent/rpc.socket',
      supports: supportsMap(),
    };
  }

  preferences(): Preferences {
    return { ...this.prefs, seenBadges: [...this.prefs.seenBadges] };
  }

  /** GET api/stream, as the EventSource sees it. */
  stream(since: string, send: (event: StreamEvent) => void): Subscription {
    return this.hub.subscribe(since, send);
  }

  /** One request, answered as the server answers it — and a change wakes the stream, as there. */
  handle(request: DemoRequest): DemoResponse {
    this.session.advance(this.now());
    const response = this.answer(request);
    const safe = request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS';
    if (!safe && !refusedAsSent(response.status)) this.hub.wake();
    return request.method === 'HEAD' ? { status: response.status } : response;
  }

  private answer(request: DemoRequest): DemoResponse {
    const path = segments(request.path);
    for (const route of this.routes) {
      if (route.method !== request.method && !(route.method === 'GET' && request.method === 'HEAD')) continue;
      const params = this.match(route.parts, path);
      if (!params) continue;
      return this.run(request, params, route.handler);
    }
    return this.run(request, {}, () => {
      throw new HttpError(404, `no such endpoint: ${request.method} /${request.path.replace(/^\/+/, '')}`);
    });
  }

  /** Literal segments match without regard to case; a {name} is one non-empty segment, decoded. */
  private match(parts: string[], path: string[]): Record<string, string> | null {
    if (parts.length !== path.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.startsWith('{')) {
        let value: string;
        try {
          value = decodeURIComponent(path[i]);
        } catch {
          return null;
        }
        if (value === '') return null;
        params[part.slice(1, -1)] = value;
      } else if (part.toLowerCase() !== path[i].toLowerCase()) {
        return null;
      }
    }
    return params;
  }

  private run(request: DemoRequest, params: Record<string, string>, handler: Handler): DemoResponse {
    try {
      const { body, hasBody } = this.parseBody(request);
      const result = handler(new Call(request, params, body, hasBody));
      if (result instanceof TextAnswer) return { status: 200, text: result.text, contentType: result.contentType };
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof HttpError) {
        const body: Record<string, unknown> = { error: error.message };
        if (error.faultCode !== undefined) body.faultCode = error.faultCode;
        return { status: error.status, body };
      }
      return { status: 500, body: { error: error instanceof Error && error.message ? error.message : 'internal error' } };
    }
  }

  /** jsonBody and the api adapter: a JSON object, an empty body as {}, anything else refused. */
  private parseBody(request: DemoRequest): { body: Record<string, unknown>; hasBody: boolean } {
    const [media, ...rest] = (request.contentType ?? '').split(';').map((part) => part.trim());
    if (media.toLowerCase() !== 'application/json') return { body: {}, hasBody: false };
    const charset = rest.find((part) => /^charset=/i.test(part))?.slice(8).replace(/"/g, '').toLowerCase() ?? '';
    if (charset && charset !== 'utf-8' && charset !== 'utf8') {
      throw new HttpError(415, `unsupported charset ${JSON.stringify(charset.toUpperCase())}`);
    }
    const textBody = request.body ?? '';
    if (new TextEncoder().encode(textBody).length > JSON_LIMIT) throw new HttpError(413, 'request entity too large');
    const trimmed = textBody.replace(/^[ \t\r\n]+/, '');
    if (trimmed === '') return { body: {}, hasBody: true };
    if (trimmed[0] !== '{' && trimmed[0] !== '[') {
      const shown = [...trimmed].length > 20 ? `${prefix(trimmed, 20)}…` : trimmed;
      throw new HttpError(400, `request body must be a JSON object, not ${JSON.stringify(shown)}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(textBody);
    } catch (error) {
      throw new HttpError(400, `malformed JSON body: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { body: record(value, 'body'), hasBody: true };
  }

  private on(pattern: string, handler: Handler): void {
    const [method, path] = pattern.split(' ');
    this.routes.push({ method, parts: segments(path), handler });
  }

  /** The API in routes.go's order, which is the order it matches in. */
  private defineRoutes(): void {
    const ok = { ok: true };
    const session = this.session;

    this.on('GET state', () => this.state());
    this.on('GET stream', () => {
      // A plain fetch of the stream gets its first event; the page's EventSource gets the rest.
      let first: StreamEvent | undefined;
      const subscription = this.hub.subscribe('', (event) => (first ??= event));
      subscription.close();
      const event = first as StreamEvent;
      return new TextAnswer(`id: ${event.id}\nevent: ${event.type}\ndata: ${event.data}\n\n`, 'text/event-stream');
    });
    this.on('GET status', () => this.state().status);
    this.on('GET torrents', (call) => {
      const view = call.query('view') ?? 'main';
      if (!VIEWS.includes(view)) throw new Fault(-503, 'Could not find view.');
      const listed = new Set(session.all().filter((t) => viewsOf(t).includes(view)).map((t) => t.hash));
      return session.list().filter((t: Torrent) => listed.has(t.hash));
    });
    this.on('GET prefs', () => this.preferences());
    this.on('PATCH prefs', (call) => {
      const next = sanitizePreferences(this.prefs, call.body);
      if (JSON.stringify(next) !== JSON.stringify(this.prefs)) {
        this.prefs = next;
        this.onPreferences?.(this.preferences());
      }
      return this.preferences();
    });
    this.on('GET game', () => session.game());
    this.on('GET capabilities', () => this.backend());
    this.on('GET torrents/{hash}/files', (call) => session.files(call.hash()));
    this.on('GET torrents/{hash}/peers', (call) => session.peers(call.hash()));
    this.on('GET torrents/{hash}/trackers', (call) => session.trackers(call.hash()));
    this.on('GET trackers', (call) => {
      const hosts: Record<string, string> = {};
      for (const hash of (call.query('hashes') ?? '').split(',')) {
        const upper = hash.toUpperCase();
        if (HASH.test(upper) && !Object.hasOwn(hosts, upper)) hosts[upper] = session.trackerHost(upper);
      }
      return hosts;
    });

    this.on('POST torrents/upload', (call) => this.upload(call));
    this.on('POST torrents/url', (call) => {
      const link = call.text('url', false);
      this.addLink(link, loadOptions(call.body));
      return ok;
    });

    this.on('POST torrents/{hash}/action/{action}', (call) => {
      session.action(call.hash(), call.params.action);
      return ok;
    });
    this.on('POST torrents/action/{action}', (call) => {
      const hashes = bodyHashes(call.body);
      return bulk(hashes, (hash) => session.action(hash, call.params.action));
    });
    this.on('DELETE torrents/{hash}', (call) => {
      const hash = call.hash();
      let deleteData = false;
      const given = call.request.query.getAll('deleteData');
      if (given.length > 0) deleteData = bool(given.length > 1 ? given : given[0], 'deleteData');
      session.remove(hash, deleteData);
      return ok;
    });
    this.on('POST torrents/remove', (call) => {
      const deleteData = call.has('deleteData') ? call.boolean('deleteData') : false;
      const hashes = bodyHashes(call.body);
      return bulk(hashes, (hash) => session.remove(hash, deleteData));
    });
    this.on('PATCH torrents/{hash}', (call) => {
      const hash = call.hash();
      // Every field is checked before the first change: a bad last field must not leave the others applied.
      const priority = call.optionalInteger('priority', 3);
      const label = call.optionalText('label', true);
      const throttle = call.optionalText('throttle', true);
      const directory = call.optionalText('directory', false);
      const uploads = call.optionalInteger('maxUploads', 100_000);
      const downloads = call.optionalInteger('maxDownloads', 100_000);
      if (priority !== null) session.setPriority(hash, priority);
      if (label !== null) session.setLabel(hash, label);
      if (throttle !== null) session.setThrottle(hash, throttle);
      if (directory !== null) session.setDirectory(hash, directory);
      if (uploads !== null || downloads !== null) session.setSlots(hash, uploads, downloads);
      return ok;
    });
    this.on('POST torrents/{hash}/files/{index}/priority', (call) => {
      const priority = call.integer('priority', 0, 2);
      session.setFilePriority(call.hash(), call.index(), priority);
      return ok;
    });
    this.on('POST torrents/{hash}/trackers/{index}/enabled', (call) => {
      const enabled = call.boolean('enabled');
      session.setTrackerEnabled(call.hash(), call.index(), enabled);
      return ok;
    });
    this.on('POST torrents/{hash}/trackers', (call) => {
      const hash = call.hash();
      const link = announceUrl(call.body.url);
      const group = int(call.body.group ?? 0, 'group', 0, 100_000);
      session.addTracker(hash, link, group);
      return ok;
    });

    this.on('GET settings', () => this.settings());
    this.on('POST settings', (call) => {
      // Every value is checked, in the table's order, before any is applied;
      // then rtorrent takes them one setter at a time and may refuse one,
      // leaving the ones before it applied, as a multicall does.
      const changes: Array<[SettingSpec, number | boolean | string]> = [];
      for (const setting of SETTINGS) {
        if (!setting.writable || !call.has(setting.key)) continue;
        changes.push([setting, coerce(setting.kind, call.body[setting.key], setting.key)]);
      }
      for (const [setting, value] of changes) {
        const refused = refusal(setting.key, value);
        if (refused) throw new Fault(-503, `${setting.set ?? setting.key}: ${refused}`);
        Object.assign(session.settings, { [setting.key]: value });
      }
      return this.settings();
    });

    this.on('GET throttles', () => ({ groups: session.throttles(), rates: session.throttleRates() }));
    this.on('POST throttles', (call) => {
      const name = call.text('name', false);
      const up = call.integer('up', 0, Number.MAX_SAFE_INTEGER);
      const down = call.integer('down', 0, Number.MAX_SAFE_INTEGER);
      session.saveThrottle(normalizeThrottle(name, up, down));
      return ok;
    });
    this.on('DELETE throttles/{name}', (call) => {
      const name = call.params.name;
      // throttle.up on an unknown name would create that group rather than remove one.
      if (!session.throttle(name)) throw new HttpError(404, `no throttle group named "${name}"`);
      session.deleteThrottle(name);
      return ok;
    });
    this.on('PATCH throttles/{name}', (call) => {
      if (!call.hasBody) throw new HttpError(400, '"body" must be an object');
      const up = call.optionalInteger('up', Number.MAX_SAFE_INTEGER);
      const down = call.optionalInteger('down', Number.MAX_SAFE_INTEGER);
      if (up === null && down === null) throw new HttpError(400, 'supply an up or down rate');
      const name = call.params.name;
      const group = session.throttle(name);
      if (!group) throw new HttpError(404, `no throttle group named "${name}"`);
      session.saveThrottle(normalizeThrottle(name, up ?? group.up, down ?? group.down));
      return ok;
    });

    this.on('GET log', (call) => {
      // Number(lines) || 300, then held to 1-2000.
      const asked = Number(call.query('lines') ?? '');
      const lines = Number.isFinite(asked) && asked !== 0 ? asked : 300;
      return { lines: session.logTail(Math.min(2000, Math.max(1, Math.trunc(lines)))) };
    });
    this.on('GET log/scopes', () => session.logScopes());
    this.on('POST log/scopes', (call): LogScopeChange => {
      const list = call.body.scopes;
      if (!Array.isArray(list) || !list.every((scope) => typeof scope === 'string')) {
        throw new HttpError(400, '"scopes" must be an array of log scope names');
      }
      return session.setLogScopes(list as string[]);
    });

    this.on('GET rpc/methods', () => ({ methods: this.rpc.methods() }));
    this.on('POST rpc', (call) => {
      const method = call.text('method', false);
      const params = rpcParams(call);
      try {
        return { ok: true, result: this.rpc.call(method, params) };
      } catch (error) {
        if (!(error instanceof RpcFault)) throw error;
        return { ok: false, fault: { code: error.code, message: error.message } };
      }
    });
    this.on('POST rpc/help', (call) => {
      const method = call.text('method', false);
      const help = this.rpc.help(method);
      return { method, help: help?.help ?? '', signature: help?.signature ?? '' };
    });
  }

  /** Every global setting this backend can report. */
  private settings(): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const setting of SETTINGS) if (setting.readable) values[setting.key] = this.session.settings[setting.key];
    return values;
  }

  /** The upload route: .torrent files and links from a multipart form, failures reported by item. */
  private upload(call: Call): UploadResult {
    let files: Array<{ name: string; data: Uint8Array }> = [];
    let body = call.body;
    if (/^multipart\//i.test(call.request.contentType ?? '')) ({ files, body } = this.readUpload(call.request.parts ?? []));
    const options = loadOptions(body);
    const urls = uploadUrls(body);
    if (files.length === 0 && urls.length === 0) throw new HttpError(400, 'no .torrent files or URLs supplied');
    if (files.length + urls.length > UPLOAD_MAX_FILES) {
      throw new HttpError(400, `at most ${UPLOAD_MAX_FILES} .torrent files and URLs may be added in one batch`);
    }
    const result: UploadResult = { added: 0, errors: [], failedFiles: [], failedUrls: [] };
    files.forEach((file, index) => {
      try {
        this.addFile(file.data, options);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        result.failedFiles.push(index);
        result.errors.push(`${file.name}: ${error.message}`);
      }
    });
    urls.forEach((link, index) => {
      try {
        this.addLink(link, options);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        result.failedUrls.push(index);
        result.errors.push(`${link}: ${error.message}`);
      }
    });
    result.added = files.length + urls.length - result.errors.length;
    return result;
  }

  /** readUpload: the whole form read and held to its limits before a single torrent loads. */
  private readUpload(parts: UploadPart[]): { files: Array<{ name: string; data: Uint8Array }>; body: Record<string, unknown> } {
    const files: Array<{ name: string; data: Uint8Array }> = [];
    const body: Record<string, unknown> = {};
    let fields = 0;
    let total = 0;
    if (parts.length > UPLOAD_MAX_FILES + UPLOAD_MAX_FIELDS) throw new HttpError(413, 'Too many parts');
    for (const part of parts) {
      if (!part.name) throw new HttpError(400, 'Field name missing');
      if ('data' in part) {
        if (part.name !== 'torrents') throw new HttpError(400, 'Unexpected field');
        if (files.length === UPLOAD_MAX_FILES) throw new HttpError(413, 'Too many files');
        if (part.data.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'torrent file exceeds the upload size limit');
        total += part.data.length;
        if (total > MAX_UPLOAD_BYTES) throw new HttpError(413, `torrent upload batch exceeds ${MAX_UPLOAD_BYTES} bytes`);
        files.push({ name: part.filename, data: part.data });
        continue;
      }
      fields += 1;
      if (fields > UPLOAD_MAX_FIELDS) throw new HttpError(400, 'Too many fields');
      if (part.name.length > 100) throw new HttpError(400, 'Field name too long');
      if (new TextEncoder().encode(part.value).length > 1 << 20) throw new HttpError(413, 'Field value too long');
      const existing = body[part.name];
      body[part.name] = existing === undefined ? part.value : Array.isArray(existing) ? [...existing, part.value] : [existing, part.value];
    }
    return { files, body };
  }

  /** AddTorrentFile: junk refused with the reason, a torrent already there a 409 naming it. */
  private addFile(data: Uint8Array, options: AddOptions): void {
    const parsed = parseTorrent(data);
    if ('error' in parsed) throw new HttpError(400, parsed.error);
    checkLoadOptions(options);
    this.refuseLoaded(parsed.infoHash);
    this.session.addTorrent(parsed, options);
  }

  /** AddTorrentURL: only what rtorrent can fetch, a magnet only with its hash. */
  private addLink(given: string, options: AddOptions): void {
    const link = given.trim();
    if (!/^(magnet:\?|https?:\/\/|ftp:\/\/)/i.test(link)) {
      throw new HttpError(400, `"${prefix(link, 80)}" is not a magnet link or a torrent URL (magnet:, http(s):, ftp:)`);
    }
    const magnet = /^magnet:/i.test(link) ? parseMagnet(link) : null;
    if (magnet && !magnet.infoHash) throw new HttpError(400, 'magnet link must contain a valid xt=urn:btih: info hash');
    checkLoadOptions(options);
    if (magnet) {
      this.refuseLoaded(magnet.infoHash);
      this.session.addMagnet(magnet, options);
      return;
    }
    if (!this.session.addUrl(link, options)) {
      throw new HttpError(502,
        `rtorrent loaded nothing from "${prefix(link, 120)}" within 10s — the link may need a login, may not point at a .torrent, ` +
        'or may already be loaded. Check the rtorrent log; if it was merely slow it may still appear.');
    }
  }

  /** rtorrent drops a second load of a hash without a word, so the session is asked first. */
  private refuseLoaded(hash: string): void {
    if (!this.session.has(hash)) return;
    const name = this.session.get(hash).name || hash;
    throw new HttpError(409, `"${name}" is already loaded`);
  }
}
