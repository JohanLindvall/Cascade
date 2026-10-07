// SPDX-License-Identifier: MIT

/**
 * Small presentational pieces shared across the UI. The stateful primitives
 * live beside them: modal.tsx, form.tsx, menu.tsx and toast.tsx.
 */
import { useId, type ReactNode } from 'react';

export type BarVariant = 'default' | 'done' | 'error' | 'idle' | 'checking';

export function ProgressBar({
  value,
  variant = 'default',
  striped,
  live,
  label,
  className,
}: {
  value: number;
  variant?: BarVariant;
  striped?: boolean;
  /** Sweeps a highlight across the filled portion while data is moving. */
  live?: boolean;
  /** What the bar measures, for assistive technology ("Progress of <name>"). */
  label?: string;
  /** A variant's own look, such as the level bars'. */
  className?: string;
}) {
  const percent = Math.min(100, Math.max(0, value * 100));
  const classes = ['bar'];
  if (className) classes.push(className);
  if (variant !== 'default') classes.push(variant);
  if (striped) classes.push('striped');
  if (live) classes.push('live');
  return (
    <div
      className={classes.join(' ')}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-label={label}
    >
      <i style={{ width: `${percent}%` }} />
    </div>
  );
}

/* ------------------------------ sparkline ------------------------------- */

export function Sparkline({
  down,
  up,
  width = 148,
  height = 32,
}: {
  down: number[];
  up: number[];
  width?: number;
  height?: number;
}) {
  // Gradient ids are document-global; useId keeps two sparklines from sharing
  // (and restyling) each other's. Colons are not safe inside url(#…).
  const id = useId().replace(/:/g, '');
  const peak = Math.max(0, ...down, ...up);
  // With no traffic every sample sits on the baseline; drawing that at full
  // strength reads as a stray underline, so the idle state is dimmed.
  const idle = peak <= 0;
  const max = Math.max(1, peak);
  const pad = 2;
  const usable = height - pad * 2;

  const points = (series: number[]): string => {
    if (series.length === 0) return '';
    if (series.length === 1) series = [series[0], series[0]];
    const step = width / (series.length - 1);
    return series
      .map(
        (value, index) =>
          `${(index * step).toFixed(1)},${(height - pad - (value / max) * usable).toFixed(1)}`,
      )
      .join(' ');
  };
  const area = (series: number[]): string => {
    const line = points(series);
    if (!line) return '';
    return `M0,${height} L${line.split(' ').join(' L')} L${width},${height} Z`;
  };

  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id={`${id}down`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--down)" stopOpacity="0.38" />
          <stop offset="100%" stopColor="var(--down)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}up`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--up)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--up)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width={width} height={height} rx="7" fill="var(--panel-strong)" />
      <line
        x1="0"
        y1={height - pad}
        x2={width}
        y2={height - pad}
        stroke="var(--border)"
        strokeWidth="1"
      />
      <g opacity={idle ? 0.3 : 1}>
        <path d={area(down)} fill={`url(#${id}down)`} />
        <path d={area(up)} fill={`url(#${id}up)`} />
        <polyline points={points(down)} fill="none" stroke="var(--down)" strokeWidth="1.5" />
        <polyline points={points(up)} fill="none" stroke="var(--up)" strokeWidth="1.5" />
      </g>
    </svg>
  );
}

/* -------------------------------- kv grid ------------------------------- */

/** Label-and-value pairs in a grid; a text value also shows in full on hover. */
export function KvGrid({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <div className="kv-grid">
      {rows.map(([key, value]) => (
        <div className="kv" key={key}>
          <span>{key}</span>
          <b title={typeof value === 'string' ? value : undefined}>{value}</b>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ empty state ----------------------------- */

export function EmptyState({
  glyph,
  title,
  children,
}: {
  glyph: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="glyph">{glyph}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
