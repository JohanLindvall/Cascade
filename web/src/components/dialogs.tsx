/**
 * In-app confirm and prompt dialogs, promise-shaped like the window.* ones
 * they replace: `await confirm(...)` answers true/false, `await prompt(...)`
 * answers the text or null. Unlike the native ones they follow the theme,
 * list what is about to happen, offer existing labels, and do not block the
 * poll. One is open at a time; Escape and the overlay cancel.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Field, Modal } from './ui';

interface DialogOptions {
  title: string;
  message?: ReactNode;
  /** Things the action applies to, shown as a list (trimmed past a few). */
  items?: string[];
  confirmLabel?: string;
}

export interface ConfirmOptions extends DialogOptions {
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

export interface PromptOptions extends DialogOptions {
  label?: string;
  initial?: string;
  placeholder?: string;
  /** Offered as a datalist under the input. */
  suggestions?: string[];
}

export interface Dialogs {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  /** Whether one is showing, so global shortcuts can stand down. */
  open: boolean;
}

type Pending =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

const DialogContext = createContext<Dialogs>({
  confirm: () => Promise.resolve(false),
  prompt: () => Promise.resolve(null),
  open: false,
});

export function useDialogs(): Dialogs {
  return useContext(DialogContext);
}

const MAX_LISTED = 5;

/** Answer a pending request as cancelled. */
function cancel(pending: Pending): void {
  if (pending.kind === 'confirm') pending.resolve(false);
  else pending.resolve(null);
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // The request on screen, readable from the stable open functions below.
  const current = useRef<Pending | null>(null);

  const show = useCallback((next: Pending | null) => {
    // A request that arrives while another is showing replaces it, and the
    // replaced one is answered as cancelled — left unanswered, whatever was
    // awaiting it would wait forever.
    if (current.current && current.current !== next) cancel(current.current);
    current.current = next;
    setPending(next);
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => show({ kind: 'confirm', options, resolve })),
    [show],
  );
  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => show({ kind: 'prompt', options, resolve })),
    [show],
  );

  const settle = (answer: boolean | string | null) => {
    const request = current.current;
    if (!request) return;
    current.current = null;
    setPending(null);
    if (request.kind === 'confirm') request.resolve(answer === true);
    else request.resolve(typeof answer === 'string' ? answer : null);
  };

  const api = useMemo<Dialogs>(() => ({ confirm, prompt, open: pending !== null }), [confirm, prompt, pending]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {pending?.kind === 'confirm' && <ConfirmDialog options={pending.options} onSettle={settle} />}
      {pending?.kind === 'prompt' && <PromptDialog options={pending.options} onSettle={settle} />}
    </DialogContext.Provider>
  );
}

function ItemList({ items }: { items?: string[] }) {
  if (!items?.length) return null;
  const shown = items.slice(0, MAX_LISTED);
  const more = items.length - shown.length;
  return (
    <ul className="confirm-list">
      {shown.map((item, index) => (
        <li key={index} title={item}>
          {item}
        </li>
      ))}
      {more > 0 && <li className="confirm-more">…and {more} more</li>}
    </ul>
  );
}

function ConfirmDialog({
  options,
  onSettle,
}: {
  options: ConfirmOptions;
  onSettle: (ok: boolean) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  // Focus the answer so Enter confirms; the Modal's own focus would land on
  // the container and swallow the first keypress.
  useEffect(() => button.current?.focus(), []);
  return (
    <Modal
      title={options.title}
      small
      onClose={() => onSettle(false)}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={() => onSettle(false)}>
            Cancel
          </button>
          <button
            ref={button}
            className={options.danger ? 'btn danger' : 'btn primary'}
            onClick={() => onSettle(true)}
          >
            {options.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      {options.message && <p className="confirm-message">{options.message}</p>}
      <ItemList items={options.items} />
    </Modal>
  );
}

function PromptDialog({
  options,
  onSettle,
}: {
  options: PromptOptions;
  onSettle: (text: string | null) => void;
}) {
  const [value, setValue] = useState(options.initial ?? '');
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const suggest = !!options.suggestions?.length;
  return (
    <Modal
      title={options.title}
      small
      onClose={() => onSettle(null)}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={() => onSettle(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSettle(value)}>
            {options.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <form
        className="prompt-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSettle(value);
        }}
      >
        {options.message && <p className="confirm-message">{options.message}</p>}
        <ItemList items={options.items} />
        <Field label={options.label ?? options.title}>
          <input
            ref={input}
            className="input"
            list={suggest ? listId : undefined}
            placeholder={options.placeholder}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {suggest && (
            <datalist id={listId}>
              {options.suggestions?.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          )}
        </Field>
      </form>
    </Modal>
  );
}
