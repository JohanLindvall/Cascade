/**
 * Which torrents are selected, and which ones an action applies to.
 *
 * Pure, so the node test runner can pin the rules the list is operated by:
 * click, Ctrl/⌘-click and Shift-click ranges, arrow-key stepping, and — the
 * rule that matters most — that actions only ever reach rows the user can
 * see. A selection survives a filter or search change (narrowing the search
 * to find one more row must not drop the three already picked), but the rows
 * it hides are not acted on until they are visible again.
 */

/** Modifier keys that drive multi-select, decoupled from the DOM event type. */
export interface SelectMods {
  ctrl: boolean;
  shift: boolean;
}

export interface Selection {
  selected: ReadonlySet<string>;
  /** Where a Shift-click range starts: the last row clicked without Shift. */
  anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { selected: new Set(), anchor: null };

/** Select exactly one row, making it the anchor. */
export function selectOnly(hash: string): Selection {
  return { selected: new Set([hash]), anchor: hash };
}

/**
 * The selection after clicking `hash` in the list `order` (the visible rows,
 * top to bottom) — or after Shift+Arrow moves there. Shift selects the range
 * from the anchor, replacing the selection as a file manager does, so a
 * second Shift-click (or Shift+Up after Shift+Down) can shrink it again;
 * Ctrl/⌘+Shift adds the range instead. Ctrl/⌘ alone toggles one row, and a
 * plain click selects only that row.
 */
export function selectRow(current: Selection, order: readonly string[], hash: string, mods: SelectMods): Selection {
  if (mods.shift && current.anchor) {
    const from = order.indexOf(current.anchor);
    const to = order.indexOf(hash);
    if (from >= 0 && to >= 0) {
      const next = new Set(mods.ctrl ? current.selected : []);
      const [start, end] = from < to ? [from, to] : [to, from];
      for (let i = start; i <= end; i++) next.add(order[i]);
      // The anchor stays put, so the next Shift-click measures from it again.
      return { selected: next, anchor: current.anchor };
    }
  }
  if (mods.ctrl) {
    const next = new Set(current.selected);
    if (next.has(hash)) next.delete(hash);
    else next.add(hash);
    return { selected: next, anchor: hash };
  }
  return selectOnly(hash);
}

/**
 * The row an arrow key moves to from `focused`: one step down or up, clamped
 * to the list; from nowhere, Down starts at the top and Up at the bottom.
 */
export function stepRow(order: readonly string[], focused: string | null, delta: 1 | -1): string | null {
  if (order.length === 0) return null;
  const index = focused ? order.indexOf(focused) : -1;
  if (index < 0) return delta > 0 ? order[0] : order[order.length - 1];
  return order[Math.min(order.length - 1, Math.max(0, index + delta))];
}

/**
 * What the toolbar, the keyboard and the menu act on: the selected rows that
 * are visible, in list order — or, with none, the focused row if it is
 * visible. Hidden rows are never targets, so Delete cannot reach a torrent
 * the current filter is not showing.
 */
export function actionTargets(
  selected: ReadonlySet<string>,
  order: readonly string[],
  focused: string | null,
): string[] {
  const visible = order.filter((hash) => selected.has(hash));
  if (visible.length > 0) return visible;
  return focused && order.includes(focused) ? [focused] : [];
}

/**
 * How many selected rows the current filter hides — shown beside the count
 * so they are not a surprise later. A torrent that no longer exists at all
 * (`exists` says no) is not hidden, just gone, and does not count.
 */
export function hiddenSelected(
  selected: ReadonlySet<string>,
  order: readonly string[],
  exists: (hash: string) => boolean,
): number {
  if (selected.size === 0) return 0;
  const shown = new Set(order);
  let hidden = 0;
  for (const hash of selected) if (!shown.has(hash) && exists(hash)) hidden += 1;
  return hidden;
}
