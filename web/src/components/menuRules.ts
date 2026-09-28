/**
 * The context menu's decisions, apart from the component so the node runner
 * can reach them: where it goes, and what a right-click elsewhere does to it.
 */

/** The gap kept between a menu and the window's edges. */
const MARGIN = 8;

export interface MenuPlacement {
  left: number;
  top: number;
  maxHeight: number;
}

/**
 * Where a menu opened at `at` goes: moved in from any edge it would cross,
 * and no taller than the window, so what does not fit scrolls inside it.
 * `size` is the menu's layout size, `viewport` the window's inner size.
 *
 * The height cap is taken from the same measure as the clamp. The
 * stylesheet's 100vh is the viewport with a phone's URL bar hidden, and this
 * page never scrolls to hide it, so a menu capped at 100vh and pinned to the
 * top ended a URL bar's height below the screen, where scrolling the menu
 * cannot reach — and its last item, Remove + delete data, is on a phone the
 * only way to delete a torrent's data.
 */
export function placeMenu(
  at: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): MenuPlacement {
  const maxHeight = Math.max(0, viewport.height - 2 * MARGIN);
  const height = Math.min(size.height, maxHeight);
  return {
    left: Math.max(MARGIN, Math.min(at.x, viewport.width - size.width - MARGIN)),
    top: Math.max(MARGIN, Math.min(at.y, viewport.height - height - MARGIN)),
    maxHeight,
  };
}

/**
 * What an open menu does with a context-menu event anywhere on the page:
 *
 *   - `hold`: the event is inside the menu. That is the keyboard's menu key
 *     arriving after the keydown that opened it (it lands on the focused
 *     item), so the menu stays and the browser's is held back.
 *   - `ignore`: the event is outside, but a handler has already claimed it —
 *     a right-click on another row, which moves this menu there. Closing
 *     here undid that: the row was selected and no menu was left at all.
 *     It is also the very right-click that opened this menu, which reaches
 *     the window after the menu has mounted and started listening.
 *   - `close`: a right-click anywhere else, which means to leave.
 */
export type ContextMenuVerdict = 'hold' | 'ignore' | 'close';

export function contextMenuVerdict(inside: boolean, claimed: boolean): ContextMenuVerdict {
  if (inside) return 'hold';
  return claimed ? 'ignore' : 'close';
}
