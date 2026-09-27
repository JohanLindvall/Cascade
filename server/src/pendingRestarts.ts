/**
 * Torrents to start again once their hash check finishes.
 *
 * "Recheck & restart" exists for rtorrent's own dead end: "Download
 * registered as completed, but hash check returned unfinished chunks" stops
 * the torrent, and a plain recheck leaves it stopped when the check ends —
 * so fixing it by hand is two actions timed around a progress bar. The
 * check itself can run for however long the disk takes, far past any HTTP
 * request, so the action only *registers* the wish here and the poll tick
 * feeds readings in until one of them says start.
 *
 * The decision is pure so it can be tested: feed it d.hashing readings and
 * it answers wait, start or drop. A reading above zero proves the check is
 * running (rtorrent marks even a queued check); the first zero after that
 * means it finished. A check so fast every poll missed it entirely is
 * covered by the zero-reading floor — after a few polls of nothing, the
 * only explanation left is that it already ran.
 */
export class PendingRestarts {
  private readonly entries = new Map<
    string,
    { sawHashing: boolean; zeroReads: number; since: number }
  >();

  /** How long a pending restart may wait: a full rehash of a huge torrent
   *  on a slow disk is hours, so the ceiling is generous. */
  static readonly MAX_AGE_MS = 24 * 60 * 60 * 1000;
  /** Zero readings that mean "the check came and went between polls". */
  static readonly ZERO_READS_FLOOR = 3;

  add(hash: string, now = Date.now()): void {
    this.entries.set(hash, { sawHashing: false, zeroReads: 0, since: now });
  }

  cancel(hash: string): void {
    this.entries.delete(hash);
  }

  has(hash: string): boolean {
    return this.entries.has(hash);
  }

  get size(): number {
    return this.entries.size;
  }

  hashes(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Fold one d.hashing reading in. null means the torrent could not be
   * asked (erased, or the call faulted): nothing left to restart.
   */
  step(hash: string, hashing: number | null, now = Date.now()): 'wait' | 'start' | 'drop' {
    const entry = this.entries.get(hash);
    if (!entry) return 'drop';
    if (hashing === null || now - entry.since > PendingRestarts.MAX_AGE_MS) {
      this.entries.delete(hash);
      return 'drop';
    }
    if (hashing > 0) {
      entry.sawHashing = true;
      entry.zeroReads = 0;
      return 'wait';
    }
    entry.zeroReads += 1;
    if (entry.sawHashing || entry.zeroReads >= PendingRestarts.ZERO_READS_FLOOR) {
      this.entries.delete(hash);
      return 'start';
    }
    return 'wait';
  }
}
