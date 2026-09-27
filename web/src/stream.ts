/**
 * The client half of the state stream (GET api/stream, server-sent events).
 *
 * The server reads the state once for every open page and sends each page a
 * snapshot, then only what changed. Its patches mirror the state's shape and
 * hold just the changes (server/internal/stream/patch.go, whose rules this
 * file applies — keep the two in step):
 *
 *   - an object patches an object key by key, recursively, and its "-" key
 *     lists the keys that are gone;
 *   - an object patches an array of the same length index by index ("0",
 *     "1", …);
 *   - {"=": value} replaces whatever was there with value — needed only
 *     where an object takes the place of an array, which the rule above
 *     would read as an index patch;
 *   - anything else (an array, a scalar, null) replaces the old value.
 *
 * Arrays whose entries come and go are sent as objects keyed by one of their
 * fields (KEYED), so an added torrent patches that one entry rather than every
 * index after it; the denormalizer turns them back into the arrays the
 * components expect. Pure: the node test runner applies the same golden cases
 * the Go tests diff (server/internal/stream/testdata/patches.json).
 */
import type { StateResponse } from './types.ts';

export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

const DELETE = '-';
const REPLACE = '=';

/** The arrays the server sends keyed by a field of their entries (`keyed` in patch.go). */
export const KEYED: ReadonlyArray<{ path: readonly string[]; field: string }> = [
  { path: ['torrents'], field: 'hash' },
  { path: ['status', 'history'], field: 't' },
];

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An own key only: the keys are data (info hashes), and "__proto__" must read as one. */
function own(target: JsonObject, key: string): Json | undefined {
  return Object.hasOwn(target, key) ? target[key] : undefined;
}

function put(target: JsonObject, key: string, value: Json): void {
  // Assigning "__proto__" would set the prototype rather than add the key.
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

/**
 * The value after `patch`. Copy-on-write: only the objects and arrays along
 * patched paths are new, so everything that did not change keeps its
 * identity — and a torrent row whose props are the same object renders as
 * nothing changed.
 */
export function applyPatch(current: Json | undefined, patch: Json): Json {
  if (!isObject(patch)) return patch;
  const keys = Object.keys(patch);
  if (keys.length === 1 && keys[0] === REPLACE) return patch[REPLACE];
  if (Array.isArray(current)) {
    let out: Json[] | undefined;
    for (const key of keys) {
      if (!/^\d+$/.test(key)) continue;
      const index = Number(key);
      if (index >= current.length) continue;
      out ??= current.slice();
      out[index] = applyPatch(current[index], patch[key]);
    }
    return out ?? current;
  }
  if (isObject(current)) {
    const out: JsonObject = { ...current };
    for (const key of keys) {
      if (key === DELETE) {
        const gone = patch[key];
        if (Array.isArray(gone)) for (const name of gone) if (typeof name === 'string') delete out[name];
        continue;
      }
      put(out, key, applyPatch(own(out, key), patch[key]));
    }
    return out;
  }
  // A patch object over nothing (or a scalar) is the new value itself.
  return patch;
}

/**
 * Turns normalized states back into StateResponses, reusing what did not
 * change: a branch the last patch left alone is the same object here as it
 * was, so the torrent list keeps its identity while only the rates moved,
 * and the filtering and sorting keyed on it are not redone.
 */
export function denormalizer(): (state: JsonObject) => StateResponse {
  const restored = new WeakMap<JsonObject, JsonObject>();
  const lists = new WeakMap<JsonObject, Json[]>();

  /** A keyed object's entries; numbered ones (the history's t) in number order. */
  const entries = (value: Json | undefined, field: string): Json | undefined => {
    if (!isObject(value)) return value; // Sent as an array after all: an entry lacked its key.
    let list = lists.get(value);
    if (!list) {
      list = Object.values(value);
      if (list.every((entry) => isObject(entry) && typeof entry[field] === 'number')) {
        list.sort((a, b) => ((a as JsonObject)[field] as number) - ((b as JsonObject)[field] as number));
      }
      lists.set(value, list);
    }
    return list;
  };

  const restore = (node: JsonObject, depth: number, specs: typeof KEYED): JsonObject => {
    const hit = restored.get(node);
    if (hit) return hit;
    const out: JsonObject = { ...node };
    for (const name of new Set(specs.map((spec) => spec.path[depth]))) {
      const child = own(node, name);
      if (child === undefined) continue;
      const below = specs.filter((spec) => spec.path[depth] === name);
      const leaf = below.find((spec) => spec.path.length === depth + 1);
      if (leaf) put(out, name, entries(child, leaf.field) as Json);
      else if (isObject(child)) put(out, name, restore(child, depth + 1, below));
    }
    restored.set(node, out);
    return out;
  };

  return (state) => restore(state, 0, KEYED) as unknown as StateResponse;
}

/** What the page knows of the stream: the state, where it is in the stream, and the server's own trouble. */
export interface StreamModel {
  /** The normalized state; null until the first snapshot. */
  state: JsonObject | null;
  /** The id of the last snapshot or delta applied, for ?since= when reopening. */
  lastId: string;
  /** What a failure event said, until an ok event says the state can be read again. */
  failure: string | null;
}

export const EMPTY_MODEL: StreamModel = { state: null, lastId: '', failure: null };

export interface StreamEvent {
  type: string;
  data: string;
  /** The SSE id: "<epoch>-<rev>" on snapshots and deltas, empty otherwise. */
  id: string;
}

/** An id's epoch (one per server run) and revision. */
function position(id: string): { epoch: string; rev: number } | null {
  const cut = id.lastIndexOf('-');
  const rev = Number(id.slice(cut + 1));
  return cut > 0 && Number.isSafeInteger(rev) ? { epoch: id.slice(0, cut), rev } : null;
}

function parse(data: string): Json | undefined {
  try {
    return JSON.parse(data) as Json;
  } catch {
    return undefined;
  }
}

/**
 * Fold one event into the model. 'resync' means the model cannot be trusted
 * any more — a delta with nothing to apply to, one that skips a revision, or
 * one that does not parse — and only a fresh snapshot can put it right.
 */
export function reduce(model: StreamModel, event: StreamEvent): StreamModel | 'resync' {
  switch (event.type) {
    case 'snapshot': {
      const state = parse(event.data);
      if (!isObject(state)) return 'resync';
      return { ...model, state, lastId: event.id };
    }
    case 'delta': {
      if (!model.state) return 'resync';
      const last = position(model.lastId);
      const here = position(event.id);
      // Revisions count up by one per delta within a server's run; a gap is
      // a change this page never saw.
      if (last && here && (here.epoch !== last.epoch || here.rev !== last.rev + 1)) return 'resync';
      const patch = parse(event.data);
      if (patch === undefined) return 'resync';
      const state = applyPatch(model.state, patch);
      if (!isObject(state)) return 'resync';
      return { ...model, state, lastId: event.id || model.lastId };
    }
    case 'failure': {
      const body = parse(event.data);
      const message = isObject(body) && typeof body.error === 'string' && body.error
        ? body.error : 'the server cannot read the state';
      return model.failure === message ? model : { ...model, failure: message };
    }
    case 'ok':
      return model.failure === null ? model : { ...model, failure: null };
    default:
      return model;
  }
}
