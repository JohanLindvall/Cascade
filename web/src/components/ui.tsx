import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useLatest } from '../hooks';
import { IconAlert, IconCheck, IconClose, IconInfo, IconTrophy } from './icons';

/* ------------------------------ focus care ------------------------------ */

/**
 * Hand focus back to whatever had it when this component mounted — the
 * button that opened a dialog, the row a menu was opened on — once it
 * unmounts. Only if focus fell to <body> with it, though: a click elsewhere
 * that moved focus somewhere real (the search box) must not be undone.
 *
 * If that element is gone too (the confirmation deleted the very row whose
 * button opened it), focus goes to the dialog still open underneath, if any,
 * rather than to <body> behind it, where Tab would wander the page.
 */
function useReturnFocus(): void {
  // Captured on the first render, before any effect of ours moves focus.
  const [returnTo] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(
    () => () => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      if (returnTo?.isConnected && returnTo !== document.body) {
        returnTo.focus();
        return;
      }
      const open = document.querySelectorAll<HTMLElement>('[role="dialog"]');
      open[open.length - 1]?.focus();
    },
    [returnTo],
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab and Shift-Tab cycling inside `container` instead of wandering behind it. */
function trapTab(event: ReactKeyboardEvent, container: HTMLElement | null): void {
  if (event.key !== 'Tab' || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.getClientRects().length > 0,
  );
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === container)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/* ------------------------------- modal --------------------------------- */

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** A short dialog (a confirmation, one field): narrower, and a centred card
   *  rather than a full-screen sheet on phones. */
  small?: boolean;
}

/**
 * Open modals, innermost last. A confirmation can open over another dialog
 * (deleting a throttle group from its own dialog), and Escape must close only
 * the one on top — every modal listens on window, so without this one key
 * press closed them all.
 */
const modalStack: number[] = [];
let modalSeq = 0;

