/**
 * Test doubles shared by the server suites. Excluded from the runtime build
 * (tsconfig.json) and never matched by the test glob, so nothing here can
 * leak into the image or run as a test of its own.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config';
import type { MulticallEntry, RpcClient } from '../rtorrent';
import { Store } from '../store';
import { XmlRpcFault, type XValue } from '../xmlrpc';

/** What a scripted method answers: a value, an Error (becomes a fault), or a function of the params. */
export type Answer = XValue | Error | ((params: XValue[]) => XValue | Error);

export interface Call {
  method: string;
  params: XValue[];
}

/**
 * An RpcClient that answers from a table instead of a socket and records
 * every call, so a test can assert on exactly what would have reached
 * rtorrent — and, just as importantly, what would not have.
 */
export class FakeClient implements RpcClient {
  readonly endpoint = 'fake';
  readonly calls: Call[] = [];

  constructor(private readonly answers: Record<string, Answer> = {}) {}

  /** Add or replace an answer after construction. */
  answer(method: string, answer: Answer): this {
    this.answers[method] = answer;
    return this;
  }

  /** Every recorded call of one method, in order. */
  callsTo(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  /**
   * Answer from the table; a command that is listed by system.listMethods but
   * not scripted answers 0, the way rtorrent's setters and lifecycle commands
   * do, and anything unlisted faults the way rtorrent faults.
   */
  private resolve(method: string, params: XValue[]): XValue | Error {
    this.calls.push({ method, params });
    const answer = this.answers[method];
    if (answer === undefined) {
      const listed = this.answers['system.listMethods'];
      if (Array.isArray(listed) && listed.includes(method)) return 0;
      return new XmlRpcFault(-506, `Method '${method}' not defined`);
    }
    if (typeof answer === 'function') return answer(params);
    return answer;
  }

  raw(): Promise<Buffer> {
    return Promise.resolve(Buffer.from('<methodResponse/>'));
  }

  async call<T extends XValue = XValue>(method: string, params: XValue[] = []): Promise<T> {
    const result = this.resolve(method, params);
    if (result instanceof Error) throw result;
    return result as T;
  }

  async multicall(entries: MulticallEntry[]): Promise<XValue[]> {
    const results = await this.multicallSettled(entries);
    return results.map((item) => {
      if (item instanceof XmlRpcFault) throw item;
      return item;
    });
  }

  async multicallSettled(entries: MulticallEntry[]): Promise<Array<XValue | XmlRpcFault>> {
    return entries.map((entry) => {
      const result = this.resolve(entry.methodName, entry.params);
      if (result instanceof XmlRpcFault) {
        return new XmlRpcFault(result.faultCode, `${entry.methodName}: ${result.faultString}`);
      }
      if (result instanceof Error) return new XmlRpcFault(-1, `${entry.methodName}: ${result.message}`);
      return result;
    });
  }

  async fieldMulticall<T extends Record<string, XValue>>(
    method: string,
    leadingParams: XValue[],
    fields: readonly string[],
  ): Promise<T[]> {
    const rows = await this.call(method, [...leadingParams, ...fields.map((f) => `${f}=`)]);
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const values = Array.isArray(row) ? row : [row];
      const record: Record<string, XValue> = {};
      fields.forEach((field, index) => {
        record[field] = values[index] ?? '';
      });
      return record as T;
    });
  }
}

/** A fresh temp directory per call; the OS cleans it up eventually. */
export function tempDir(prefix = 'cascade-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A store backed by a file nobody else touches. */
export function tempStore(): { store: Store; file: string } {
  const file = path.join(tempDir('cascade-store-'), 'state.json');
  return { store: new Store(file), file };
}

/** A complete Config rooted in a temp directory, with any field overridden. */
export function testConfig(over: Partial<Config> = {}): Config {
  const root = tempDir();
  const downloadDir = path.join(root, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });
  return {
    scgi: { kind: 'unix', path: path.join(root, 'rpc.socket') },
    host: '127.0.0.1',
    port: 0,
    basePath: '/',
    webRoot: path.join(root, 'web'),
    stateFile: path.join(root, 'state.json'),
    downloadDir,
    deleteRoots: [downloadDir],
    allowRawRpc: true,
    allowDataDelete: true,
    maxUploadBytes: 1024 * 1024,
    pollIntervalMs: 1000,
    logFile: path.join(root, 'rtorrent.log'),
    logLevel: 'info',
    bootSettingsFile: path.join(root, 'boot-settings.json'),
    gamify: true,
    ...over,
  };
}

/** The listMethods answer a fake backend gives: every command a test cares about. */
export function methodList(extra: string[] = []): string[] {
  return [
    'system.listMethods',
    'system.client_version',
    'system.library_version',
    'system.api_version',
    'system.multicall',
    'd.multicall2',
    'd.hash',
    'd.name',
    'd.open',
    'd.start',
    'd.stop',
    'd.close',
    'd.erase',
    'd.base_path',
    'd.custom1.set',
    'd.check_hash',
    'd.message.set',
    'load.raw_start',
    'load.raw',
    'load.start',
    'load.normal',
    'throttle.up',
    'throttle.down',
    'throttle.global_down.max_rate',
    'throttle.global_down.max_rate.set',
    'throttle.global_up.max_rate',
    'throttle.global_up.max_rate.set',
    'network.listen.port',
    'directory.default',
    'protocol.pex',
    'protocol.pex.set',
    'log.add_output',
    ...extra,
  ];
}
