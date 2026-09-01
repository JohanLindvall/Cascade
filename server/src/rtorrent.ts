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

/** One request/response exchange with rtorrent; the SCGI socket by default. */
export type Transport = (body: Buffer) => Promise<Buffer>;

/**
 * What the layers above need from a client — kept narrow so a test can hand
 * the service or the capability probe a scripted stand-in instead of a socket.
 */
export interface RpcClient {
  readonly endpoint: string;
  raw(body: Buffer): Promise<Buffer>;
  call<T extends XValue = XValue>(method: string, params?: XValue[]): Promise<T>;
  multicall(entries: MulticallEntry[]): Promise<XValue[]>;
  multicallSettled(entries: MulticallEntry[]): Promise<Array<XValue | XmlRpcFault>>;
  fieldMulticall<T extends Record<string, XValue>>(
    method: string,
    leadingParams: XValue[],
    fields: readonly string[],
  ): Promise<T[]>;
}

export const MAX_CONCURRENCY = 4;

export class RtorrentClient implements RpcClient {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly transport: Transport;

  constructor(
    private readonly target: ScgiTarget,
    transport?: Transport,
  ) {
    this.transport = transport ?? ((body) => scgiRequest(target, body));
  }

  get endpoint(): string {
    return describeTarget(this.target);
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    // Re-check after every wake: a wake and the increment are not atomic, so
    // with a plain `if` a caller arriving between a finisher's decrement and
    // the woken waiter's increment pushed the count past the cap — and the
    // cap exists because rtorrent is single-threaded.
    while (this.active >= MAX_CONCURRENCY) {
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
    return this.withSlot(() => this.transport(body));
  }

  async call<T extends XValue = XValue>(method: string, params: XValue[] = []): Promise<T> {
    const response = await this.raw(serializeCall(method, params));
    return parseResponse(response.toString('utf8')) as T;
  }

  /** Batch several commands into one round trip via system.multicall. */
  async multicall(entries: MulticallEntry[]): Promise<XValue[]> {
    const results = await this.multicallSettled(entries);
    return results.map((item) => {
      if (item instanceof XmlRpcFault) throw item;
      return item;
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
    return result.map((item, index) => {
      if (isFaultStruct(item)) {
        // Name the command in the fault: "-503 Wrong object type" on its own
        // does not say which of a dozen batched calls went wrong.
        const fault = faultFrom(item);
        return new XmlRpcFault(
          fault.faultCode,
          `${entries[index]?.methodName ?? 'unknown method'}: ${fault.faultString}`,
        );
      }
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

/**
 * A settled multicall slot as a number: faults and non-numeric answers read as
 * zero, which is what every gauge in the UI wants from a probe that failed.
 */
export function settledNumber(value: XValue | XmlRpcFault | undefined): number {
  if (value === undefined || value instanceof Error) return 0;
  return Number(value) || 0;
}

export { XmlRpcFault };
export type { XValue };
