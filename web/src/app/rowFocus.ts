// SPDX-License-Identifier: MIT

import type { SelectMods } from '../selection.ts';

/**
 * The focused row once the torrent menu opens on `hash`. Focusing a row shows
 * its details: on a wide screen in the pane under the list, which is what a
 * right-click there is expected to do. On a compact one the details are a
 * full-screen sheet, and a long-press meant only for the menu opened it over
 * the list — where it stayed after the menu closed. There the focus is left
 * as it was; the menu acts on the selection, which the press still sets.
 */
export function focusOnMenu(compact: boolean, focused: string | null, hash: string): string | null {
  return compact ? focused : hash;
}

/** Multi-selection on a phone must leave the list visible for the next tap. */
export function focusOnSelection(compact: boolean, focused: string | null, hash: string, mods: SelectMods): string | null {
  return compact && (mods.ctrl || mods.shift) ? focused : hash;
}
