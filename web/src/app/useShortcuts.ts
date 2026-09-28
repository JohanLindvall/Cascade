import { useEffect } from 'react';
import { useLatest } from '../hooks';
import { isTextEntry } from './dom';

/** What the keyboard can do, and the state that decides whether it may. */
export interface ShortcutTargets {
  /** Anything modal is open: the keyboard is its. */
  modalOpen: boolean;
  drawerOpen: boolean;
  menuOpen: boolean;
  closeDrawer: () => void;
  closeMenu: () => void;
  clearSelection: () => void;
  remove: (deleteData: boolean) => void;
  /** Focus a row: the next or previous, or the first or last; with extend, select the range to it. */
  move: (to: 'next' | 'previous' | 'first' | 'last', extend: boolean) => boolean;
  /** Open the torrent menu on the focused row; false when there is none. */
  openMenu: () => boolean;
  focusSearch: () => void;
  selectAll: () => void;
  add: () => void;
}

const MOVES: Record<string, 'next' | 'previous' | 'first' | 'last'> = {
  ArrowDown: 'next',
  ArrowUp: 'previous',
  Home: 'first',
  End: 'last',
};

/**
 * The app's global shortcuts. The listener is attached once and reads the
 * latest targets through a ref, rather than being re-attached on every state
 * update with a fresh closure over the list.
 */
export function useShortcuts(targets: ShortcutTargets): void {
  const latest = useLatest(targets);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const t = latest.current;
      // A key a component handled is claimed (the menus, the detail tabs, the
      // resize handle all prevent the default), and a text field keeps its own.
      if (event.defaultPrevented || isTextEntry(event.target)) return;
      // With anything modal open the keyboard is its: Escape closes it (the
      // modal listens for itself) and must not also clear the selection
      // behind it, and Delete must not stack a second confirmation.
      if (t.modalOpen) return;
      if (t.drawerOpen && event.key !== 'Escape') return;
      if (t.menuOpen || (event.target instanceof Element && event.target.closest('[role="menu"]'))) {
        if (event.key === 'Escape') t.closeMenu();
        return;
      }
      const command = event.ctrlKey || event.metaKey;
      switch (event.key) {
        case 'Escape':
          // One layer at a time: the drawer first, then the selection.
          if (t.drawerOpen) t.closeDrawer();
          else t.clearSelection();
          break;
        case 'Delete':
          t.remove(event.shiftKey);
          break;
        case 'Backspace':
          // ⌘⌫, the Mac spelling of Delete: a laptop keyboard has no Delete key.
          if (command) t.remove(event.shiftKey);
          break;
        case 'ArrowDown':
        case 'ArrowUp':
        case 'Home':
        case 'End':
          if (t.move(MOVES[event.key], event.shiftKey)) event.preventDefault();
          break;
        case 'ContextMenu':
        case 'F10':
          if (event.key === 'F10' && !event.shiftKey) break;
          if (t.openMenu()) event.preventDefault();
          break;
        case '/':
          event.preventDefault();
          t.focusSearch();
          break;
        case 'a':
        case 'A':
          if (!command) break;
          event.preventDefault();
          t.selectAll();
          break;
        case 'n':
        case 'N':
          if (!command && !event.altKey) t.add();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [latest]);
}
