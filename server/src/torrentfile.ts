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

function decode(buf: Buffer, start: number): [Bencode, number] {
  if (start >= buf.length) throw new BencodeError('truncated');
  const marker = buf[start];

  // Integer: i<digits>e
  if (marker === 0x69) {
    const end = buf.indexOf(0x65, start);
    if (end < 0) throw new BencodeError('unterminated integer');
    const value = Number(buf.subarray(start + 1, end).toString('latin1'));
    if (!Number.isFinite(value)) throw new BencodeError('bad integer');
    return [value, end + 1];
  }

  // List: l<items>e
  if (marker === 0x6c) {
    const items: Bencode[] = [];
    let offset = start + 1;
    while (buf[offset] !== 0x65) {
      const [item, next] = decode(buf, offset);
      items.push(item);
      offset = next;
    }
    return [items, offset + 1];
  }

  // Dictionary: d<key><value>...e
  if (marker === 0x64) {
    const result: Record<string, Bencode> = {};
    let offset = start + 1;
    while (buf[offset] !== 0x65) {
      const [key, afterKey] = decode(buf, offset);
      if (!Buffer.isBuffer(key)) throw new BencodeError('non-string dictionary key');
      const [value, afterValue] = decode(buf, afterKey);
      result[key.toString('utf8')] = value;
      // Remember where each value sits so the info dict can be hashed verbatim.
      Object.defineProperty(result, `__span_${key.toString('utf8')}`, {
        value: [afterKey, afterValue],
        enumerable: false,
      });
      offset = afterValue;
    }
    return [result, offset + 1];
  }

  // Byte string: <length>:<bytes>
  const colon = buf.indexOf(0x3a, start);
  if (colon < 0) throw new BencodeError('unterminated string');
  const length = Number(buf.subarray(start, colon).toString('latin1'));
  if (!Number.isInteger(length) || length < 0) throw new BencodeError('bad string length');
  const from = colon + 1;
  const to = from + length;
  if (to > buf.length) throw new BencodeError('string past end of data');
  return [buf.subarray(from, to), to];
}

export interface TorrentFileInfo {
  infoHash: string;
  name: string;
  size: number;
}

/** Throws when the data is not a usable .torrent. */
export function parseTorrentFile(data: Buffer): TorrentFileInfo {
  let root: Bencode;
  try {
    [root] = decode(data, 0);
  } catch (error) {
    throw new Error(`not a valid .torrent file (${(error as Error).message})`);
  }
  if (!root || typeof root !== 'object' || Array.isArray(root) || Buffer.isBuffer(root)) {
    throw new Error('not a valid .torrent file (expected a dictionary)');
  }

  const record = root as Record<string, Bencode>;
  const span = (record as unknown as Record<string, [number, number]>).__span_info;
  const info = record.info;
  if (!span || !info || typeof info !== 'object' || Array.isArray(info) || Buffer.isBuffer(info)) {
    throw new Error('not a valid .torrent file (no info dictionary)');
  }

  const infoRecord = info as Record<string, Bencode>;
  const name = Buffer.isBuffer(infoRecord.name) ? infoRecord.name.toString('utf8') : '';
  const length = typeof infoRecord.length === 'number' ? infoRecord.length : 0;
  const files = Array.isArray(infoRecord.files) ? infoRecord.files : [];
  const total =
    length ||
    files.reduce<number>((sum, entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Buffer.isBuffer(entry)) {
        return sum;
      }
      const size = (entry as Record<string, Bencode>).length;
      return sum + (typeof size === 'number' ? size : 0);
    }, 0);

  if (!Buffer.isBuffer(infoRecord.pieces) && files.length === 0 && !length) {
    throw new Error('not a valid .torrent file (info dictionary is incomplete)');
  }

  const infoHash = crypto
    .createHash('sha1')
    .update(data.subarray(span[0], span[1]))
    .digest('hex')
    .toUpperCase();

  return { infoHash, name, size: total };
}
