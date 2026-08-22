/**
 * SCGI transport for rtorrent's XML-RPC endpoint.
 *
 * rtorrent listens either on a unix socket (network.scgi.open_local) or a TCP
 * port (network.scgi.open_port). Both speak SCGI: a netstring of NUL-separated
 * header pairs followed by the body, answered with an HTTP-ish response.
 */
import net from 'node:net';

export type ScgiTarget =
  | { kind: 'unix'; path: string }
  | { kind: 'tcp'; host: string; port: number };

export function parseScgiTarget(raw: string): ScgiTarget {
  const value = raw.trim();
  if (value.startsWith('unix:')) return { kind: 'unix', path: value.slice(5) };
  if (value.startsWith('/') || value.startsWith('./')) return { kind: 'unix', path: value };
  const match = /^(?:scgi:\/\/)?(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value);
  if (match) {
    const host = match[1].startsWith('[') ? match[1].slice(1, -1) : match[1];
    return { kind: 'tcp', host, port: Number(match[2]) };
  }
  if (/^\d+$/.test(value)) return { kind: 'tcp', host: '127.0.0.1', port: Number(value) };
  return { kind: 'unix', path: value };
}

export function describeTarget(target: ScgiTarget): string {
  return target.kind === 'unix' ? `unix:${target.path}` : `${target.host}:${target.port}`;
}

function buildHeaders(bodyLength: number): Buffer {
  const pairs = [
    'CONTENT_LENGTH',
    String(bodyLength),
    'SCGI',
    '1',
    'REQUEST_METHOD',
    'POST',
    'REQUEST_URI',
    '/RPC2',
    'CONTENT_TYPE',
    'text/xml',
  ];
  const headers = Buffer.from(pairs.join('\0') + '\0', 'latin1');
  return Buffer.concat([Buffer.from(`${headers.length}:`, 'latin1'), headers, Buffer.from(',')]);
}

function stripHttpHeaders(response: Buffer): Buffer {
  const separators = ['\r\n\r\n', '\n\n'];
  for (const separator of separators) {
    const index = response.indexOf(separator);
    if (index >= 0) return response.subarray(index + separator.length);
  }
  return response;
}

export interface ScgiOptions {
  timeoutMs?: number;
}

export function scgiRequest(
  target: ScgiTarget,
  body: Buffer,
  options: ScgiOptions = {},
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const socket =
      target.kind === 'unix'
        ? net.connect({ path: target.path })
        : net.connect({ host: target.host, port: target.port });

    const finish = (error: Error | null, value?: Buffer) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value as Buffer);
    };

    const complete = () => {
      const raw = Buffer.concat(chunks);
      if (raw.length === 0) {
        // A closed connection with no bytes is rtorrent dropping the request —
        // typically mid-startup or under load. An empty buffer would otherwise
        // surface as a confusing XML parse error.
        finish(
          new Error(
            `rtorrent closed the SCGI connection on ${describeTarget(target)} without responding`,
          ),
        );
        return;
      }
      finish(null, stripHttpHeaders(raw));
    };

    socket.setTimeout(timeoutMs, () => {
      finish(new Error(`SCGI request to ${describeTarget(target)} timed out after ${timeoutMs}ms`));
    });

    socket.on('connect', () => {
      socket.write(buildHeaders(body.length));
      socket.write(body);
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', complete);
    socket.on('close', complete);
    socket.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      let reason: string;
      switch (code) {
        case 'ENOENT':
          reason = `rtorrent is not running — no SCGI socket at ${describeTarget(target)}`;
          break;
        case 'ECONNREFUSED':
          // The socket file outlives the process, so this is the usual symptom
          // of rtorrent having died or failed to start.
          reason =
            `rtorrent is not accepting connections on ${describeTarget(target)} — ` +
            'it has stopped or failed to start; check the container log';
          break;
        case 'EACCES':
          reason = `permission denied opening ${describeTarget(target)} — check PUID/PGID`;
          break;
        default:
          reason = `SCGI error talking to ${describeTarget(target)}: ${error.message}`;
      }
      finish(new Error(reason));
    });
  });
}
