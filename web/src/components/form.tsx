// SPDX-License-Identifier: MIT

import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

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
  onValue?: (value: number | null) => void;
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
        onValue?.(parse(event.target.value));
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
