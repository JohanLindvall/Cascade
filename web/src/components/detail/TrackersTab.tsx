// SPDX-License-Identifier: MIT

import { Fragment, memo, useState } from 'react';
import { api } from '../../api';
import { duration, relative, until } from '../../format';
import { redactUrl } from '../../redact';
import type { Tracker } from '../../types';
import { useClock } from '../clock';
import { IconPlus } from '../icons';
import { useToast } from '../toast';
import { Flags, MiniKv, NoteRow, RowToggle, useExpanded, yesNo, type Flag } from './parts';

const COLUMNS = 10;

/** libtorrent's Tracker::Type / Tracker::Event enumerations. */
const TRACKER_TYPES: Record<number, string> = { 1: 'HTTP', 2: 'UDP', 3: 'DHT' };
const TRACKER_EVENTS: Record<number, string> = {
  0: 'none',
  1: 'completed',
  2: 'started',
  3: 'stopped',
  4: 'scrape',
};

/** A tracker URL rtorrent can announce to (d.tracker.insert takes anything). */
const TRACKER_URL = /^(https?|udp):\/\/\S+$/i;

function trackerFlags(tracker: Tracker): Flag[] {
  const flags: Flag[] = [];
  if (tracker.busy) flags.push({ label: 'announcing', title: 'Request in flight' });
  if (tracker.open) flags.push({ label: 'open', title: 'Connection open' });
  if (!tracker.usable) flags.push({ label: 'unusable', title: 'Not currently usable', tone: 'warn' });
  if (tracker.extra) flags.push({ label: 'extra', title: 'Added at runtime, not from the torrent' });
  if (tracker.failures > 0 && tracker.successes === 0) {
    flags.push({ label: 'failing', title: 'No successful announce yet', tone: 'bad' });
  }
  if (flags.length === 0 && tracker.successes > 0) {
    flags.push({ label: 'ok', title: 'Announced successfully', tone: 'good' });
  }
  return flags;
}

/** The torrent's trackers, each one switchable; a row expands to its announce history. Memoized, as FilesTab. */
export const TrackersTab = memo(function TrackersTab({
  hash,
  trackers,
  supports,
  onEnabled,
  onAdded,
}: {
  hash: string;
  trackers: Tracker[] | undefined;
  supports: Record<string, boolean> | undefined;
  onEnabled: (index: number, enabled: boolean) => void;
  onAdded: () => void;
}) {
  const [isOpen, toggle] = useExpanded();
  // The announce times count down with the clock. Being memoized, the tab
  // would otherwise move them only when the next poll replaces its rows.
  useClock();
  return (
    <>
      <table className="grid trackers-grid">
        <thead>
          <tr>
            <th>URL</th>
            <th className="col-type">Type</th>
            <th className="col-state">State</th>
            <th className="right col-seeders">Seeders</th>
            <th className="right col-leechers">Leechers</th>
            <th className="right col-downloaded">Downloaded</th>
            <th className="right col-peers" title="Peers returned by the last announce">
              Peers
            </th>
            <th className="col-next">Next announce</th>
            <th className="right col-attempts">OK / fail</th>
            <th className="col-enabled">Enabled</th>
          </tr>
        </thead>
        <tbody>
          {trackers?.map((tracker) => {
            const key = String(tracker.index);
            const open = isOpen(key);
            // A private tracker's URL carries the account's passkey.
            const url = redactUrl(tracker.url);
            return (
              <Fragment key={key}>
                <tr className={open ? 'expandable open' : 'expandable'} onClick={() => toggle(key)}>
                  <td className="wrap" title={url}>
                    <RowToggle open={open} onToggle={() => toggle(key)}>
                      {url}
                    </RowToggle>
                  </td>
                  <td>{TRACKER_TYPES[tracker.type] ?? `type ${tracker.type}`}</td>
                  <td>
                    <Flags flags={trackerFlags(tracker)} />
                  </td>
                  <td className="num right">{tracker.seeders || '—'}</td>
                  <td className="num right">{tracker.leechers || '—'}</td>
                  <td className="num right">{tracker.downloaded || '—'}</td>
                  <td className="num right">
                    {tracker.sumPeers || '—'}
                    {tracker.newPeers > 0 && <span className="ok-text"> +{tracker.newPeers}</span>}
                  </td>
                  <td className="num">{until(tracker.nextActivity)}</td>
                  <td className="num right">
                    {tracker.successes} /{' '}
                    <span className={tracker.failures ? 'danger-text' : undefined}>{tracker.failures}</span>
                  </td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <input
                      className="check"
                      type="checkbox"
                      checked={tracker.enabled}
                      disabled={supports?.trackerToggle === false}
                      aria-label={`Announce to ${url}`}
                      onChange={(event) => onEnabled(tracker.index, event.target.checked)}
                    />
                  </td>
                </tr>
                {open && (
                  <tr className="detail-row">
                    <td colSpan={COLUMNS}>
                      <MiniKv
                        rows={[
                          ['Group', String(tracker.group)],
                          ['Tracker ID', tracker.trackerId || '—'],
                          ['Latest event', TRACKER_EVENTS[tracker.latestEvent] ?? String(tracker.latestEvent)],
                          ['Last announce', relative(tracker.lastActivity)],
                          ['Next announce', until(tracker.nextActivity)],
                          ['Last success', relative(tracker.lastSuccess)],
                          ['Next success', until(tracker.nextSuccess)],
                          ['Last failure', tracker.lastFailure ? relative(tracker.lastFailure) : '—'],
                          ['Next retry', tracker.failures > 0 ? until(tracker.nextFailure) : '—'],
                          ['Announce interval', duration(tracker.interval)],
                          ['Min interval', duration(tracker.minInterval)],
                          ['Peers last announce', `${tracker.sumPeers} (${tracker.newPeers} new)`],
                          ['Scrapes', String(tracker.scrapes)],
                          ['Last scrape', relative(tracker.lastScrape)],
                          ['Scrapable', yesNo(tracker.canScrape)],
                          ['Usable', yesNo(tracker.usable)],
                        ]}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {!trackers && <NoteRow span={COLUMNS}>Loading…</NoteRow>}
          {trackers?.length === 0 && <NoteRow span={COLUMNS}>No trackers.</NoteRow>}
        </tbody>
      </table>
      {supports?.trackerInsert !== false && <AddTracker hash={hash} onAdded={onAdded} />}
    </>
  );
});

/** Add an announce URL to the torrent (d.tracker.insert). */
function AddTracker({ hash, onAdded }: { hash: string; onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const valid = TRACKER_URL.test(url.trim());

  const add = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await api.addTracker(hash, url.trim());
      setUrl('');
      toast.push('success', 'Tracker added');
      onAdded();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="add-tracker"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <input
        className="input compact"
        placeholder="Add a tracker — http(s):// or udp:// announce URL"
        aria-label="Tracker announce URL"
        aria-invalid={(url.trim() !== '' && !valid) || undefined}
        value={url}
        disabled={busy}
        onChange={(event) => setUrl(event.target.value)}
      />
      <button className="btn sm" type="submit" disabled={!valid || busy}>
        <IconPlus size={13} />
        <span>Add tracker</span>
      </button>
    </form>
  );
}
