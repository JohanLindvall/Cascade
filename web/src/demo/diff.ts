// SPDX-License-Identifier: MIT

/**
 * The server's half of the delta protocol, for the simulated stream: the
 * normalized state the hub keeps (server/internal/stream/patch.go's keyed
 * arrays) and the patch that turns one state into the next — the exact
 * inverse of applyPatch in ../stream.ts, held to the same golden cases.
 *
 *   - an object patches an object key by key, recursively, and its "-" key
 *     lists the keys that are gone;
 *   - an object patches an array of the same length index by index;
 *   - {"=": value} replaces whatever was there with value, where an object
 *     takes the place of an array;
 *   - anything else (an array, a scalar, null) replaces the old value.
 *
 * Two cases patch.go never meets, since no key of the state is "-" or "=",
 * are wrapped in {"=": …} here too, so a round trip holds for any JSON: an
 * object with a "-" key, and one whose only changed key is "=" — applyPatch
 * would read either as an instruction rather than as data.
 */
import { KEYED, type Json, type JsonObject } from '../stream.ts';

const DELETE = '-';
const REPLACE = '=';

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Assigning "__proto__" would set the prototype rather than add the key. */
function put(target: JsonObject, key: string, value: Json): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

/** An object applyPatch would take for an instruction if it arrived whole. */
function misread(value: JsonObject): boolean {
  const keys = Object.keys(value);
  return Object.hasOwn(value, DELETE) || (keys.length === 1 && keys[0] === REPLACE);
}

/** The patch that turns prev into next, or undefined when they are the same. */
export function diff(prev: Json | undefined, next: Json): Json | undefined {
  if (Array.isArray(next)) {
    if (!Array.isArray(prev) || prev.length !== next.length) return next;
    const out: JsonObject = {};
    let changed = false;
    for (let i = 0; i < next.length; i++) {
      const patch = diff(prev[i], next[i]);
      if (patch !== undefined) {
        out[String(i)] = patch;
        changed = true;
      }
    }
    return changed ? out : undefined;
  }
  if (isObject(next)) {
    if (!isObject(prev)) return Array.isArray(prev) || misread(next) ? { [REPLACE]: next } : next;
    if (Object.hasOwn(next, DELETE)) return equal(prev, next) ? undefined : { [REPLACE]: next };
    const out: JsonObject = {};
    for (const key of Object.keys(next)) {
      const patch = Object.hasOwn(prev, key) ? diff(prev[key], next[key]) : diff(undefined, next[key]);
      if (patch !== undefined) put(out, key, patch);
    }
    const gone = Object.keys(prev).filter((key) => !Object.hasOwn(next, key)).sort();
    if (gone.length > 0) out[DELETE] = gone;
    const keys = Object.keys(out);
    if (keys.length === 0) return undefined;
    return keys.length === 1 && keys[0] === REPLACE ? { [REPLACE]: next } : out;
  }
  // Scalars: JSON writes 0 and -0 alike, which === agrees with.
  return prev === next ? undefined : next;
}

/** Whether two values are the same JSON. */
function equal(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => equal(item, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

/**
 * The state as the hub holds it: each KEYED array an object keyed by the
 * entry's field — unless an entry lacks a usable key or repeats one, when the
 * array stays an array and only patches less compactly (keyedBy in patch.go).
 */
export function normalize(state: JsonObject): JsonObject {
  const out: JsonObject = { ...state };
  for (const { path, field } of KEYED) {
    let parent: JsonObject = out;
    let reachable = true;
    for (const name of path.slice(0, -1)) {
      const child = parent[name];
      if (!isObject(child)) {
        reachable = false;
        break;
      }
      parent = parent[name] = { ...child };
    }
    const last = path[path.length - 1];
    const list = reachable ? parent[last] : undefined;
    if (!Array.isArray(list)) continue;
    const keyed: JsonObject = {};
    let usable = true;
    for (const entry of list) {
      const key = isObject(entry) ? keyOf(entry[field]) : null;
      if (key === null || Object.hasOwn(keyed, key)) {
        usable = false;
        break;
      }
      put(keyed, key, entry);
    }
    if (usable) parent[last] = keyed;
  }
  return out;
}

/** A key as the client keys it: a non-empty string, or a number's text. */
function keyOf(value: Json | undefined): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}
