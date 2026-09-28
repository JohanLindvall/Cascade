import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

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
export function useReturnFocus(): void {
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
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]):not(:disabled)';

/** Keep Tab and Shift-Tab cycling inside `container` instead of wandering behind it. */
export function trapTab(event: ReactKeyboardEvent, container: HTMLElement | null): void {
  if (event.key !== 'Tab' || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
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
