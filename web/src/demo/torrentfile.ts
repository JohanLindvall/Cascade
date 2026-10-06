// SPDX-License-Identifier: MIT

/**
 * Just enough bencode to take an uploaded .torrent the way the server does
 * (server/internal/torrentfile): the same checks in the same order, refused
 * with the same reasons, and the info hash derived from the info dictionary's
 * bytes. It also reads what the simulation needs to show the torrent — its
 * files, piece length, private flag and trackers — which the server leaves to
 * rtorrent. Magnet links are read as the server reads them (as the browser's
 * URLSearchParams would).
 */
import { sha1Hex } from './sha1.ts';

export interface TorrentInfo {
  infoHash: string;
  name: string;
  size: number;
  pieceLength: number;
  isPrivate: boolean;
  /** Single-file torrents have one file, named as the torrent. */
  isMultiFile: boolean;
  files: Array<{ path: string; size: number }>;
  /** Announce tiers, from announce-list when present, else announce. */
  trackers: string[][];
  /** Unix seconds; 0 when the file does not say. */
  createdAt: number;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const E = 0x65; // 'e'
const ZERO = 0x30;
const NINE = 0x39;
const decoder = new TextDecoder();

class Bad extends Error {}

function indexOf(buf: Uint8Array, byte: number, from: number): number {
  for (let i = from; i < buf.length; i++) if (buf[i] === byte) return i;
  return -1;
}

/** Canonical decimal — no leading zeros, no "-0" — within the safe-integer range. */
function integer(buf: Uint8Array, from: number, to: number, signed: boolean): number | null {
  let start = from;
  let negative = false;
  if (signed && start < to && buf[start] === 0x2d) {
    negative = true;
    start += 1;
    if (start < to && buf[start] === ZERO) return null;
  }
  const digits = to - start;
  if (digits === 0 || (buf[start] === ZERO && digits > 1) || digits > 16) return null;
  let n = 0;
  for (let i = start; i < to; i++) {
    if (buf[i] < ZERO || buf[i] > NINE) return null;
    n = n * 10 + (buf[i] - ZERO);
  }
  if (n > MAX_SAFE) return null;
  return negative ? -n : n;
}

/** Validates the value at start and returns where it ends. */
function check(buf: Uint8Array, start: number, depth: number): number {
  if (depth > 100) throw new Bad('nesting too deep');
  if (start >= buf.length) throw new Bad('truncated');
  const marker = buf[start];
  if (marker === 0x69) { // i
    const end = indexOf(buf, E, start + 1);
    if (end < 0) throw new Bad('unterminated integer');
    if (integer(buf, start + 1, end, true) === null) throw new Bad('bad integer');
    return end + 1;
  }
  if (marker === 0x6c) { // l
    let offset = start + 1;
    while (offset >= buf.length || buf[offset] !== E) offset = check(buf, offset, depth + 1);
    return offset + 1;
  }
  if (marker === 0x64) { // d
    let previous: Uint8Array | null = null;
    let offset = start + 1;
    while (offset >= buf.length || buf[offset] !== E) {
      const keyEnd = check(buf, offset, depth + 1);
      const name = stringAt(buf, offset);
      if (!name) throw new Bad('non-string dictionary key');
      if (previous && compare(previous, name.bytes) >= 0) throw new Bad('duplicate or unsorted dictionary key');
      previous = name.bytes;
      offset = check(buf, keyEnd, depth + 1);
    }
    return offset + 1;
  }
  if (marker < ZERO || marker > NINE) throw new Bad('bad string length');
  const colon = indexOf(buf, 0x3a, start);
  if (colon < 0) throw new Bad('unterminated string');
  const length = integer(buf, start, colon, false);
  if (length === null) throw new Bad('bad string length');
  const from = colon + 1;
  if (length > buf.length - from) throw new Bad('string past end of data');
  return from + length;
}

function compare(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/* What follows reads a buffer check has passed, so it never re-validates. */

function end(buf: Uint8Array, start: number): number {
  switch (buf[start]) {
    case 0x69:
      return indexOf(buf, E, start) + 1;
    case 0x6c:
    case 0x64: {
      let offset = start + 1;
      while (buf[offset] !== E) offset = end(buf, offset);
      return offset + 1;
    }
  }
  return (stringAt(buf, start) as { stop: number }).stop;
}

function stringAt(buf: Uint8Array, start: number): { bytes: Uint8Array; stop: number } | null {
  if (start >= buf.length || buf[start] < ZERO || buf[start] > NINE) return null;
  const colon = indexOf(buf, 0x3a, start);
  if (colon < 0) return null;
  const length = integer(buf, start, colon, false) ?? 0;
  const stop = colon + 1 + length;
  return { bytes: buf.subarray(colon + 1, stop), stop };
}

function integerAt(buf: Uint8Array, start: number): number | null {
  if (buf[start] !== 0x69) return null;
  return integer(buf, start + 1, indexOf(buf, E, start), true);
}

/** Where a key's value begins in the dictionary at start, or -1. */
function lookup(buf: Uint8Array, start: number, key: string): number {
  if (start < 0 || buf[start] !== 0x64) return -1;
  let offset = start + 1;
  while (buf[offset] !== E) {
    const name = stringAt(buf, offset) as { bytes: Uint8Array; stop: number };
    if (decoder.decode(name.bytes) === key) return name.stop;
    offset = end(buf, name.stop);
  }
  return -1;
}

function each(buf: Uint8Array, start: number, visit: (item: number) => void): void {
  for (let offset = start + 1; buf[offset] !== E; offset = end(buf, offset)) visit(offset);
}

/** A path component: not empty, no NUL or "/", not "." or "..". */
function component(buf: Uint8Array, at: number): string {
  const raw = at < 0 ? null : stringAt(buf, at);
  const text = raw ? decoder.decode(raw.bytes) : '';
  if (!raw || raw.bytes.length === 0 || raw.bytes.includes(0) || raw.bytes.includes(0x2f) || text === '.' || text === '..') {
    throw new Bad('invalid path component');
  }
  return text;
}

function fileLength(buf: Uint8Array, at: number): number {
  const n = at < 0 ? null : integerAt(buf, at);
  if (n === null || n < 0) throw new Bad('invalid file length');
  return n;
}

/** The announce URLs, read leniently: rtorrent ignores what it cannot use. */
function trackersOf(buf: Uint8Array): string[][] {
  const text = (at: number) => {
    const raw = at < 0 ? null : stringAt(buf, at);
    return raw ? decoder.decode(raw.bytes).trim() : '';
  };
  const tiers: string[][] = [];
  const list = lookup(buf, 0, 'announce-list');
  if (list >= 0 && buf[list] === 0x6c) {
    each(buf, list, (tier) => {
      if (buf[tier] !== 0x6c) return;
      const urls: string[] = [];
      each(buf, tier, (url) => {
        const value = text(url);
        if (value) urls.push(value);
      });
      if (urls.length > 0) tiers.push(urls);
    });
  }
  const announce = text(lookup(buf, 0, 'announce'));
  if (tiers.length === 0 && announce) tiers.push([announce]);
  return tiers;
}

function parse(data: Uint8Array): TorrentInfo {
  const rootEnd = check(data, 0, 0);
  if (rootEnd !== data.length) throw new Bad('trailing data');
  if (data[0] !== 0x64) throw new Bad('expected a dictionary');
  const info = lookup(data, 0, 'info');
  if (info < 0 || data[info] !== 0x64) throw new Bad('no info dictionary');
  const field = (key: string) => lookup(data, info, key);

  const piecesAt = field('pieces');
  const pieces = piecesAt < 0 ? null : stringAt(data, piecesAt);
  const versionAt = field('meta version');
  if (versionAt >= 0 && integerAt(data, versionAt) === 2 && !pieces) {
    throw new Bad('v2-only torrents are not supported by rtorrent');
  }
  const name = component(data, field('name'));
  const pieceLengthAt = field('piece length');
  const pieceLength = pieceLengthAt < 0 ? null : integerAt(data, pieceLengthAt);
  if (pieceLength === null || pieceLength <= 0) throw new Bad('invalid piece length');
  if (!pieces || pieces.bytes.length % 20 !== 0) throw new Bad('invalid pieces');
  const lengthAt = field('length');
  const filesAt = field('files');
  if ((lengthAt < 0) === (filesAt < 0)) throw new Bad('expected either length or files');

  let size = 0;
  const files: Array<{ path: string; size: number }> = [];
  if (lengthAt >= 0) {
    size = fileLength(data, lengthAt);
    files.push({ path: name, size });
  } else {
    if (data[filesAt] !== 0x6c || data[filesAt + 1] === E) throw new Bad('invalid file list');
    each(data, filesAt, (file) => {
      if (data[file] !== 0x64) throw new Bad('invalid file entry');
      const n = fileLength(data, lookup(data, file, 'length'));
      size += n;
      if (size > MAX_SAFE) throw new Bad('torrent is too large');
      const path = lookup(data, file, 'path');
      if (path < 0 || data[path] !== 0x6c || data[path + 1] === E) throw new Bad('invalid file path');
      const parts: string[] = [];
      each(data, path, (part) => parts.push(component(data, part)));
      files.push({ path: parts.join('/'), size: n });
    });
  }
  if (pieces.bytes.length / 20 !== Math.ceil(size / pieceLength)) {
    throw new Bad('piece count does not match torrent size');
  }
  const privateAt = field('private');
  const createdAt = lookup(data, 0, 'creation date');
  return {
    infoHash: sha1Hex(data.subarray(info, end(data, info))).toUpperCase(),
    name,
    size,
    pieceLength,
    isPrivate: privateAt >= 0 && integerAt(data, privateAt) === 1,
    isMultiFile: filesAt >= 0,
    files,
    trackers: trackersOf(data),
    createdAt: Math.max(0, (createdAt >= 0 ? integerAt(data, createdAt) : 0) ?? 0),
  };
}

/** A .torrent's details, or the reason it is not one, worded as the server words it. */
export function parseTorrent(data: Uint8Array): TorrentInfo | { error: string } {
  try {
    return parse(data);
  } catch (error) {
    if (error instanceof Bad) return { error: `not a valid .torrent file (${error.message})` };
    throw error;
  }
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(value: string): string {
  let out = '';
  let bits = 0;
  let width = 0;
  for (const c of value.toUpperCase()) {
    bits = (bits << 5) | BASE32.indexOf(c);
    width += 5;
    if (width >= 8) {
      width -= 8;
      out += ((bits >>> width) & 0xff).toString(16).padStart(2, '0');
      bits &= (1 << width) - 1;
    }
  }
  return out.toUpperCase();
}

export interface Magnet {
  /** The info hash, upper-case hex; "" when the link carries no usable one. */
  infoHash: string;
  /** The display name, "" when absent. */
  name: string;
  trackers: string[];
}

/**
 * A magnet link's hash, name and trackers, or null for anything that is not a
 * magnet: link. The first xt=urn:btih: that holds a 40-digit hex or 32-digit
 * base32 hash wins, as on the server.
 */
export function parseMagnet(link: string): Magnet | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'magnet:') return null;
  const params = url.searchParams;
  let infoHash = '';
  for (const [key, value] of params) {
    if (infoHash || key.toLowerCase() !== 'xt') continue;
    const match = /^urn:btih:([A-Za-z0-9]+)$/i.exec(value);
    if (!match) continue;
    const hash = match[1];
    if (/^[0-9A-Fa-f]{40}$/.test(hash)) infoHash = hash.toUpperCase();
    else if (/^[A-Za-z2-7]{32}$/.test(hash)) infoHash = base32ToHex(hash);
  }
  return {
    infoHash,
    name: (params.get('dn') ?? '').trim(),
    trackers: params.getAll('tr').map((tracker) => tracker.trim()).filter(Boolean),
  };
}
