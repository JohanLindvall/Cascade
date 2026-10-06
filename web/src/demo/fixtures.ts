/**
 * What the demo's tests share: a clock whose timers run only when a test
 * moves it, and .torrent files built to order. Pure, and imported by tests
 * only — nothing the demo ships depends on it.
 */
import type { Timers } from './hub.ts';

/** A clock and timers the test advances by hand; time never moves on its own. */
export class ManualClock implements Timers {
  now: number;
  private next = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();

  constructor(start: number) {
    this.now = start;
  }

  set = (run: () => void, ms: number): number => {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, run });
    return id;
  };

  clear = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  get pending(): number {
    return this.timers.size;
  }

  /** Move the clock on, running every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let due: [number, { at: number; run: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].run();
    }
    this.now = end;
  }
}

type Bencodable = number | string | Uint8Array | Bencodable[] | { [key: string]: Bencodable };

const encoder = new TextEncoder();

/** Bencode, dictionary keys sorted as the format requires. */
export function bencode(value: Bencodable): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const put = (item: Bencodable): void => {
    if (typeof item === 'number') parts.push(encoder.encode(`i${item}e`));
    else if (typeof item === 'string') put(encoder.encode(item));
    else if (item instanceof Uint8Array) parts.push(encoder.encode(`${item.length}:`), item);
    else if (Array.isArray(item)) {
      parts.push(encoder.encode('l'));
      item.forEach(put);
      parts.push(encoder.encode('e'));
    } else {
      parts.push(encoder.encode('d'));
      for (const key of Object.keys(item).sort()) {
        put(key);
        put(item[key]);
      }
      parts.push(encoder.encode('e'));
    }
  };
  put(value);
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A well-formed .torrent: a piece hash per piece of its size, so only what a case breaks is wrong. */
export function torrentFile(info: Record<string, Bencodable>, extra: Record<string, Bencodable> = {}): Uint8Array<ArrayBuffer> {
  const pieceLength = (info['piece length'] as number | undefined) ?? 16_384;
  const size = 'length' in info
    ? info.length as number
    : (info.files as Array<{ length: number }>).reduce((sum, file) => sum + file.length, 0);
  const pieces = new Uint8Array(20 * Math.ceil(size / pieceLength));
  return bencode({ announce: 'http://tracker.example.org/announce', ...extra, info: { 'piece length': pieceLength, pieces, ...info } });
}
