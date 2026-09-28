import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useLatest } from '../hooks';
import { trapTab, useReturnFocus } from './focus';
import { IconClose } from './icons';

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
        className={['modal', wide && 'wide', small && 'small'].filter(Boolean).join(' ')}
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
