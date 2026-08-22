import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { bytes, duration, fileName, percent, rate, relative, timestamp, until } from '../format';
import type { Peer, Torrent, TorrentFile, Tracker } from '../types';
import { IconClose, IconFile, IconGlobe, IconInfo, IconUsers } from './icons';
import { ProgressBar, useToast } from './ui';

type Tab = 'general' | 'files' | 'peers' | 'trackers';

const PRIORITY_LABELS: Record<number, string> = { 0: 'skip', 1: 'normal', 2: 'high' };

/** libtorrent's Tracker::Type / Tracker::Event enumerations. */
const TRACKER_TYPES: Record<number, string> = { 1: 'HTTP', 2: 'UDP', 3: 'DHT' };
const TRACKER_EVENTS: Record<number, string> = {
  0: 'none',
  1: 'completed',
  2: 'started',
  3: 'stopped',
  4: 'scrape',
};

interface Flag {
  label: string;
  title: string;
  tone?: 'good' | 'warn' | 'bad';
}

function peerFlags(peer: Peer): Flag[] {
  const flags: Flag[] = [];
  if (peer.encrypted) flags.push({ label: 'enc', title: 'Connection is encrypted', tone: 'good' });
  if (peer.obfuscated) flags.push({ label: 'obf', title: 'Header obfuscation in use' });
  if (peer.incoming) flags.push({ label: 'in', title: 'Peer connected to us' });
  if (peer.preferred) flags.push({ label: 'pref', title: 'Preferred peer', tone: 'good' });
  if (peer.snubbed) flags.push({ label: 'snub', title: 'Snubbed — sent us nothing recently', tone: 'warn' });
  if (peer.unwanted) flags.push({ label: 'unwanted', title: 'Marked unwanted', tone: 'warn' });
  if (peer.banned) flags.push({ label: 'banned', title: 'Banned', tone: 'bad' });
  return flags;
}

