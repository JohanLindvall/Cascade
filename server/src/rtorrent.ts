/**
 * Typed client for rtorrent's XML-RPC API.
 *
 * rtorrent processes commands on its single main thread, so requests are queued
 * with a small concurrency cap; hammering it with parallel multicalls stalls the
 * torrent engine itself.
 */
import { scgiRequest, describeTarget, type ScgiTarget } from './scgi';
import {
  serializeCall,
  parseResponse,
  faultFrom,
  isFaultStruct,
  XmlRpcFault,
  type XValue,
} from './xmlrpc';

export interface MulticallEntry {
  methodName: string;
  params: XValue[];
}

const MAX_CONCURRENCY = 4;

export class RtorrentClient {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly target: ScgiTarget) {}

  get endpoint(): string {
    return describeTarget(this.target);
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENCY) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  /** Send a raw XML-RPC body and return the raw response (used by the /RPC2 proxy). */
  raw(body: Buffer): Promise<Buffer> {
    return this.withSlot(() => scgiRequest(this.target, body));
  }

  async call<T extends XValue = XValue>(method: string, params: XValue[] = []): Promise<T> {
    const response = await this.raw(serializeCall(method, params));
    return parseResponse(response.toString('utf8')) as T;
  }

  /** Batch several commands into one round trip via system.multicall. */
  async multicall(entries: MulticallEntry[]): Promise<XValue[]> {
    if (entries.length === 0) return [];
    const payload: XValue[] = entries.map((entry) => ({
      methodName: entry.methodName,
      params: entry.params,
    }));
    const result = await this.call('system.multicall', [payload]);
    if (!Array.isArray(result)) throw new Error('system.multicall returned a non-array');
    return result.map((item) => {
      if (isFaultStruct(item)) throw faultFrom(item);
      return Array.isArray(item) && item.length > 0 ? item[0] : '';
    });
  }

  /** Like multicall(), but individual failures surface as XmlRpcFault values. */
  async multicallSettled(entries: MulticallEntry[]): Promise<Array<XValue | XmlRpcFault>> {
    if (entries.length === 0) return [];
    const payload: XValue[] = entries.map((entry) => ({
      methodName: entry.methodName,
      params: entry.params,
    }));
    const result = await this.call('system.multicall', [payload]);
    if (!Array.isArray(result)) throw new Error('system.multicall returned a non-array');
    return result.map((item) => {
      if (isFaultStruct(item)) return faultFrom(item);
      return Array.isArray(item) && item.length > 0 ? item[0] : '';
    });
  }

  /**
   * Run a `*.multicall` command (d./f./p./t.) and zip the flat result rows into
   * objects keyed by the supplied field names.
   */
  async fieldMulticall<T extends Record<string, XValue>>(
    method: string,
    leadingParams: XValue[],
    fields: readonly string[],
  ): Promise<T[]> {
    const result = await this.call(method, [...leadingParams, ...fields.map((f) => `${f}=`)]);
    if (!Array.isArray(result)) return [];
    return result.map((row) => {
      const values = Array.isArray(row) ? row : [row];
      const record: Record<string, XValue> = {};
      fields.forEach((field, index) => {
        record[field] = values[index] ?? '';
      });
      return record as T;
    });
  }
}

export { XmlRpcFault };
export type { XValue };
