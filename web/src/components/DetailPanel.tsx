import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { api } from '../api';
import {
  FILE_PRIORITIES,
  TORRENT_PRIORITIES,
  bytes,
  duration,
  fileName,
  percent,
  priorityLabel,
  rate,
  relative,
  timestamp,
  until,
} from '../format';
import { usePolling } from '../hooks';
import { DETAIL_HEIGHT } from '../preferences';
import { redactSecrets, redactUrl } from '../redact';
import type { Peer, Torrent, TorrentFile, Tracker } from '../types';
import { IconClose, IconFile, IconGlobe, IconInfo, IconPlus, IconRefresh, IconUsers } from './icons';
import { ProgressBar, useToast } from './ui';

type Tab = 'general' | 'files' | 'peers' | 'trackers';

const TABS: Array<{ tab: Tab; label: string; icon: ReactNode }> = [
  { tab: 'general', label: 'General', icon: <IconInfo size={13} /> },
  { tab: 'files', label: 'Files', icon: <IconFile size={13} /> },
  { tab: 'peers', label: 'Peers', icon: <IconUsers size={13} /> },
  { tab: 'trackers', label: 'Trackers', icon: <IconGlobe size={13} /> },
];

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

/** How far one arrow-key press moves the resize handle. */
const RESIZE_STEP = 24;

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