function Flags({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return <span style={{ color: 'var(--text-faint)' }}>—</span>;
  return (
    <span className="flags">
      {flags.map((flag) => (
        <span key={flag.label} className={`tag ${flag.tone ?? ''}`} title={flag.title}>
          {flag.label}
        </span>
      ))}
    </span>
  );
}

/** Key/value block shown when a peer or tracker row is expanded. */
function MiniKv({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <div className="mini-kv">
      {rows.map(([key, value]) => (
        <div key={key}>
          <span>{key}</span>
          <b>{value}</b>
        </div>
      ))}
    </div>
  );
}

interface DetailPanelProps {
  torrent: Torrent;
  onClose: () => void;
  onHeightChange: (height: number) => void;
  height: number;
}

export function DetailPanel({ torrent, onClose, onHeightChange, height }: DetailPanelProps) {
  const [tab, setTab] = useState<Tab>('general');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<TorrentFile[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const toast = useToast();
  const hash = torrent.hash;

  const refresh = useCallback(async () => {
    try {
      if (tab === 'files') setFiles(await api.files(hash));
      else if (tab === 'peers') setPeers(await api.peers(hash));
      else if (tab === 'trackers') setTrackers(await api.trackers(hash));
    } catch (error) {
      toast.error(error);
    }
  }, [hash, tab, toast]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Collapse expanded rows when switching torrent or tab.
  useEffect(() => setExpanded(new Set()), [hash, tab]);

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const dragState = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    const onMove = (event: globalThis.MouseEvent) => {
      if (!dragState.current) return;
      const delta = dragState.current.startY - event.clientY;
      onHeightChange(
        Math.min(window.innerHeight - 200, Math.max(140, dragState.current.startHeight + delta)),
      );
    };
    const onUp = () => {
      dragState.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onHeightChange]);

  const setFilePriority = async (index: number, priority: number) => {
    try {
      await api.setFilePriority(hash, index, priority);
      setFiles((current) =>
        current.map((file) => (file.index === index ? { ...file, priority } : file)),
      );
    } catch (error) {
      toast.error(error);
    }
  };

  const toggleTracker = async (index: number, enabled: boolean) => {
    try {
      await api.setTrackerEnabled(hash, index, enabled);
      setTrackers((current) =>
        current.map((tracker) => (tracker.index === index ? { ...tracker, enabled } : tracker)),
      );
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <section className="detail" style={{ height }}>
      <div
        className="detail-resize"
        onMouseDown={(event) => {
          dragState.current = { startY: event.clientY, startHeight: height };
        }}
      />
      <div className="detail-head">
        <div className="detail-title" title={torrent.name}>
          {torrent.name}
        </div>
        <div className="tabs">
          <TabButton tab="general" current={tab} onClick={setTab} icon={<IconInfo size={13} />}>
            General
          </TabButton>
          <TabButton tab="files" current={tab} onClick={setTab} icon={<IconFile size={13} />}>
            Files
          </TabButton>
          <TabButton tab="peers" current={tab} onClick={setTab} icon={<IconUsers size={13} />}>
            Peers
          </TabButton>
          <TabButton tab="trackers" current={tab} onClick={setTab} icon={<IconGlobe size={13} />}>
            Trackers
          </TabButton>
        </div>
        <button className="btn icon ghost" onClick={onClose} aria-label="Close details">
          <IconClose size={15} />
        </button>
      </div>

      <div className="detail-body">
        {tab === 'general' && <General torrent={torrent} />}

        {tab === 'files' && (
          <table className="grid">
            <thead>
              <tr>
                <th>File</th>
                <th style={{ width: 96, textAlign: 'right' }}>Size</th>
                <th style={{ width: 170 }}>Progress</th>
                <th style={{ width: 130 }}>Priority</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.index}>
                  <td className="wrap" title={file.path}>
                    {fileName(file.path)}
                    {file.path.includes('/') && (
                      <div style={{ color: 'var(--text-faint)', fontSize: 11 }}>{file.path}</div>
                    )}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {bytes(file.size)}
                  </td>
                  <td>
                    <div className="progress-cell">
                      <ProgressBar
                        value={file.progress}
                        variant={file.progress >= 1 ? 'done' : file.priority === 0 ? 'idle' : 'default'}
                      />
                      <span className="num">{percent(file.progress, 0)}</span>
                    </div>
                  </td>
                  <td>
                    <select
                      className="select"
                      style={{ height: 26, fontSize: 12 }}
                      value={file.priority}
                      onChange={(event) => void setFilePriority(file.index, Number(event.target.value))}
                    >
                      {[0, 1, 2].map((value) => (
                        <option key={value} value={value}>
                          {PRIORITY_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {files.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ color: 'var(--text-faint)' }}>
                    No file information available.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {tab === 'peers' && (
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 160 }}>Address</th>
                <th>Client</th>
                <th style={{ width: 140 }}>Progress</th>
                <th style={{ width: 92, textAlign: 'right' }}>Down</th>
                <th style={{ width: 92, textAlign: 'right' }}>Up</th>
                <th
                  style={{ width: 92, textAlign: 'right' }}
                  title="What this peer is pulling from the swarm"
                >
                  Swarm
                </th>
                <th style={{ width: 100, textAlign: 'right' }}>Downloaded</th>
                <th style={{ width: 100, textAlign: 'right' }}>Uploaded</th>
                <th style={{ width: 150 }}>Flags</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((peer) => {
                const key = `p:${peer.address}:${peer.port}`;
                const open = expanded.has(key);
                return (
                  <Fragment key={key}>
                    <tr className={`expandable ${open ? 'open' : ''}`} onClick={() => toggle(key)}>
                      <td className="num">
                        <span className="caret">{open ? '▾' : '▸'}</span>
                        {peer.address}:{peer.port}
                      </td>
                      <td>{peer.client || '—'}</td>
                      <td>
                        <div className="progress-cell">
                          <ProgressBar
                            value={peer.progress}
                            variant={peer.progress >= 1 ? 'done' : 'default'}
                          />
                          <span className="num">{percent(peer.progress, 0)}</span>
                        </div>
                      </td>
                      <td className="num rate-num down" style={{ textAlign: 'right' }}>
                        {rate(peer.downRate)}
                      </td>
                      <td className="num rate-num up" style={{ textAlign: 'right' }}>
                        {rate(peer.upRate)}
                      </td>
                      <td className="num" style={{ textAlign: 'right', color: 'var(--text-faint)' }}>
                        {rate(peer.peerRate)}
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {bytes(peer.downTotal)}
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {bytes(peer.upTotal)}
                      </td>
                      <td>
                        <Flags flags={peerFlags(peer)} />
                      </td>
                    </tr>
                    {open && (
                      <tr className="detail-row">
                        <td colSpan={9}>
                          <MiniKv
                            rows={[
                              ['Peer ID', peer.id || '—'],
                              ['Client', peer.client || 'unknown'],
                              ['Extensions', peer.options || '—'],
                              ['Direction', peer.incoming ? 'incoming' : 'outgoing'],
                              ['Encryption', peer.encrypted ? 'encrypted' : 'plaintext'],
                              ['Obfuscated header', peer.obfuscated ? 'yes' : 'no'],
                              ['Preferred', peer.preferred ? 'yes' : 'no'],
                              ['Snubbed', peer.snubbed ? 'yes' : 'no'],
                              ['Unwanted', peer.unwanted ? 'yes' : 'no'],
                              ['Banned', peer.banned ? 'yes' : 'no'],
                              ['Swarm rate', rate(peer.peerRate)],
                              ['Swarm total', bytes(peer.peerTotal)],
                            ]}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {peers.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ color: 'var(--text-faint)' }}>
                    No peers connected.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {tab === 'trackers' && (
          <table className="grid">
            <thead>
              <tr>
                <th>URL</th>
                <th style={{ width: 64 }}>Type</th>
                <th style={{ width: 132 }}>State</th>
                <th style={{ width: 80, textAlign: 'right' }}>Seeders</th>
                <th style={{ width: 84, textAlign: 'right' }}>Leechers</th>
                <th style={{ width: 100, textAlign: 'right' }}>Downloaded</th>
                <th
                  style={{ width: 76, textAlign: 'right' }}
                  title="Peers returned by the last announce"
                >
                  Peers
                </th>
                <th style={{ width: 116 }}>Next announce</th>
                <th style={{ width: 88, textAlign: 'right' }}>OK / fail</th>
                <th style={{ width: 72 }}>Enabled</th>
              </tr>
            </thead>
            <tbody>
              {trackers.map((tracker) => {
                const key = `t:${tracker.index}`;
                const open = expanded.has(key);
                const state: Flag[] = [];
                if (tracker.busy) state.push({ label: 'announcing', title: 'Request in flight' });
                if (tracker.open) state.push({ label: 'open', title: 'Connection open' });
                if (!tracker.usable) state.push({ label: 'unusable', title: 'Not currently usable', tone: 'warn' });
                if (tracker.extra) state.push({ label: 'extra', title: 'Added at runtime, not from the torrent' });
                if (tracker.failures > 0 && tracker.successes === 0) {
                  state.push({ label: 'failing', title: 'No successful announce yet', tone: 'bad' });
                }
                if (state.length === 0 && tracker.successes > 0) {
                  state.push({ label: 'ok', title: 'Announced successfully', tone: 'good' });
                }
                return (
                  <Fragment key={key}>
                    <tr className={`expandable ${open ? 'open' : ''}`} onClick={() => toggle(key)}>
                      <td className="wrap" title={tracker.url}>
                        <span className="caret">{open ? '▾' : '▸'}</span>
                        {tracker.url}
                      </td>
                      <td>{TRACKER_TYPES[tracker.type] ?? `type ${tracker.type}`}</td>
                      <td>
                        <Flags flags={state} />
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {tracker.seeders || '—'}
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {tracker.leechers || '—'}
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {tracker.downloaded || '—'}
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {tracker.sumPeers || '—'}
                        {tracker.newPeers > 0 && (
                          <span style={{ color: 'var(--ok)' }}> +{tracker.newPeers}</span>
                        )}
                      </td>
                      <td className="num">{until(tracker.nextActivity)}</td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {tracker.successes} /{' '}
                        <span style={{ color: tracker.failures ? 'var(--danger)' : undefined }}>
                          {tracker.failures}
                        </span>
                      </td>
                      <td onClick={(event) => event.stopPropagation()}>
                        <input
                          className="check"
                          type="checkbox"
                          checked={tracker.enabled}
                          onChange={(event) => void toggleTracker(tracker.index, event.target.checked)}
                        />
                      </td>
                    </tr>
                    {open && (
                      <tr className="detail-row">
                        <td colSpan={10}>
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
                              ['Scrapable', tracker.canScrape ? 'yes' : 'no'],
                              ['Usable', tracker.usable ? 'yes' : 'no'],
                            ]}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {trackers.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ color: 'var(--text-faint)' }}>
                    No trackers.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function TabButton({
  tab,
  current,
  onClick,
  icon,
  children,
}: {
  tab: Tab;
  current: Tab;
  onClick: (tab: Tab) => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`tab ${current === tab ? 'active' : ''}`}
      onClick={() => onClick(tab)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
    >
      {icon}
      {children}
    </button>
  );
}

function General({ torrent }: { torrent: Torrent }) {
  const rows: Array<[string, React.ReactNode]> = [
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
    ['Priority', ['off', 'low', 'normal', 'high'][torrent.priority] ?? String(torrent.priority)],
    ['Label', torrent.label || '—'],
    ['Throttle group', torrent.throttle || 'global'],
    ['Chunks', `${torrent.chunksDone} / ${torrent.chunksTotal} × ${bytes(torrent.chunkSize)}`],
    ['Private', torrent.isPrivate ? 'yes' : 'no'],
    ['Multi-file', torrent.isMultiFile ? 'yes' : 'no'],
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
      {torrent.message && (
        <div className="banner" style={{ marginBottom: 12, borderRadius: 9 }}>
          {torrent.message}
        </div>
      )}
      <div className="kv-grid">
        {rows.map(([key, value]) => (
          <div className="kv" key={key}>
            <span>{key}</span>
            <b title={typeof value === 'string' ? value : undefined}>{value}</b>
          </div>
        ))}
      </div>
    </>
  );
}
