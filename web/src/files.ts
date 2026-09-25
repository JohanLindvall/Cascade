/**
 * What counts as a .torrent when files arrive by drop or by the file picker.
 * Both paths accept the same thing and say the same thing about the rest.
 */

export function isTorrentFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.torrent') || file.type === 'application/x-bittorrent';
}

/** Split a batch into the torrents and a note about what was left out, if anything. */
export function acceptTorrents(files: Iterable<File>): { accepted: File[]; ignored: string | null } {
  const all = [...files];
  const accepted = all.filter(isTorrentFile);
  const dropped = all.length - accepted.length;
  return {
    accepted,
    ignored: dropped > 0 ? `${dropped} file${dropped === 1 ? '' : 's'} ignored — only .torrent files are accepted` : null,
  };
}

/** The minimum of DataTransfer that droppedFiles reads; kept structural so the
 *  node test runner (which has no DataTransfer) can exercise the merge. */
export interface DropSource {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; getAsFile: () => File | null }> | null;
  getData?: (format: string) => string;
}

/**
 * The files a drop carries. Reads `dataTransfer.files`, and also any file-kind
 * entries in `dataTransfer.items` — some Linux file managers (and Firefox with
 * certain drag sources) expose the dropped file only through the items list and
 * leave `.files` empty, which otherwise makes a real .torrent fall through to
 * the "your file manager passed a path" branch and be turned away even though
 * the drop overlay accepted it (carriesPayload already trusts items). Must be
 * called synchronously inside the drop event — `getAsFile()` is only valid
 * there. Deduplicated by name/size/mtime, since the two sources can report the
 * same file twice.
 */
export function droppedFiles(transfer: DropSource | null): File[] {
  if (!transfer) return [];
  const key = (file: File) => `${file.name} ${file.size} ${file.lastModified}`;
  const seen = new Set<string>();
  const out: File[] = [];
  const add = (file: File | null) => {
    if (!file || seen.has(key(file))) return;
    seen.add(key(file));
    out.push(file);
  };
  for (const file of Array.from(transfer.files ?? [])) add(file);
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind === 'file') add(item.getAsFile());
  }
  return out;
}

/** The text a drop carries: its link list if it has one, else its plain text. */
export function dropText(transfer: DropSource | null): string {
  const read = (format: string) => transfer?.getData?.(format) ?? '';
  return (read('text/uri-list') || read('text/plain')).trim();
}

export interface DroppedLinks {
  /** Magnet and http(s) links, one per whitespace-separated word. */
  links: string[];
  /** Why there is nothing to add, when there is not. */
  problem: { level: 'error' | 'info'; text: string } | null;
}

/**
 * The links in a drop that carried no file — which is how a magnet arrives
 * when dragged out of a browser tab — or what to tell the user instead. A
 * drop that quietly does nothing looks exactly like a broken torrent, so
 * every empty outcome has words.
 */
export function linksFromDrop(text: string): DroppedLinks {
  // text/uri-list comment lines start with "#", so the scheme test drops them too.
  const links = text.split(/\s+/).filter((word) => /^(magnet:|https?:\/\/)/i.test(word));
  if (links.length > 0) return { links, problem: null };
  if (/^file:/i.test(text)) {
    return {
      links,
      problem: {
        level: 'error',
        text: 'Your file manager passed the path rather than the file itself, which the browser is not allowed to read. Pick the file in the Add dialog’s file browser, or drag it from a different file manager.',
      },
    };
  }
  return {
    links,
    problem: {
      level: 'info',
      text: text
        ? 'Nothing to add — drop .torrent files, magnet links or URLs.'
        : 'That drop carried no file or link the browser could read — pick the file in the Add dialog’s file browser instead.',
    },
  };
}
