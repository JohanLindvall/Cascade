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

export function relative(value: number): string {
  if (!value) return '—';
  const delta = Date.now() / 1000 - value;
  if (delta < 60) return 'just now';
  return `${duration(delta)} ago`;
}

/** Parse "12", "12k", "1.5M" into bytes/second. Empty or 0 means unlimited. */
export function parseRate(input: string): number {
  const text = input.trim();
  if (text === '') return 0;
  const match = /^([\d.]+)\s*([kKmMgG])?/.exec(text);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const suffix = (match[2] ?? 'k').toLowerCase();
  const factor = suffix === 'g' ? 1024 ** 3 : suffix === 'm' ? 1024 ** 2 : 1024;
  return Math.round(value * factor);
}

/** Render a byte rate back into the compact KiB/MiB form used by the inputs. */
export function formatRateInput(value: number): string {
  if (!value) return '';
  if (value % 1024 ** 2 === 0) return `${value / 1024 ** 2}M`;
  return `${Math.round(value / 1024)}k`;
}

export function fileName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}
