/** Fields that take typing, and dropped text, for themselves. A checkbox does not. */
const TEXT_ENTRY =
  'textarea, select, [contenteditable]:not([contenteditable="false"]), ' +
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])';

/** Whether an event happened in a field that keeps its own keys and drops. */
export function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TEXT_ENTRY) !== null;
}

/**
 * Whether a drag carries files. Some sources populate `items` without
 * advertising the "Files" type, so both are asked.
 */
export function carriesFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  return Array.from(transfer.types ?? []).includes('Files') ||
    Array.from(transfer.items ?? []).some((item) => item.kind === 'file');
}

/**
 * Whether a drag carries something the app can add: files, or a link — which
 * is how a magnet arrives when dragged out of another tab. Plain text
 * selections are left out on purpose: they would light the drop overlay for
 * drags that can never add anything.
 */
export function carriesPayload(transfer: DataTransfer | null): boolean {
  return carriesFiles(transfer) || Array.from(transfer?.types ?? []).includes('text/uri-list');
}

/** Clipboard write, with a fallback for plain-http origins, where the Clipboard API is absent. */
export function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand('copy')) return Promise.reject(new Error('copy rejected'));
  } catch (error) {
    return Promise.reject(error);
  } finally {
    area.remove();
  }
  return Promise.resolve();
}

/** The row element of a torrent, in the table or the card list. */
export function rowOf(hash: string): Element | null {
  return document.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
}
