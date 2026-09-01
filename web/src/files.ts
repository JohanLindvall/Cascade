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
