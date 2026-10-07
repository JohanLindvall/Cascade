// SPDX-License-Identifier: MIT

/**
 * The server's checks at the API edge (server/internal/validate), worded the
 * same, so a refusal reads in the demo as it does against a real install. A
 * refusal is thrown as an HttpError and answered as {"error": message}.
 */

export class HttpError extends Error {
  readonly status: number;
  /** An rtorrent fault's code, answered beside the message as faultCode. */
  readonly faultCode: number | undefined;

  constructor(status: number, message: string, faultCode?: number) {
    super(message);
    this.status = status;
    this.faultCode = faultCode;
  }
}

/** rtorrent's own refusal: a 502 carrying its message and fault code, as the server relays it. */
export class Fault extends HttpError {
  constructor(code: number, message: string) {
    super(502, message, code);
  }
}

const quote = (field: string) => JSON.stringify(field);

export function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `${quote(field)} must be an object`);
  }
  return value as Record<string, unknown>;
}

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

/** A string, trimmed as the browser trims, free of control characters, and unless allowEmpty, not blank. */
export function text(value: unknown, field: string, allowEmpty: boolean): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new HttpError(400, `${quote(field)} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  if (CONTROL.test(value)) throw new HttpError(400, `${quote(field)} contains control characters`);
  return value.trim();
}

/** A whole number from min to max; numeric strings count, as URL and form fields carry nothing else. */
export function int(value: unknown, field: string, min: number, max: number): number {
  let number = NaN;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) number = Number(value.trim());
  if (!Number.isInteger(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER || number < min || number > max) {
    throw new HttpError(400, `${quote(field)} must be a whole number from ${min} to ${max}`);
  }
  return number;
}

/** A boolean, 1/0, or one of the usual spellings of either. */
export function bool(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 1 || (typeof value === 'string' && /^(1|true|yes|on)$/i.test(value))) return true;
  if (value === 0 || (typeof value === 'string' && /^(0|false|no|off)$/i.test(value))) return false;
  throw new HttpError(400, `${quote(field)} must be a boolean`);
}
