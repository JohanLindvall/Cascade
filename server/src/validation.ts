import { HttpError } from './errors';

export function requireRecord(value: unknown, field = 'body'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `"${field}" must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new HttpError(400, `"${field}" must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    throw new HttpError(400, `"${field}" contains control characters`);
  }
  return value.trim();
}

/** Numeric strings support URL parameters and multipart fields; coercible objects do not. */
export function requireInt(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new HttpError(400, `"${field}" must be a whole number from ${min} to ${max}`);
  }
  return number;
}

export function requireBool(value: unknown, field: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || (typeof value === 'string' && /^(1|true|yes|on)$/i.test(value))) return true;
  if (value === 0 || (typeof value === 'string' && /^(0|false|no|off)$/i.test(value))) return false;
  throw new HttpError(400, `"${field}" must be a boolean`);
}
