import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useLatest } from '../hooks';
import { useReturnFocus } from './focus';
import { IconCheck } from './icons';
import { contextMenuVerdict, placeMenu, type MenuPlacement } from './menuRules';

/**
 * Keyboard behaviour for a menu: focus its first item on open, move with the
 * arrow keys, Home and End, and close on Escape or Tab — focus then goes back
 * to where it came from. Items are whatever carries a menuitem role.
 */
export function useMenuKeys(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
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
  const [position, setPosition] = useState<Partial<MenuPlacement>>({ left: x, top: y });
  useMenuKeys(ref, onClose);

  // Measured and clamped before the first paint: a menu opened near the
  // bottom or right edge used to flash half off-screen, then jump. The layout
  // size, not the bounding box: the opening animation starts scaled down, and
  // a box measured then left the last items below the edge.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setPosition(
      placeMenu(
        { x, y },
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [x, y]);

  useEffect(() => {
    const dismiss = () => close.current();
    const onContextMenu = (event: MouseEvent) => {
      const inside = ref.current?.contains(event.target as Node) ?? false;
      const verdict = contextMenuVerdict(inside, event.defaultPrevented);
      if (verdict === 'hold') event.preventDefault();
      else if (verdict === 'close') dismiss();
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

/**
 * Items under a heading. The heading names the group for assistive
 * technology too, where a bare line of text inside a menu is not allowed.
 */
export function MenuGroup({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id}>
      <div className="heading" id={id}>
        {heading}
      </div>
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
  checked,
}: {
  icon?: ReactNode;
  label: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Why the item is disabled, when it is. */
  title?: string;
  /** One of a set of choices: whether it is the current one. Unset for a plain action. */
  checked?: boolean;
}) {
  const choice = checked !== undefined;
  return (
    <button
      role={choice ? 'menuitemradio' : 'menuitem'}
      aria-checked={choice ? checked : undefined}
      className={danger ? 'danger' : undefined}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span className="menu-icon">{icon}</span>
      <span className="menu-label">{label}</span>
      {checked && <IconCheck size={13} className="menu-check" />}
    </button>
  );
}
