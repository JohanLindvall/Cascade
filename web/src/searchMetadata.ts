// SPDX-License-Identifier: MIT

import { redactSecrets, redactUrl } from './redact.ts';
import type { Torrent, TorrentFile, Tracker } from './types';

type SearchTorrent = Pick<Torrent, 'hash' | 'name' | 'directory' | 'basePath' | 'isMeta' | 'trackerCount' | 'addedAt'>;

interface Source {
  files(hash: string): Promise<Pick<TorrentFile, 'path' | 'onDisk'>[]>;
  trackers(hash: string): Promise<Pick<Tracker, 'url' | 'trackerId'>[]>;
}

interface Entry {
  key: string;
  files?: string;
  trackers?: string;
  trackersAt: number;
  trackersFailed: boolean;
  attempted: boolean;
  text: string;
  error?: string;
}

export interface SearchMetadataState {
  /** Lowercase text, prepared once rather than for every streamed update. */
  text: Record<string, string>;
  pending: number;
  failed: number;
  error?: string;
}

/** Rates and progress must not restart a search; paths and arriving magnet metadata must. */
export function searchMetadataKey(torrent: SearchTorrent): string {
  return JSON.stringify([
    torrent.hash, torrent.name, torrent.directory, torrent.basePath,
    torrent.isMeta, torrent.trackerCount, torrent.addedAt,
  ]);
}

/**
 * File names are stable until a torrent's paths or metadata change. Trackers
 * can also be edited outside Cascade without changing their count, so those
 * are refreshed once a minute while searching. Nothing reads this cache's
 * source until load is called, and overlapping loads share one queue.
 */
export class SearchMetadata {
  private readonly entries = new Map<string, Entry>();
  private readonly source: Source;
  private readonly now: () => number;
  private running: Promise<void> | undefined;

  constructor(source: Source, now: () => number = Date.now) {
    this.source = source;
    this.now = now;
  }

  sync(torrents: readonly SearchTorrent[]): void {
    const live = new Set(torrents.map((torrent) => torrent.hash));
    for (const hash of this.entries.keys()) {
      if (!live.has(hash)) this.entries.delete(hash);
    }
    for (const torrent of torrents) {
      const key = searchMetadataKey(torrent);
      if (this.entries.get(torrent.hash)?.key !== key) {
        this.entries.set(torrent.hash, {
          key, trackersAt: 0, trackersFailed: false, attempted: false, text: '',
        });
      }
    }
  }

  snapshot(torrents: readonly SearchTorrent[]): SearchMetadataState {
    const state: SearchMetadataState = { text: {}, pending: 0, failed: 0 };
    for (const torrent of torrents) {
      const entry = this.entries.get(torrent.hash);
      if (!entry || entry.key !== searchMetadataKey(torrent) || !entry.attempted) {
        state.pending++;
        continue;
      }
      state.text[torrent.hash] = entry.text;
      if (entry.files === undefined || entry.trackersFailed) {
        state.failed++;
        state.error ??= entry.error;
      }
    }
    return state;
  }

  async load(isCurrent: () => boolean, changed: () => void): Promise<void> {
    // A new list or a cleared/re-entered search may arrive during a read.
    // Wait for that read instead of starting another request queue beside it.
    while (this.running) await this.running;
    if (!isCurrent()) return;
    const running = this.drain(isCurrent, changed);
    this.running = running;
    try { await running; }
    finally { if (this.running === running) this.running = undefined; }
  }

  private async drain(isCurrent: () => boolean, changed: () => void): Promise<void> {
    for (const [hash, entry] of this.entries) {
      if (!isCurrent()) return;
      const refreshTrackers = entry.trackers === undefined || entry.trackersFailed ||
        this.now() - entry.trackersAt >= 60_000;
      if (entry.files !== undefined && !refreshTrackers) continue;
      // At most one torrent at a time, with two independent reads. An error
      // in one source must not discard searchable names from the other.
      const [files, trackers] = await Promise.allSettled([
        entry.files === undefined
          ? this.source.files(hash).then((rows) => rows.flatMap((file) => [file.path, file.onDisk]).join('\n').toLowerCase())
          : Promise.resolve(entry.files),
        refreshTrackers
          ? this.source.trackers(hash).then((rows) => rows.flatMap((tracker) => [
            redactUrl(tracker.url), redactSecrets(tracker.trackerId),
          ]).join('\n').toLowerCase())
          : Promise.resolve(entry.trackers ?? ''),
      ]);
      // An erased torrent or a changed directory must never get old names
      // back from a response that was already in flight.
      if (this.entries.get(hash) !== entry) continue;
      if (files.status === 'fulfilled') entry.files = files.value;
      entry.trackersFailed = trackers.status === 'rejected';
      if (trackers.status === 'fulfilled') {
        entry.trackers = trackers.value;
        if (refreshTrackers) entry.trackersAt = this.now();
      }
      entry.attempted = true;
      entry.text = [entry.files ?? '', entry.trackers ?? ''].join('\n');
      const failure = files.status === 'rejected' ? files : trackers.status === 'rejected' ? trackers : undefined;
      entry.error = failure
        ? redactSecrets(failure.reason instanceof Error ? failure.reason.message : String(failure.reason))
        : undefined;
      if (isCurrent()) changed();
    }
  }
}
