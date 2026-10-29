// SPDX-License-Identifier: MIT

import type { SearchResult } from '../contracts.ts';
import { redactSecrets, redactUrl } from '../redact.ts';
import type { Session } from './session.ts';

/** The demo's server-side search; never imported by the production app. */
export function search(session: Session, query: string): SearchResult {
  const words = query.toLowerCase().replaceAll('ς', 'σ').match(/[\p{L}\p{Nd}]+/gu) ?? [];
  const hashes = session.list().filter((torrent) => {
    if (words.length === 0) return true;
    const text = [
      torrent.name, torrent.hash, torrent.label, torrent.directory, torrent.basePath,
      torrent.status, torrent.throttle, redactSecrets(torrent.message), session.trackerHost(torrent.hash),
      ...session.files(torrent.hash).flatMap((file) => [file.path, file.onDisk]),
      ...session.trackers(torrent.hash).flatMap((tracker) => [redactUrl(tracker.url), redactSecrets(tracker.trackerId)]),
    ].join('\n').toLowerCase().replaceAll('ς', 'σ');
    return words.every((word) => text.includes(word));
  }).map((torrent) => torrent.hash);
  return { hashes, pending: 0, failed: 0 };
}
