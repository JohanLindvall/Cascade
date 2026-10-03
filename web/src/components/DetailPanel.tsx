import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { api } from '../api';
import { useLatest, useMounted, usePolling } from '../hooks';
import { DETAIL_HEIGHT } from '../preferences';
import type { Peer, Torrent, TorrentFile, Tracker } from '../types';
import { FilesTab } from './detail/FilesTab';
import { GeneralTab } from './detail/GeneralTab';
import { PeersTab } from './detail/PeersTab';
import { TrackersTab } from './detail/TrackersTab';
import { trapTab, useFocusRegion } from './focus';
import { IconClose, IconFile, IconGlobe, IconInfo, IconUsers } from './icons';
import { useToast } from './toast';

type Tab = 'general' | 'files' | 'peers' | 'trackers';

const TABS: Array<{ tab: Tab; label: string; icon: ReactNode }> = [
  { tab: 'general', label: 'General', icon: <IconInfo size={13} /> },
  { tab: 'files', label: 'Files', icon: <IconFile size={13} /> },
  { tab: 'peers', label: 'Peers', icon: <IconUsers size={13} /> },
  { tab: 'trackers', label: 'Trackers', icon: <IconGlobe size={13} /> },
];

/** How far one arrow-key press moves the resize handle. */
const RESIZE_STEP = 24;

/** What the tabs show, tagged with the torrent it belongs to. */
interface TabData {
  hash: string;
  files?: TorrentFile[];
  peers?: Peer[];
  trackers?: Tracker[];
}

interface DetailPanelProps {
  compact: boolean;
  torrent: Torrent;
  onClose: () => void;
  onHeightChange: (height: number) => void;
  height: number;
  onRecheckRestart: (hashes: string[]) => Promise<void>;
  /** The backend's feature map; a missing entry counts as supported. */
  supports: Record<string, boolean> | undefined;
}

/**
 * The pane under the list: the focused torrent's details in four tabs. The
 * general tab is drawn from the listing the stream keeps current; the others
 * are fetched here, every few seconds while shown, and kept per torrent so
 * switching back to a tab shows its last rows while they refresh.
 */
export function DetailPanel({
  compact,
  torrent,
  onClose,
  onHeightChange,
  height,
  onRecheckRestart,
  supports,
}: DetailPanelProps) {
  const panel = useRef<HTMLElement>(null);
  useFocusRegion(panel, compact);
  const [tab, setTab] = useState<Tab>('general');
  const [data, setData] = useState<TabData>({ hash: torrent.hash });
  const toast = useToast();
  const ids = useId();
  const hash = torrent.hash;
  const context = useLatest({ hash, tab });
  const revision = useRef(0);
  const requestId = useRef(0);
  const alive = useMounted();
  // Rows fetched for another torrent are not shown for this one, even for the
  // moment before this one's arrive — switching rows used to flash (and, with
  // a slow reply, keep) the previous torrent's files, peers and trackers.
  const current = data.hash === hash ? data : { hash };

  const loadTab = useCallback(
    async (isCurrent: () => boolean) => {
      // The general tab shows the listing, which the stream already keeps current.
      if (tab === 'general' || !alive.current || !isCurrent() ||
          context.current.hash !== hash || context.current.tab !== tab) return;
      const id = ++requestId.current;
      const beforeEdit = revision.current;
      const relevant = () => alive.current && isCurrent() && id === requestId.current &&
        context.current.hash === hash && context.current.tab === tab && beforeEdit === revision.current;
      if (!relevant()) return;
      try {
        const patch: Partial<TabData> =
          tab === 'files'
            ? { files: await api.files(hash) }
            : tab === 'peers'
              ? { peers: await api.peers(hash) }
              : { trackers: await api.trackers(hash) };
        if (!relevant()) return;
        setData((previous) => (previous.hash === hash ? { ...previous, ...patch } : { hash, ...patch }));
      } catch (error) {
        if (relevant()) toast.error(error);
      }
    },
    [hash, tab, toast, context, alive],
  );
  usePolling(loadTab, 2500);

  /** Apply a local edit to this torrent's rows, for an instant response. */
  const edit = useCallback(
    (patch: (rows: TabData) => Partial<TabData>) => {
      // An edit finishing for the previous torrent must not invalidate this
      // torrent's in-flight read (nor update its rows).
      if (!alive.current || context.current.hash !== hash) return;
      revision.current += 1;
      setData((previous) => (previous.hash === hash ? { ...previous, ...patch(previous) } : previous));
    },
    [hash, alive, context],
  );

  // What the tabs are handed must keep its identity between renders. The app
  // redraws on every stream delta — at least once a second even when idle —
  // and the tabs are memoized so that their rows are drawn again only when
  // their own rows change: a fresh function here would defeat that, and an
  // 8000-file torrent then stalled the page for 200 ms on every delta.
  const setFilePriority = useCallback(
    async (index: number, priority: number) => {
      try {
        await api.setFilePriority(hash, index, priority);
        edit((rows) => ({ files: rows.files?.map((file) => (file.index === index ? { ...file, priority } : file)) }));
      } catch (error) {
        toast.error(error);
      }
    },
    [hash, toast, edit],
  );

  const toggleTracker = useCallback(
    async (index: number, enabled: boolean) => {
      try {
        await api.setTrackerEnabled(hash, index, enabled);
        edit((rows) => ({
          trackers: rows.trackers?.map((tracker) => (tracker.index === index ? { ...tracker, enabled } : tracker)),
        }));
      } catch (error) {
        toast.error(error);
      }
    },
    [hash, toast, edit],
  );

  const reloadTab = useCallback(() => void loadTab(() => true), [loadTab]);

  /* ------------------------------ resizing ------------------------------ */

  const clamp = (value: number) => Math.max(DETAIL_HEIGHT.min,
    Math.min(DETAIL_HEIGHT.max, window.innerHeight - 200, value));

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
    <section
      ref={panel}
      className="detail"
      style={{ height }}
      role={compact ? 'dialog' : undefined}
      aria-modal={compact || undefined}
      aria-label={`Details of ${torrent.name || hash}`}
      tabIndex={compact ? -1 : undefined}
      onKeyDown={(event) => {
        if (!compact) return;
        trapTab(event, panel.current);
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
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
        {/* Keyed by torrent where a tab has state: expanded rows and a half-typed tracker belong to the torrent they were for. */}
        {tab === 'general' && <GeneralTab torrent={torrent} onRecheckRestart={onRecheckRestart} />}
        {tab === 'files' && <FilesTab files={current.files} onPriority={setFilePriority} />}
        {tab === 'peers' && <PeersTab key={hash} peers={current.peers} />}
        {tab === 'trackers' && (
          <TrackersTab
            key={hash}
            hash={hash}
            trackers={current.trackers}
            supports={supports}
            onEnabled={toggleTracker}
            onAdded={reloadTab}
          />
        )}
      </div>
    </section>
  );
}
