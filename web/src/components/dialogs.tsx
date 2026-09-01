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
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Field, Modal } from './ui';

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** Things the action applies to, shown as a list (trimmed past a few). */
  items?: string[];
  confirmLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: ReactNode;
  label?: string;
  initial?: string;
  placeholder?: string;
  /** Offered as a datalist under the input. */
  suggestions?: string[];
  confirmLabel?: string;
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

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ kind: 'confirm', options, resolve })),
    [],
  );
  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => setPending({ kind: 'prompt', options, resolve })),
    [],
  );

  const settle = (value: boolean | string | null) => {
    if (!pending) return;
    setPending(null);
    if (pending.kind === 'confirm') pending.resolve(value === true);
    else pending.resolve(typeof value === 'string' ? value : null);
  };

  const api = useMemo<Dialogs>(() => ({ confirm, prompt, open: pending !== null }), [confirm, prompt, pending]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {pending?.kind === 'confirm' && (
        <ConfirmDialog options={pending.options} onSettle={(ok) => settle(ok)} />
      )}
      {pending?.kind === 'prompt' && (
        <PromptDialog options={pending.options} onSettle={(text) => settle(text)} />
      )}
    </DialogContext.Provider>
  );
}

function ItemList({ items }: { items: string[] }) {
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
      {options.items && options.items.length > 0 && <ItemList items={options.items} />}
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
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const listId = options.suggestions?.length ? 'cascade-prompt-suggestions' : undefined;
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
        onSubmit={(event) => {
          event.preventDefault();
          onSettle(value);
        }}
      >
        {options.message && <p className="confirm-message">{options.message}</p>}
        <Field label={options.label ?? options.title}>
          <input
            ref={input}
            className="input"
            list={listId}
            placeholder={options.placeholder}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {listId && (
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
