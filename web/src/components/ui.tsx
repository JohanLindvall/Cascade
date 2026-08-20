import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { IconAlert, IconCheck, IconClose, IconInfo, IconTrophy } from './icons';

/* ------------------------------- modal --------------------------------- */

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Modal({ title, onClose, children, footer, wide }: ModalProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={wide ? 'modal wide' : 'modal'} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------ form bits ------------------------------- */

export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="switch" title={disabled ? 'not supported by this rtorrent build' : undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="track" />
      <span>{label}</span>
    </label>
  );
}

export function ProgressBar({
  value,
  variant = 'default',
  striped,
  live,
}: {
  value: number;
  variant?: 'default' | 'done' | 'error' | 'idle' | 'checking';
  striped?: boolean;
  /** Sweeps a highlight across the filled portion while data is moving. */
  live?: boolean;
}) {
  const classes = ['bar'];
  if (variant !== 'default') classes.push(variant);
  if (striped) classes.push('striped');
  if (live) classes.push('live');
  return (
    <div className={classes.join(' ')}>
      <i style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
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
        <linearGradient id="sparkDown" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--down)" stopOpacity="0.38" />
          <stop offset="100%" stopColor="var(--down)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sparkUp" x1="0" y1="0" x2="0" y2="1">
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
        <path d={area(down)} fill="url(#sparkDown)" />
        <path d={area(up)} fill="url(#sparkUp)" />
        <polyline points={points(down)} fill="none" stroke="var(--down)" strokeWidth="1.5" />
        <polyline points={points(up)} fill="none" stroke="var(--up)" strokeWidth="1.5" />
      </g>
    </svg>
  );
}

/* -------------------------------- toasts -------------------------------- */

export type ToastKind = 'info' | 'success' | 'error' | 'achievement';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  push: (kind: ToastKind, message: string) => void;
  error: (error: unknown) => void;
}

const ToastContext = createContext<ToastApi>({ push: () => {}, error: () => {} });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-4), { id, kind, message }]);
      const linger = kind === 'error' ? 8000 : kind === 'achievement' ? 6500 : 4000;
      window.setTimeout(() => remove(id), linger);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      error: (error: unknown) =>
        push('error', error instanceof Error ? error.message : String(error)),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            {toast.kind === 'achievement' ? (
              <IconTrophy size={16} style={{ color: 'var(--gold)', flex: 'none', marginTop: 1 }} />
            ) : toast.kind === 'error' ? (
              <IconAlert size={15} style={{ color: 'var(--danger)', flex: 'none', marginTop: 1 }} />
            ) : toast.kind === 'success' ? (
              <IconCheck size={15} style={{ color: 'var(--ok)', flex: 'none', marginTop: 1 }} />
            ) : (
              <IconInfo size={15} style={{ color: 'var(--accent)', flex: 'none', marginTop: 1 }} />
            )}
            <div style={{ flex: 1 }}>{toast.message}</div>
            <button className="close" onClick={() => remove(toast.id)} aria-label="Dismiss">
              <IconClose size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ----------------------------- context menu ----------------------------- */

export function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition({
      left: Math.min(x, window.innerWidth - rect.width - 8),
      top: Math.min(y, window.innerHeight - rect.height - 8),
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="menu" ref={ref} style={position} onClick={(event) => event.stopPropagation()}>
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon?: ReactNode;
  label: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={danger ? 'danger' : undefined}
      disabled={disabled}
      onClick={onClick}
      style={disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
    >
      <span style={{ display: 'grid', placeItems: 'center', width: 16, flex: 'none' }}>{icon}</span>
      <span>{label}</span>
    </button>
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