function Flags({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return <span className="faint">—</span>;
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

const yesNo = (value: boolean) => (value ? 'yes' : 'no');

/** Key/value block shown when a peer or tracker row is expanded. */
function MiniKv({ rows }: { rows: Array<[string, ReactNode]> }) {
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

/** A table row spanning every column, for "loading" and "nothing here". */
function NoteRow({ span, children }: { span: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={span} className="faint">
        {children}
      </td>
    </tr>
  );
}

/** What the tabs show, tagged with the torrent it belongs to. */
interface TabData {
  hash: string;
  files?: TorrentFile[];
  peers?: Peer[];
  trackers?: Tracker[];
}

interface DetailPanelProps {
  torrent: Torrent;
  onClose: () => void;
  onHeightChange: (height: number) => void;
  height: number;
  onRecheckRestart: (hashes: string[]) => Promise<void>;
  /** The backend's feature map; a missing entry counts as supported. */
  supports: Record<string, boolean> | undefined;
}

export function DetailPanel({
  torrent,
  onClose,
  onHeightChange,
  height,
  onRecheckRestart,
  supports,
}: DetailPanelProps) {
  const [tab, setTab] = useState<Tab>('general');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [data, setData] = useState<TabData>({ hash: torrent.hash });
  const toast = useToast();
  const ids = useId();
  const hash = torrent.hash;
  // Rows fetched for another torrent are not shown for this one, even for the
  // moment before this one's arrive — switching rows used to flash (and, with
  // a slow reply, keep) the previous torrent's files, peers and trackers.
  const current = data.hash === hash ? data : { hash };

  const loadTab = useCallback(
    async (isCurrent: () => boolean) => {
      try {
        const patch: Partial<TabData> =
          tab === 'files'
            ? { files: await api.files(hash) }
            : tab === 'peers'
              ? { peers: await api.peers(hash) }
              : tab === 'trackers'
                ? { trackers: await api.trackers(hash) }
                : {};
        if (!isCurrent()) return; // An answer for a torrent or tab no longer shown.
        setData((previous) => (previous.hash === hash ? { ...previous, ...patch } : { hash, ...patch }));
      } catch (error) {
        if (isCurrent()) toast.error(error);
      }
    },
    [hash, tab, toast],
  );
  usePolling(loadTab, 2500);

  // Collapse expanded rows when switching torrent or tab.
  useEffect(() => setExpanded(new Set()), [hash, tab]);

  const toggle = (key: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Apply a local edit to this torrent's rows, for an instant response. */
  const edit = (patch: (rows: TabData) => Partial<TabData>) =>
    setData((previous) => (previous.hash === hash ? { ...previous, ...patch(previous) } : previous));

  const setFilePriority = async (index: number, priority: number) => {
    try {
      await api.setFilePriority(hash, index, priority);
      edit((rows) => ({ files: rows.files?.map((file) => (file.index === index ? { ...file, priority } : file)) }));
    } catch (error) {
      toast.error(error);
    }
  };

  const toggleTracker = async (index: number, enabled: boolean) => {
    try {
      await api.setTrackerEnabled(hash, index, enabled);
      edit((rows) => ({
        trackers: rows.trackers?.map((tracker) => (tracker.index === index ? { ...tracker, enabled } : tracker)),
      }));
    } catch (error) {
      toast.error(error);
    }
  };

  /* ------------------------------ resizing ------------------------------ */

  const clamp = (value: number) => Math.min(window.innerHeight - 200, Math.max(DETAIL_HEIGHT.min, value));

  // Pointer events cover mouse, touch and pen alike; capture keeps the moves
  // coming while the pointer is off the thin handle.
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startY = event.clientY;
    const startHeight = height;
    handle.setPointerCapture(event.pointerId);
    // Without this the drag doubles as a text selection sweeping the whole
    // page; the class also keeps the resize cursor while moving.
    document.body.classList.add('row-resizing');
    const move = (moved: PointerEvent) => onHeightChange(clamp(startHeight + startY - moved.clientY));
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('row-resizing');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const keyResize = (event: ReactKeyboardEvent) => {
    const delta = event.key === 'ArrowUp' ? RESIZE_STEP : event.key === 'ArrowDown' ? -RESIZE_STEP : 0;
    if (!delta) return;
    event.preventDefault();
    onHeightChange(clamp(height + delta));
  };

  useEffect(() => () => document.body.classList.remove('row-resizing'), []);

  /* -------------------------------- tabs -------------------------------- */

  // Arrow keys move between tabs, as a tab list is operated.
  const keyTabs = (event: ReactKeyboardEvent) => {
    const index = TABS.findIndex((item) => item.tab === tab);
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length].tab;
    setTab(next);
    document.getElementById(`${ids}-${next}`)?.focus();
  };

  return (
    <section className="detail" style={{ height }} aria-label={`Details of ${torrent.name || hash}`}>
      <div
        className="detail-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the details pane"
        aria-valuemin={DETAIL_HEIGHT.min}
        aria-valuemax={DETAIL_HEIGHT.max}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={keyResize}
      />
      <div className="detail-head">
        <div className="detail-title" title={torrent.name}>
          {torrent.name}
        </div>
        <div className="tabs" role="tablist" aria-label="Detail views" onKeyDown={keyTabs}>
          {TABS.map((item) => (
            <button
              key={item.tab}
              id={`${ids}-${item.tab}`}
              role="tab"
              aria-selected={tab === item.tab}
              aria-controls={`${ids}-panel`}
              tabIndex={tab === item.tab ? 0 : -1}
              className={`tab ${tab === item.tab ? 'active' : ''}`}
              onClick={() => setTab(item.tab)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        <button className="btn icon ghost" onClick={onClose} aria-label="Close details">
          <IconClose size={15} />
        </button>
      </div>

      <div className="detail-body" id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-${tab}`}>
        {tab === 'general' && <General torrent={torrent} onRecheckRestart={onRecheckRestart} />}

        {tab === 'files' && (
          <table className="grid">
            <thead>
              <tr>
                <th>File</th>
                <th className="right" style={{ width: 96 }}>
                  Size
                </th>
                <th style={{ width: 170 }}>Progress</th>
                <th style={{ width: 130 }}>Priority</th>
              </tr>
            </thead>
            <tbody>
              {current.files?.map((file) => (
                <tr key={file.index}>
                  <td className="wrap" title={file.path}>
                    {fileName(file.path)}
                    {file.path.includes('/') && <div className="subline">{file.path}</div>}
                    {file.onDisk && (
                      <div
                        className="subline warn-text"
                        title="The name was longer than the filesystem allows, so it was shortened to fit"
                      >
                        on disk as {file.onDisk}
                      </div>
                    )}
                  </td>
                  <td className="num right">{bytes(file.size)}</td>
                  <td>
                    <div className="progress-cell">
                      <ProgressBar
                        value={file.progress}
                        variant={file.progress >= 1 ? 'done' : file.priority === 0 ? 'idle' : 'default'}
                        label={`Progress of ${fileName(file.path)}`}
                      />
                      <span className="num">{percent(file.progress, 0)}</span>
                    </div>
                  </td>
                  <td>
                    <select
                      className="select compact"
                      value={file.priority}
                      aria-label={`Priority of ${fileName(file.path)}`}
                      onChange={(event) => void setFilePriority(file.index, Number(event.target.value))}
                    >
                      {FILE_PRIORITIES.map(({ value, label }) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {!current.files && <NoteRow span={4}>Loading…</NoteRow>}
              {current.files?.length === 0 && <NoteRow span={4}>No file information available.</NoteRow>}
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
                <th className="right" style={{ width: 92 }}>
                  Down
                </th>
                <th className="right" style={{ width: 92 }}>
                  Up
                </th>
                <th className="right" style={{ width: 92 }} title="What this peer is pulling from the swarm">
                  Swarm
                </th>
                <th className="right" style={{ width: 100 }}>
                  Downloaded
                </th>
                <th className="right" style={{ width: 100 }}>
                  Uploaded
                </th>
                <th style={{ width: 150 }}>Flags</th>
              </tr>
            </thead>
            <tbody>
              {current.peers?.map((peer) => {
                const key = `p:${peer.address}:${peer.port}`;
                const open = expanded.has(key);
                return (
                  <Fragment key={key}>
                    <tr
                      className={`expandable ${open ? 'open' : ''}`}
                      onClick={() => toggle(key)}
                      aria-expanded={open}
                    >
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
                            label={`Progress of peer ${peer.address}`}
                          />
                          <span className="num">{percent(peer.progress, 0)}</span>
                        </div>
                      </td>
                      <td className="num right rate-num down">{rate(peer.downRate)}</td>
                      <td className="num right rate-num up">{rate(peer.upRate)}</td>
                      <td className="num right faint">{rate(peer.peerRate)}</td>
                      <td className="num right">{bytes(peer.downTotal)}</td>
                      <td className="num right">{bytes(peer.upTotal)}</td>
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
                              ['Obfuscated header', yesNo(peer.obfuscated)],
                              ['Preferred', yesNo(peer.preferred)],
                              ['Snubbed', yesNo(peer.snubbed)],
                              ['Unwanted', yesNo(peer.unwanted)],
                              ['Banned', yesNo(peer.banned)],
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
              {!current.peers && <NoteRow span={9}>Loading…</NoteRow>}
              {current.peers?.length === 0 && <NoteRow span={9}>No peers connected.</NoteRow>}
            </tbody>
          </table>
        )}

        {tab === 'trackers' && (
          <>
            <table className="grid">
              <thead>
                <tr>
                  <th>URL</th>
                  <th style={{ width: 64 }}>Type</th>
                  <th style={{ width: 132 }}>State</th>
                  <th className="right" style={{ width: 80 }}>
                    Seeders
                  </th>
                  <th className="right" style={{ width: 84 }}>
                    Leechers
                  </th>
                  <th className="right" style={{ width: 100 }}>
                    Downloaded
                  </th>
                  <th className="right" style={{ width: 76 }} title="Peers returned by the last announce">
                    Peers
                  </th>
                  <th style={{ width: 116 }}>Next announce</th>
                  <th className="right" style={{ width: 88 }}>
                    OK / fail
                  </th>
                  <th style={{ width: 72 }}>Enabled</th>
                </tr>
              </thead>
              <tbody>
                {current.trackers?.map((tracker) => {
                  const key = `t:${tracker.index}`;
                  const open = expanded.has(key);
                  // A private tracker's URL carries the account's passkey.
                  const url = redactUrl(tracker.url);
                  return (
                    <Fragment key={key}>
                      <tr
                        className={`expandable ${open ? 'open' : ''}`}
                        onClick={() => toggle(key)}
                        aria-expanded={open}
                      >
                        <td className="wrap" title={url}>
                          <span className="caret">{open ? '▾' : '▸'}</span>
                          {url}
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
                                [
                                  'Latest event',
                                  TRACKER_EVENTS[tracker.latestEvent] ?? String(tracker.latestEvent),
                                ],
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
                {!current.trackers && <NoteRow span={10}>Loading…</NoteRow>}
                {current.trackers?.length === 0 && <NoteRow span={10}>No trackers.</NoteRow>}
              </tbody>
            </table>
            {supports?.trackerInsert !== false && (
              <AddTracker hash={hash} onAdded={() => void loadTab(() => true)} />
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Add an announce URL to the torrent (d.tracker.insert). */
function AddTracker({ hash, onAdded }: { hash: string; onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const valid = TRACKER_URL.test(url.trim());

  const add = async () => {
    if (!valid) return;
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
        onChange={(event) => setUrl(event.target.value)}
      />
      <button className="btn sm" type="submit" disabled={!valid || busy}>
        <IconPlus size={13} />
        <span>Add tracker</span>
      </button>
    </form>
  );
}

function General({
  torrent,
  onRecheckRestart,
}: {
  torrent: Torrent;
  onRecheckRestart: (hashes: string[]) => Promise<void>;
}) {
  const [fixing, setFixing] = useState(false);
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
