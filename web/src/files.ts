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
