import type { ProgressUnit } from './types';

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

export function bytes(value: number, precision?: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  let index = 0;
  let size = value;
  while (size >= 1024 && index < UNITS.length - 1) {
    size /= 1024;
    index++;
  }
  const digits = precision ?? (index === 0 ? 0 : size < 10 ? 2 : size < 100 ? 1 : 0);
  return `${size.toFixed(digits)} ${UNITS[index]}`;
}

export function rate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return `${bytes(value)}/s`;
}

export function percent(value: number, digits = 1): string {
  return `${(Math.min(1, Math.max(0, value)) * 100).toFixed(digits)}%`;
}

export function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '∞';
  if (seconds === 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d ${hours % 24}h`;
  return `${(days / 365).toFixed(1)}y`;
}

export function timestamp(value: number): string {
  if (!value) return '—';
  const date = new Date(value * 1000);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "in 4m 12s" for a future unix timestamp, "—" when unset or past. */
export function until(value: number): string {
  if (!value) return '—';
  const delta = value - Date.now() / 1000;
  if (delta <= 0) return 'due';
  return `in ${duration(delta)}`;
}

export function relative(value: number): string {
  if (!value) return '—';
  const delta = Date.now() / 1000 - value;
  if (delta < 60) return 'just now';
  return `${duration(delta)} ago`;
}

const RATE_FACTORS: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/**
 * Parse "12", "12k", "1.5M", "2 MiB/s", "800 B/s" into bytes/second. A bare
 * number is KiB/s (the convention of every rtorrent front end); empty means
 * 0, which rtorrent reads as unlimited. Anything else is null, not 0: a limit
 * is a live throttle, and a typo ("1.5.2", "fast") that quietly parsed to 0
 * used to lift it altogether.
 */
export function parseRate(input: string): number | null {
  const text = input.trim();
  if (text === '') return 0;
  const match = /^(\d+(?:\.\d+)?|\.\d+)\s*(?:([kmg])(?:i?b)?|(b))?(?:\/s)?$/i.exec(text);
  if (!match) return null;
  const factor = match[3] ? 1 : RATE_FACTORS[(match[2] ?? 'k').toLowerCase()];
  return Math.round(Number(match[1]) * factor);
}

/**
 * A whole number of at least `min`, or null. Settings and slot counts are
 * integers, and several accept -1 ("disabled"), so a lone "-" on the way to
 * "-1" has to read as not-yet-valid rather than as 0.
 */
export function parseWholeNumber(input: string, min = 0): number | null {
  const text = input.trim();
  if (!/^-?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min ? value : null;
}

/** Render a byte rate back into the compact KiB/MiB form used by the inputs. */
export function formatRateInput(value: number): string {
  if (!value) return '';
  if (value % 1024 ** 2 === 0) return `${value / 1024 ** 2}M`;
  return `${Math.round(value / 1024)}k`;
}

/**
 * One rtorrent log line, split up for display.
 *
 * rtorrent writes "<unix seconds> <level letter> <text>" for the severity
 * scopes, and the subsystem scopes (tracker_events, the *_debug groups) write
 * "<unix seconds> <text>" with no level at all — the same two shapes on every
 * release this UI drives (checked against 0.9.8, 0.16.20 and 0.16.22). Raw
 * epoch seconds are unreadable, so the dialog renders the time in the
 * viewer's own timezone; but nothing else is touched, and a line that does
 * not match either shape (a continuation, a crash dump, a future format) is
 * handed back whole rather than mangled to fit.
 */
export interface LogLine {
  /** When it happened, or null when the line carries no timestamp. */
  at: Date | null;
  /** critical | error | warn | notice | info | debug — "" when unknown. */
  level: string;
  /** Everything after the timestamp and level. */
  text: string;
}

const LOG_LEVELS: Record<string, string> = {
  C: 'critical',
  E: 'error',
  W: 'warn',
  N: 'notice',
  I: 'info',
  D: 'debug',
};

// A ten-digit epoch, an optional single level letter, then the message.
// Anchored, and the letter must stand alone, so a message that merely begins
// with digits or a capital cannot be mistaken for a timestamp or a level.
const LOG_RE = /^(\d{9,11}) (?:([CEWNID]) )?(.*)$/s;

export function parseLogLine(line: string): LogLine {
  const match = LOG_RE.exec(line);
  if (!match) return { at: null, level: '', text: line };
  const seconds = Number(match[1]);
  // A timestamp is only useful if it is a plausible one; anything else is
  // left as text rather than rendered as a date from 1970 or 3000.
  const at = seconds > 946_684_800 && seconds < 4_102_444_800 ? new Date(seconds * 1000) : null;
  return at
    ? { at, level: match[2] ? (LOG_LEVELS[match[2]] ?? '') : '', text: match[3] }
    : { at: null, level: '', text: line };
}

/** Clock time for a log row: seconds matter here, the date does not. */
export function logTime(at: Date): string {
  return at.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** The day a log row belongs to, for the separator between days. */
export function logDay(at: Date): string {
  return at.toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

export function fileName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

/**
 * A magnet link that reproduces the torrent from its info hash. Trackers are
 * left out on purpose: a private tracker's announce URL carries the owner's
 * passkey, and a copied magnet gets pasted to other people.
 */
export function magnetLink(hash: string, name?: string): string {
  const dn = name ? `&dn=${encodeURIComponent(name)}` : '';
  return `magnet:?xt=urn:btih:${hash.toLowerCase()}${dn}`;
}

/** rtorrent's d.priority, highest first, as the menu offers it. */
export const TORRENT_PRIORITIES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 3, label: 'High' },
  { value: 2, label: 'Normal' },
  { value: 1, label: 'Low' },
  { value: 0, label: 'Off' },
];

/** rtorrent's f.priority: 0 means the file is not downloaded at all. */
export const FILE_PRIORITIES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Skip' },
  { value: 1, label: 'Normal' },
  { value: 2, label: 'High' },
];

/** The label for a priority value, or the bare number for one no table names. */
export function priorityLabel(
  table: ReadonlyArray<{ value: number; label: string }>,
  value: number,
): string {
  return table.find((item) => item.value === value)?.label ?? String(value);
}

/** "1.20 GiB / 100 GiB", "3 / 10", "2.41 / 5.00" — progress in the target's own unit. */
export function progressText(unit: ProgressUnit, current: number, target: number): string {
  switch (unit) {
    case 'bytes':
      return `${bytes(current)} / ${bytes(target)}`;
    case 'rate':
      // Not rate(): that shows an idle zero as "—", which reads as "no data"
      // here rather than as the zero it is.
      return `${bytes(current)}/s / ${bytes(target)}/s`;
    case 'ratio':
      return `${current.toFixed(2)} / ${target.toFixed(2)}`;
    case 'duration':
      return `${duration(current)} / ${duration(target)}`;
    default:
      return `${Math.floor(current)} / ${target}`;
  }
}

/**
 * Bulk endpoints report failures as "<info hash>: <reason>". A hash means
 * nothing to the person reading the toast, so the torrent's name replaces it
 * where it is known.
 */
export function nameErrors(errors: string[], nameOf: (hash: string) => string | undefined): string[] {
  return errors.map((error) => {
    const match = /^([0-9A-Fa-f]{40}): (.*)$/s.exec(error);
    const name = match ? nameOf(match[1].toUpperCase()) : undefined;
    return match && name ? `${name}: ${match[2]}` : error;
  });
}
