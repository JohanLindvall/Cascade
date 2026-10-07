// SPDX-License-Identifier: MIT

import { useState, type ReactNode } from 'react';
import { TORRENT_PRIORITIES, bytes, duration, percent, priorityLabel, rate, timestamp } from '../../format';
import { redactSecrets } from '../../redact';
import type { Torrent } from '../../types';
import { IconRefresh } from '../icons';
import { KvGrid } from '../ui';
import { yesNo } from './parts';

/** Everything the listing already knows about a torrent; nothing here is fetched. */
export function GeneralTab({
  torrent,
  onRecheckRestart,
}: {
  torrent: Torrent;
  onRecheckRestart: (hashes: string[]) => Promise<void>;
}) {
  const [fixing, setFixing] = useState(false);
  // rtorrent's message can quote a tracker URL, passkey and all.
  const message = redactSecrets(torrent.message);

  const recheckRestart = async () => {
    setFixing(true);
    try {
      await onRecheckRestart([torrent.hash]);
    } finally {
      setFixing(false);
    }
  };

  const rows: Array<[string, ReactNode]> = [
    ['Status', torrent.status],
    ['Size', bytes(torrent.size)],
    ['Completed', `${bytes(torrent.completed)} (${percent(torrent.progress)})`],
    ['Remaining', bytes(torrent.left)],
    ['Downloaded', bytes(torrent.downTotal)],
    ['Uploaded', bytes(torrent.upTotal)],
    ['Ratio', torrent.ratio.toFixed(3)],
    ['Down rate', rate(torrent.downRate)],
    ['Up rate', rate(torrent.upRate)],
    ['ETA', torrent.progress >= 1 ? '—' : duration(torrent.eta)],
    ['Peers', `${torrent.peersConnected} connected / ${torrent.peersNotConnected} known`],
    ['Seeds', String(torrent.peersComplete)],
    ['Trackers', String(torrent.trackerCount)],
    ['Priority', priorityLabel(TORRENT_PRIORITIES, torrent.priority)],
    ['Label', torrent.label || '—'],
    ['Throttle group', torrent.throttle || 'global'],
    ['Chunks', `${torrent.chunksDone} / ${torrent.chunksTotal} × ${bytes(torrent.chunkSize)}`],
    ['Private', yesNo(torrent.isPrivate)],
    ['Multi-file', yesNo(torrent.isMultiFile)],
    ['Directory', torrent.directory || '—'],
    ['Base path', torrent.basePath || '—'],
    ['Hash', torrent.hash],
    ['Added', timestamp(torrent.addedAt)],
    ['Started', timestamp(torrent.startedAt)],
    ['Finished', timestamp(torrent.finishedAt)],
    ['Created', timestamp(torrent.createdAt)],
  ];
  return (
    <>
      {message && (
        <div className="banner">
          <span className="grow">{message}</span>
          {torrent.status === 'error' && (
            <button
              className="btn sm ghost"
              disabled={fixing}
              onClick={() => void recheckRestart()}
              title="Recheck the data and start again once the check completes"
            >
              <IconRefresh size={13} />
              <span>Recheck &amp; restart</span>
            </button>
          )}
        </div>
      )}
      <KvGrid rows={rows} />
    </>
  );
}
