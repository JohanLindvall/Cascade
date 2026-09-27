import type { Request } from 'express';
import type { StorageEngine } from 'multer';
import { HttpError } from './errors';

/** Multer's fileSize limit is per file. Bound the whole batch before buffering
 *  it, including chunked requests that have no Content-Length header. */
export function boundedUploadStorage(maxBytes: number): StorageEngine {
  const totals = new WeakMap<Request, number>();
  return {
    _handleFile(req, file, callback) {
      const chunks: Buffer[] = [];
      let size = 0;
      let finished = false;
      file.stream.on('data', (chunk: Buffer) => {
        if (finished) return;
        const total = (totals.get(req) ?? 0) + chunk.length;
        totals.set(req, total);
        if (total > maxBytes) {
          finished = true;
          chunks.length = 0;
          callback(new HttpError(413, `torrent upload batch exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      file.stream.on('error', (error) => {
        if (finished) return;
        finished = true;
        callback(error);
      });
      file.stream.on('end', () => {
        if (finished) return;
        finished = true;
        callback(null, { buffer: Buffer.concat(chunks, size), size });
      });
    },
    _removeFile(_req, file, callback) {
      // Release successful earlier files when another part rejects the batch.
      file.buffer = Buffer.alloc(0);
      callback(null);
    },
  };
}
