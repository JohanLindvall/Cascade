// SPDX-License-Identifier: MIT

import { normalizePreferences, type Preferences } from './preferences.ts';

/** Orders writes and protects edits made while the initial server copy is loading. */
export class PreferenceSync {
  private pending: Partial<Preferences> = {};
  private sending: Partial<Preferences> = {};
  private running: Promise<void> | undefined;
  private loading: Promise<Preferences> | undefined;
  private loadingEdits: Partial<Preferences> | undefined;

  private readonly write: (patch: Partial<Preferences>) => Promise<unknown>;

  constructor(write: (patch: Partial<Preferences>) => Promise<unknown>) { this.write = write; }

  update(patch: Partial<Preferences>): void {
    this.pending = { ...this.pending, ...patch };
    if (this.loadingEdits) this.loadingEdits = { ...this.loadingEdits, ...patch };
  }

  load(read: () => Promise<unknown>): Promise<Preferences> {
    if (!this.loading) {
      this.loadingEdits = { ...this.sending, ...this.pending };
      this.loading = read().then((stored) => normalizePreferences({
        ...normalizePreferences(stored), ...this.loadingEdits,
      })).finally(() => { this.loading = undefined; this.loadingEdits = undefined; });
    }
    return this.loading;
  }

  async flush(): Promise<void> {
    // A write may finish just before another caller queues an edit. Keep
    // checking after awaiting it: sharing only its finalizer can otherwise
    // report success while that newer edit is still pending.
    while (this.running || Object.keys(this.pending).length > 0) {
      const running = this.running ??= this.drain();
      try {
        await running;
      } finally {
        if (this.running === running) this.running = undefined;
      }
    }
  }

  private async drain(): Promise<void> {
    while (Object.keys(this.pending).length > 0) {
      const patch = this.pending;
      this.pending = {};
      this.sending = patch;
      try {
        await this.write(patch);
      } catch (error) {
        // Newer edits win, and offline changes remain available for retry.
        this.pending = { ...patch, ...this.pending };
        throw error;
      } finally { this.sending = {}; }
    }
  }
}
