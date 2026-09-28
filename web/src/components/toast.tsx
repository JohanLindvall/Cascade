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
import { useLatest } from '../hooks';
import { redactSecrets } from '../redact';
import { IconAlert, IconCheck, IconClose, IconInfo, IconTrophy } from './icons';
import { toastsHeld } from './toastHold';

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

/** At most this many at once: a burst of failures must not bury the page. */
const MAX_TOASTS = 5;

/** How long each kind stays: an error long enough to be read, and copied. */
const LINGER: Record<ToastKind, number> = { error: 8000, achievement: 6500, success: 4000, info: 4000 };

const ICONS: Record<ToastKind, ReactNode> = {
  achievement: <IconTrophy size={16} className="toast-icon" />,
  error: <IconAlert size={15} className="toast-icon" />,
  success: <IconCheck size={15} className="toast-icon" />,
  info: <IconInfo size={15} className="toast-icon" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const stack = useRef<HTMLDivElement>(null);
  // Which kind of pointer last came over the stack: a tap leaves :hover set.
  const pointer = useRef<string | null>(null);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  // Asked at expiry rather than tracked, since removing the focused Dismiss
  // button fires no blur to end a hold with.
  const held = useCallback(() => {
    const element = stack.current;
    return (
      element !== null &&
      toastsHeld({
        hovered: element.matches(':hover'),
        pointer: pointer.current,
        focused: element.contains(document.activeElement),
      })
    );
  }, []);

  const api = useMemo<ToastApi>(() => {
    const push = (kind: ToastKind, message: string) => {
      const toast = { id: nextId.current++, kind, message: redactSecrets(message) };
      setToasts((current) => [...current.slice(-(MAX_TOASTS - 1)), toast]);
    };
    return { push, error: (error) => push('error', error instanceof Error ? error.message : String(error)) };
  }, []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* A live region, so a toast is read out rather than only shown; an
          error is an alert and interrupts, everything else waits its turn. */}
      <div
        className="toasts"
        aria-live="polite"
        ref={stack}
        onPointerOver={(event) => {
          pointer.current = event.pointerType;
        }}
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} held={held} onDismiss={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  held,
  onDismiss,
}: {
  toast: Toast;
  /** Whether the stack is being read, so its toasts must wait (see toastsHeld). */
  held: () => boolean;
  onDismiss: (id: number) => void;
}) {
  const dismiss = useLatest(onDismiss);
  useEffect(() => {
    let timer: number | undefined;
    const expire = () => {
      if (held()) timer = window.setTimeout(expire, 1000);
      else dismiss.current(toast.id);
    };
    timer = window.setTimeout(expire, LINGER[toast.kind]);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.kind, held, dismiss]);

  return (
    <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : undefined}>
      {ICONS[toast.kind]}
      <div className="toast-text">{toast.message}</div>
      <button className="close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
        <IconClose size={13} />
      </button>
    </div>
  );
}