export function Modal({ title, onClose, children, footer, wide, small }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Callers pass inline closures; reading the latest through a ref keeps the
  // listener (and the dialog's place in the stack) fixed for its lifetime.
  const close = useLatest(onClose);
  useReturnFocus();

  useEffect(() => {
    const id = ++modalSeq;
    modalStack.push(id);
    // Move focus into the dialog so keyboard users are not left behind it —
    // unless a child already put it somewhere better (a confirm's button).
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || modalStack[modalStack.length - 1] !== id) return;
      event.preventDefault();
      close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      modalStack.splice(modalStack.indexOf(id), 1);
    };
  }, [close]);

  return (
    <div
      className={small ? 'overlay small' : 'overlay'}
      onMouseDown={(event) => event.target === event.currentTarget && close.current()}
    >
      <div
        className={`modal ${wide ? 'wide' : ''} ${small ? 'small' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={ref}
        tabIndex={-1}
        onKeyDown={(event) => trapTab(event, ref.current)}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="btn icon ghost" onClick={() => close.current()} aria-label="Close">
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

type InputAttributes = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange'>;

/**
 * A text input parsed on every keystroke. The text stays exactly as typed —
 * "-" on the way to "-1", "1." on the way to "1.5M" — where a controlled
 * number input snapped it back to a number; the parent hears the parsed value,
 * or null while the text is not a valid one. Seeded once from `initial`.
 */
export function ParsedInput({
  initial,
  parse,
  onValue,
  className = 'input',
  ...rest
}: InputAttributes & {
  initial: string;
  parse: (text: string) => number | null;
  onValue: (value: number | null) => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <input
      {...rest}
      className={className}
      value={text}
      aria-invalid={parse(text) === null || undefined}
      onChange={(event) => {
        setText(event.target.value);
        onValue(parse(event.target.value));
      }}
    />
  );
}

/** The controls a <label> can name. */
const LABELLABLE = new Set<unknown>(['input', 'select', 'textarea', ParsedInput]);

/**
 * A labelled form control with an optional hint or error beneath it. The
 * label is tied to the first control among the children — clicking it
 * focuses the field, and a screen reader announces it — and the hint or error
 * becomes the control's description.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** Shown instead of the hint, styled as an error, and marks the control invalid. */
  error?: ReactNode;
  children: ReactNode;
}) {
  const fallbackId = useId();
  const noteId = `${fallbackId}-note`;
  const note = error ?? hint;
  let controlId: string | undefined;
  const content = Children.map(children, (child) => {
    if (controlId || !isValidElement<Record<string, unknown>>(child) || !LABELLABLE.has(child.type)) {
      return child;
    }
    controlId = (child.props.id as string | undefined) ?? fallbackId;
    return cloneElement(child, {
      id: controlId,
      'aria-describedby': note ? noteId : undefined,
      ...(error ? { 'aria-invalid': true } : {}),
    });
  });
  return (
    <div className="field">
      <label htmlFor={controlId}>{label}</label>
      {content}
      {note && (
        <div id={noteId} className={error ? 'hint error' : 'hint'}>
          {note}
        </div>
      )}
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

export type BarVariant = 'default' | 'done' | 'error' | 'idle' | 'checking';

export function ProgressBar({
  value,
  variant = 'default',
  striped,
  live,
  label,
}: {
  value: number;
  variant?: BarVariant;
  striped?: boolean;
  /** Sweeps a highlight across the filled portion while data is moving. */
  live?: boolean;
  /** What the bar measures, for assistive technology ("Progress of <name>"). */
  label?: string;
}) {
  const percent = Math.min(100, Math.max(0, value * 100));
  const classes = ['bar'];
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

const TOAST_ICONS: Record<ToastKind, ReactNode> = {
  achievement: <IconTrophy size={16} className="toast-icon" />,
  error: <IconAlert size={15} className="toast-icon" />,
  success: <IconCheck size={15} className="toast-icon" />,
  info: <IconInfo size={15} className="toast-icon" />,
};

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
      {/* A live region, so a toast is read out rather than only shown;
          errors interrupt, everything else waits its turn. */}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
            {TOAST_ICONS[toast.kind]}
            <div className="toast-text">{toast.message}</div>
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

/**
 * Keyboard behaviour for a menu: focus its first item on open, move with the
 * arrow keys, Home and End, and close on Escape or Tab — focus then goes back
 * to where it came from. Items are whatever carries a menuitem role.
 */
export function useMenuKeys(ref: RefObject<HTMLElement>, onClose: () => void): void {
  const close = useLatest(onClose);
  useReturnFocus();
  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const items = () => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')];
    items()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      const list = items();
      if (list.length === 0) return;
      const index = list.indexOf(document.activeElement as HTMLElement);
      const move = (to: number) => {
        event.preventDefault();
        list[(to + list.length) % list.length].focus();
      };
      if (event.key === 'ArrowDown') move(index + 1);
      else if (event.key === 'ArrowUp') move(index < 0 ? list.length - 1 : index - 1);
      else if (event.key === 'Home') move(0);
      else if (event.key === 'End') move(list.length - 1);
      else if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        close.current();
      }
    };
    menu.addEventListener('keydown', onKey);
    return () => menu.removeEventListener('keydown', onKey);
  }, [ref, close]);
}

export function ContextMenu({
  x,
  y,
  label,
  onClose,
  children,
}: {
  x: number;
  y: number;
  /** What the menu acts on, for assistive technology. */
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useLatest(onClose);
  const [position, setPosition] = useState({ left: x, top: y });
  useMenuKeys(ref, onClose);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const dismiss = () => close.current();
    // A context-menu event inside the menu is the keyboard's menu key arriving
    // after the keydown that opened this one (it lands on the focused item):
    // keep this menu and hold back the browser's. Anywhere else, it is a
    // right-click that means to leave.
    const onContextMenu = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) event.preventDefault();
      else dismiss();
    };
    window.addEventListener('click', dismiss);
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('resize', dismiss);
    };
  }, [close]);

  return (
    <div
      className="menu"
      role="menu"
      aria-label={label}
      ref={ref}
      style={position}
      onClick={(event) => event.stopPropagation()}
    >
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
  title,
}: {
  icon?: ReactNode;
  label: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Why the item is disabled, when it is. */
  title?: string;
}) {
  return (
    <button
      role="menuitem"
      className={danger ? 'danger' : undefined}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span className="menu-icon">{icon}</span>
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
