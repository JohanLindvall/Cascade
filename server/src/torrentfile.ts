/**
 * Just enough bencode to validate a .torrent and derive its info hash.
 *
 * rtorrent's load.raw_start returns 0 whether or not the payload is a real
 * torrent — a bad file only shows up later in its log — so an upload that is
 * never going to work has to be caught here if the user is to hear about it.
 */
import crypto from 'node:crypto';

type Bencode = number | Buffer | Bencode[] | { [key: string]: Bencode };

class BencodeError extends Error {}

interface Decoded {
  value: Bencode;
  end: number;
  infoSpan?: [number, number];
}

function decode(buf: Buffer, start: number, depth = 0): Decoded {
  if (depth > 100) throw new BencodeError('nesting too deep');
  if (start >= buf.length) throw new BencodeError('truncated');
  const marker = buf[start];

  if (marker === 0x69) {
    const end = buf.indexOf(0x65, start + 1);
    if (end < 0) throw new BencodeError('unterminated integer');
    const text = buf.subarray(start + 1, end).toString('latin1');
    if (!/^(0|-?[1-9]\d*)$/.test(text) || !Number.isSafeInteger(Number(text))) {
      throw new BencodeError('bad integer');
    }
    return { value: Number(text), end: end + 1 };
  }

  if (marker === 0x6c) {
    const items: Bencode[] = [];
    let offset = start + 1;
    while (buf[offset] !== 0x65) {
      const item = decode(buf, offset, depth + 1);
      items.push(item.value);
      offset = item.end;
    }
    return { value: items, end: offset + 1 };
  }

  if (marker === 0x64) {
    const result: Record<string, Bencode> = Object.create(null) as Record<string, Bencode>;
    let infoSpan: [number, number] | undefined;
    let previous: Buffer | undefined;
    let offset = start + 1;
    while (buf[offset] !== 0x65) {
      const key = decode(buf, offset, depth + 1);
      if (!Buffer.isBuffer(key.value)) throw new BencodeError('non-string dictionary key');
      if (previous && Buffer.compare(previous, key.value) >= 0) {
        throw new BencodeError('duplicate or unsorted dictionary key');
      }
      previous = key.value;
      const item = decode(buf, key.end, depth + 1);
      // Dictionary keys are bytes. Latin-1 preserves them one-to-one, while
      // UTF-8 replacement characters can collapse distinct keys together.
      const name = key.value.toString('latin1');
      result[name] = item.value;
      if (depth === 0 && name === 'info') infoSpan = [key.end, item.end];
      offset = item.end;
    }
    return { value: result, end: offset + 1, infoSpan };
  }

  if (marker < 0x30 || marker > 0x39) throw new BencodeError('bad string length');
  const colon = buf.indexOf(0x3a, start);
  if (colon < 0) throw new BencodeError('unterminated string');
  const text = buf.subarray(start, colon).toString('latin1');
  const length = Number(text);
  if (!/^(0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(length)) {
    throw new BencodeError('bad string length');
  }
  const from = colon + 1;
  if (length > buf.length - from) throw new BencodeError('string past end of data');
  return { value: buf.subarray(from, from + length), end: from + length };
}

export interface TorrentFileInfo {
  infoHash: string;
  name: string;
  size: number;
}

/**
 * The info hash out of a magnet's xt=urn:btih:, hex or base32, so a magnet
 * load can be confirmed the same way an uploaded file is.
 */
export function magnetInfoHash(link: string): string | undefined {
  let url: URL;
  try { url = new URL(link); } catch { return undefined; }
  if (url.protocol.toLowerCase() !== 'magnet:') return undefined;
  for (const [key, topic] of url.searchParams) {
    if (key.toLowerCase() !== 'xt') continue;
    const match = /^urn:btih:([A-Za-z0-9]+)$/i.exec(topic);
    if (!match) continue;
    const value = match[1];
    if (/^[0-9a-f]{40}$/i.test(value)) return value.toUpperCase();
    if (/^[A-Za-z2-7]{32}$/.test(value)) return base32ToHex(value);
  }
  return undefined;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(value: string): string | undefined {
  let bits = '';
  for (const character of value.toUpperCase()) {
    const index = BASE32.indexOf(character);
    if (index < 0) return undefined;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = bits.slice(0, 160).match(/.{8}/g);
  if (!bytes || bytes.length !== 20) return undefined;
  return bytes.map((byte) => parseInt(byte, 2).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Validate a .torrent and derive its info hash; throws with the reason when it is not one. */
export function parseTorrentFile(data: Buffer): TorrentFileInfo {
  try {
    const decoded = decode(data, 0);
    if (decoded.end !== data.length) throw new BencodeError('trailing data');
    const root = dictionary(decoded.value, 'expected a dictionary');
    const info = dictionary(root.info, 'no info dictionary');
    const span = decoded.infoSpan;
    if (!span) throw new BencodeError('no info dictionary');
    if (info['meta version'] === 2 && !Buffer.isBuffer(info.pieces)) {
      throw new BencodeError('v2-only torrents are not supported by rtorrent');
    }
    const name = component(info.name);
    const pieceLength = info['piece length'];
    if (typeof pieceLength !== 'number' || pieceLength <= 0) throw new BencodeError('invalid piece length');
    if (!Buffer.isBuffer(info.pieces) || info.pieces.length % 20 !== 0) {
      throw new BencodeError('invalid pieces');
    }
    if ((info.length !== undefined) === (info.files !== undefined)) {
      throw new BencodeError('expected either length or files');
    }
    let size = 0;
    if (info.length !== undefined) size = fileLength(info.length);
    else {
      if (!Array.isArray(info.files) || info.files.length === 0) throw new BencodeError('invalid file list');
      for (const value of info.files) {
        const file = dictionary(value, 'invalid file entry');
        size += fileLength(file.length);
        if (!Number.isSafeInteger(size)) throw new BencodeError('torrent is too large');
        if (!Array.isArray(file.path) || file.path.length === 0) throw new BencodeError('invalid file path');
        file.path.forEach(component);
      }
    }
    if (info.pieces.length / 20 !== Math.ceil(size / pieceLength)) {
      throw new BencodeError('piece count does not match torrent size');
    }
    const infoHash = crypto.createHash('sha1').update(data.subarray(...span)).digest('hex').toUpperCase();
    return { infoHash, name, size };
  } catch (error) {
    throw new Error(`not a valid .torrent file (${(error as Error).message})`);
  }
}

function dictionary(value: Bencode | undefined, message: string): Record<string, Bencode> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
    throw new BencodeError(message);
  }
  return value;
}

function fileLength(value: Bencode | undefined): number {
  if (typeof value !== 'number' || value < 0) throw new BencodeError('invalid file length');
  return value;
}

function component(value: Bencode | undefined): string {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.includes(0) || value.includes(0x2f)) {
    throw new BencodeError('invalid path component');
  }
  const text = value.toString('utf8');
  if (text === '.' || text === '..') throw new BencodeError('invalid path component');
  return text;
}
