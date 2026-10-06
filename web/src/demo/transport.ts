/**
 * How the page reaches the simulated server: fetch and EventSource stand-ins
 * for the API's URLs, everything else passed to the real ones. Answers are
 * real Response objects — status, status text, JSON body — so api.ts reads
 * them exactly as it reads the Go server's; a request waits a few tens of
 * milliseconds, as one to a server on the local network does, and its signal
 * cuts it short the way fetch's own does. The stream speaks the server's
 * protocol: open, then a snapshot or the missed deltas, then deltas.
 *
 * DOM-free apart from the globals node shares with the browser (Request,
 * Response, EventTarget, MessageEvent), so the tests drive it too.
 */
import type { StreamEvent } from '../stream.ts';
import type { DemoResponse, DemoServer, UploadPart } from './backend.ts';
import type { Subscription } from './hub.ts';

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
};

export interface Transport {
  server: DemoServer;
  /** The API's base, absolute and ending in "api/": api.ts's API_BASE. */
  apiBase: string;
  /** What relative URLs resolve against: document.baseURI. */
  baseUri: string;
  /** How long a request takes, ms. */
  latency: () => number;
}

/** Wait, or reject with the signal's reason the moment it aborts — as fetch rejects. */
function wait(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toResponse(answer: DemoResponse, method: string): Response {
  const headers = new Headers({ 'cache-control': 'no-cache' });
  let body: string | null = null;
  if (answer.text !== undefined) {
    body = answer.text;
    headers.set('content-type', answer.contentType ?? 'text/plain; charset=utf-8');
  } else if (answer.body !== undefined) {
    body = JSON.stringify(answer.body);
    headers.set('content-type', 'application/json; charset=utf-8');
  }
  return new Response(method === 'HEAD' ? null : body, {
    status: answer.status,
    statusText: STATUS_TEXT[answer.status] ?? '',
    headers,
  });
}

/** A form's parts, files read to bytes: what the server reads from a multipart body. */
async function partsOf(request: Request): Promise<UploadPart[]> {
  const parts: UploadPart[] = [];
  for (const [name, value] of await request.formData()) {
    if (typeof value === 'string') parts.push({ name, value });
    else parts.push({ name, filename: value.name, data: new Uint8Array(await value.arrayBuffer()) });
  }
  return parts;
}

/** fetch, with the API's URLs answered by the simulated server. */
export function demoFetch(transport: Transport, realFetch: typeof fetch): typeof fetch {
  const apiPath = new URL(transport.apiBase).pathname;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = input instanceof Request ? input.url : String(input);
    const url = new URL(target, transport.baseUri);
    if (!url.href.startsWith(transport.apiBase)) return realFetch(input, init);
    const request = new Request(input instanceof Request ? input : url, init);
    const { signal } = request;
    const contentType = request.headers.get('content-type') ?? '';
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const multipart = hasBody && /^multipart\/form-data/i.test(contentType);
    const addressed = { method: request.method, path: url.pathname.slice(apiPath.length), query: url.searchParams, contentType };
    const latency = transport.latency();
    if (init?.keepalive && !multipart && (init.body == null || typeof init.body === 'string')) {
      // A keepalive request is one made to outlive the page — the preferences
      // flushed on pagehide — and nothing after an await runs once the page is
      // going, so the server takes it before this function first waits.
      const answer = transport.server.handle({ ...addressed, body: hasBody ? init.body ?? '' : undefined });
      await wait(latency, signal);
      return toResponse(answer, request.method);
    }
    const parts = multipart ? await partsOf(request) : undefined;
    const body = hasBody && !multipart ? await request.text() : undefined;
    // Half the wait before the server sees it and half after, as with a round trip.
    await wait(latency / 2, signal);
    const answer = transport.server.handle({ ...addressed, body, parts });
    await wait(latency / 2, signal);
    return toResponse(answer, request.method);
  };
}

type Handler<E extends Event> = ((this: EventSource, event: E) => unknown) | null;

/** EventSource for the state stream: the hub's events, as the browser hands them to the page. */
class DemoEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials: boolean;
  readyState = 0;
  onopen: Handler<Event> = null;
  onmessage: Handler<MessageEvent> = null;
  onerror: Handler<Event> = null;
  private subscription: Subscription | null = null;
  private readonly timer: ReturnType<typeof setTimeout>;
  private queue: StreamEvent[] = [];
  private flushing = false;

  constructor(transport: Transport, url: string, init: EventSourceInit | undefined, stream: boolean) {
    super();
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    const since = new URL(url).searchParams.get('since') ?? '';
    this.timer = setTimeout(() => (stream ? this.connect(transport, since) : this.fail()), transport.latency());
  }

  close(): void {
    this.readyState = 2;
    clearTimeout(this.timer);
    this.subscription?.close();
    this.subscription = null;
    this.queue = [];
  }

  private connect(transport: Transport, since: string): void {
    if (this.readyState === 2) return;
    this.readyState = 1;
    this.fire(new Event('open'));
    if (this.readyState !== 1) return;
    this.subscription = transport.server.stream(since, (event) => this.deliver(event));
  }

  /** Anything under the API but the stream answers 404, which EventSource reports only as an error. */
  private fail(): void {
    if (this.readyState === 2) return;
    this.readyState = 2;
    this.fire(new Event('error'));
  }

  /** In order, and after the code that produced them has run, as events off a network arrive. */
  private deliver(event: StreamEvent): void {
    this.queue.push(event);
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      const events = this.queue;
      this.queue = [];
      for (const item of events) {
        if (this.readyState !== 1) return;
        this.fire(new MessageEvent(item.type, { data: item.data, lastEventId: item.id }));
      }
    });
  }

  private fire(event: Event): void {
    this.dispatchEvent(event);
    const handler = event.type === 'open' ? this.onopen : event.type === 'error' ? this.onerror
      : event.type === 'message' ? this.onmessage : null;
    (handler as ((event: Event) => unknown) | null)?.call(this, event);
  }
}

/** EventSource, with the API's stream served by the simulated server and every other URL by the real one. */
export function demoEventSource(transport: Transport, Real: typeof EventSource | undefined): typeof EventSource {
  const streamUrl = new URL('stream', transport.apiBase).href;
  function EventSourceShim(url: string | URL, init?: EventSourceInit): EventSource {
    const href = new URL(String(url), transport.baseUri).href;
    if (!href.startsWith(transport.apiBase) && Real) return new Real(url, init);
    const stream = href.split('?')[0].toLowerCase() === streamUrl.toLowerCase();
    return new DemoEventSource(transport, href, init, stream) as unknown as EventSource;
  }
  return Object.assign(EventSourceShim, { CONNECTING: 0, OPEN: 1, CLOSED: 2 }) as unknown as typeof EventSource;
}
