/**
 * Small JSON-backed store for state rtorrent itself does not keep:
 * when a torrent was added to this UI, and the throttle groups we created
 * (rtorrent forgets throttle groups on restart, so we re-create them).
 */
import fs from 'node:fs';
import path from 'node:path';
import { EMPTY_STATS, type GameStats } from './achievements';

export interface ThrottleGroup {
  name: string;
  /** Bytes per second; 0 means unlimited. */
  up: number;
  down: number;
}

/** Last-seen totals per torrent, used to accumulate lifetime counters. */
interface SeenTorrent {
  up: number;
  down: number;
  complete: boolean;
}

interface StoreData {
  addedAt: Record<string, number>;
  throttles: ThrottleGroup[];
  stats: GameStats;
  seen: Record<string, SeenTorrent>;
  achievements: Record<string, number>;
  /** Hashes already counted as completed, kept so a re-add is not counted twice. */
  everCompleted: string[];
}

export class Store {
  private data: StoreData = {
    addedAt: {},
    throttles: [],
    stats: { ...EMPTY_STATS },
    seen: {},
    achievements: {},
    everCompleted: [],
  };
  private completedSet = new Set<string>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      this.data = {
        addedAt: parsed.addedAt ?? {},
        throttles: parsed.throttles ?? [],
        stats: { ...EMPTY_STATS, ...(parsed.stats ?? {}) },
        seen: parsed.seen ?? {},
        achievements: parsed.achievements ?? {},
        everCompleted: parsed.everCompleted ?? [],
      };
    } catch {
      // First run, or an unreadable/corrupt file: start clean.
      this.data = {
        addedAt: {},
        throttles: [],
        stats: { ...EMPTY_STATS },
        seen: {},
        achievements: {},
        everCompleted: [],
      };
    }
    this.completedSet = new Set(this.data.everCompleted);
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 2000);
    this.timer.unref?.();
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.warn(`[cascade] could not persist state to ${this.file}:`, (error as Error).message);
    }
  }

  /** Returns the recorded add time, recording "now" the first time a hash is seen. */
  addedAt(hash: string, seenAt = Math.floor(Date.now() / 1000)): number {
    const existing = this.data.addedAt[hash];
    if (existing) return existing;
    this.data.addedAt[hash] = seenAt;
    this.scheduleFlush();
    return seenAt;
  }

  forget(hash: string): void {
    if (this.data.addedAt[hash] === undefined && this.data.seen[hash] === undefined) return;
    delete this.data.addedAt[hash];
    delete this.data.seen[hash];
    this.scheduleFlush();
  }

  /** Drop bookkeeping for torrents that no longer exist. */
  prune(liveHashes: Set<string>): void {
    let changed = false;
    for (const hash of Object.keys(this.data.addedAt)) {
      if (!liveHashes.has(hash)) {
        delete this.data.addedAt[hash];
        changed = true;
      }
    }
    for (const hash of Object.keys(this.data.seen)) {
      if (!liveHashes.has(hash)) {
        delete this.data.seen[hash];
        changed = true;
      }
    }
    if (changed) this.scheduleFlush();
  }

  /* ------------------------------ game state ----------------------------- */

  get stats(): GameStats {
    return this.data.stats;
  }

  get unlockedAchievements(): Record<string, number> {
    return this.data.achievements;
  }

  unlock(id: string, at = Math.floor(Date.now() / 1000)): void {
    if (this.data.achievements[id] !== undefined) return;
    this.data.achievements[id] = at;
    this.scheduleFlush();
  }

  /**
   * Fold the current torrent list into the lifetime counters.
   *
   * Totals are accumulated as deltas against the last seen value so that
   * removing a torrent does not erase the traffic it already contributed. A
   * torrent seen for the first time contributes its whole total, which credits
   * an rtorrent session that predates this UI.
   */
  recordTorrents(
    torrents: Array<{
      hash: string;
      upTotal: number;
      downTotal: number;
      progress: number;
      ratio: number;
      status: string;
      peersConnected: number;
      label: string;
      finishedAt: number;
    }>,
  ): void {
    const stats = this.data.stats;
    let seeding = 0;
    let peers = 0;
    const labels = new Set<string>();
    const now = Math.floor(Date.now() / 1000);

    for (const torrent of torrents) {
      const previous = this.data.seen[torrent.hash];
      const complete = torrent.progress >= 1;

      if (previous) {
        if (torrent.upTotal > previous.up) stats.lifetimeUp += torrent.upTotal - previous.up;
        if (torrent.downTotal > previous.down) {
          stats.lifetimeDown += torrent.downTotal - previous.down;
        }
        if (complete && !previous.complete) this.countCompletion(torrent.hash);
      } else {
        stats.everAdded += 1;
        stats.lifetimeUp += torrent.upTotal;
        stats.lifetimeDown += torrent.downTotal;
        if (complete) this.countCompletion(torrent.hash);
      }

      this.data.seen[torrent.hash] = {
        up: torrent.upTotal,
        down: torrent.downTotal,
        complete,
      };

      if (torrent.ratio > stats.bestRatio) stats.bestRatio = torrent.ratio;
      if (torrent.status === 'seeding') seeding += 1;
      peers += torrent.peersConnected;
      if (torrent.label) labels.add(torrent.label);
      if (torrent.finishedAt > 0 && complete) {
        const seeded = now - torrent.finishedAt;
        if (seeded > stats.longestSeed) stats.longestSeed = seeded;
      }
    }

    if (seeding > stats.maxSeeding) stats.maxSeeding = seeding;
    if (peers > stats.peakPeers) stats.peakPeers = peers;
    if (labels.size > stats.maxLabels) stats.maxLabels = labels.size;
    this.scheduleFlush();
  }

  /** Count a finished torrent once, even if it is later removed and re-added. */
  private countCompletion(hash: string): void {
    if (this.completedSet.has(hash)) return;
    this.completedSet.add(hash);
    this.data.everCompleted.push(hash);
    this.data.stats.completed += 1;
  }

  recordRates(down: number, up: number): void {
    const stats = this.data.stats;
    let changed = false;
    if (down > stats.peakDownRate) {
      stats.peakDownRate = down;
      changed = true;
    }
    if (up > stats.peakUpRate) {
      stats.peakUpRate = up;
      changed = true;
    }
    if (changed) this.scheduleFlush();
  }

  throttles(): ThrottleGroup[] {
    return this.data.throttles.map((group) => ({ ...group }));
  }

  upsertThrottle(group: ThrottleGroup): void {
    const index = this.data.throttles.findIndex((item) => item.name === group.name);
    if (index >= 0) this.data.throttles[index] = group;
    else this.data.throttles.push(group);
    this.scheduleFlush();
  }

  removeThrottle(name: string): void {
    this.data.throttles = this.data.throttles.filter((item) => item.name !== name);
    this.scheduleFlush();
  }
}
