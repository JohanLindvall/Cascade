import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from 'react';
import { api } from './api';
import { AchievementsDialog } from './components/Achievements';
import { AddDialog } from './components/AddDialog';
import { Celebrate } from './components/Celebrate';
import { DetailPanel } from './components/DetailPanel';
import { Header } from './components/Header';
import { LogDialog } from './components/LogDialog';
import { RpcConsole } from './components/RpcConsole';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar, matchesStatus, type Filter } from './components/Sidebar';
import { ThrottleDialog } from './components/ThrottleDialog';
import {
  TorrentTable,
  sortTorrents,
  type SelectMods,
  type SortKey,
  type SortState,
} from './components/TorrentTable';
import {
  IconAlert,
  IconGauge,
  IconUpload,
  IconList,
  IconMove,
  IconPause,
  IconPlay,
  IconRefresh,
  IconSearch,
  IconStop,
  IconTag,
  IconTrash,
} from './components/icons';
import { ContextMenu, MenuItem, useToast } from './components/ui';
import type { GameState, GlobalStatus, ThrottleGroup, Torrent } from './types';

type Dialog = 'add' | 'settings' | 'throttles' | 'console' | 'log' | 'progress' | null;

/** Badge unlocks are announced once per browser. */
const SEEN_BADGES_KEY = 'cascade.seenBadges';

interface MenuState {
  x: number;
  y: number;
  hash: string;
}

const REFRESH_MS = 1500;

export function App() {
  const [torrents, setTorrents] = useState<Torrent[]>([]);
  const [status, setStatus] = useState<GlobalStatus | null>(null);
  const [throttles, setThrottles] = useState<ThrottleGroup[]>([]);
  const [game, setGame] = useState<GameState | null>(null);
  const [trackerHosts, setTrackerHosts] = useState<Record<string, string>>({});
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const [filter, setFilter] = useState<Filter>({ kind: 'status', value: 'all' });
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'addedAt', dir: 'desc' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [detailHeight, setDetailHeight] = useState(280);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dropping, setDropping] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [celebration, setCelebration] = useState(0);
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('cascade.theme') as 'dark' | 'light') ?? 'dark',
  );

  const toast = useToast();
  const lastAnchor = useRef<string | null>(null);
  const dragDepth = useRef(0);
  const completedRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cascade.theme', theme);
  }, [theme]);

  /* ------------------------------ polling ------------------------------ */

  const refresh = useCallback(async () => {
    try {
      const state = await api.state();

      // Celebrate anything that finished since the last poll. The first poll
      // only seeds the baseline so a page load does not fire off confetti.
      const done = new Set(
        state.torrents.filter((torrent) => torrent.progress >= 1).map((torrent) => torrent.hash),
      );
      if (completedRef.current) {
        const fresh = state.torrents.filter(
          (torrent) => torrent.progress >= 1 && !completedRef.current?.has(torrent.hash),
        );
        if (fresh.length > 0 && state.game?.enabled) {
          setCelebration((value) => value + 1);
          for (const torrent of fresh) {
            toast.push('success', `Finished — ${torrent.name}`);
          }
        }
      }
      completedRef.current = done;

      setTorrents(state.torrents);
      setStatus(state.status);
      setThrottles(state.throttles);
      setGame(state.game ?? null);
      announceBadges(state.game);
      setConnectionError(state.status.connected ? null : (state.status.error ?? 'rtorrent is not responding'));
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Tracker hosts change rarely; refresh them only when the torrent set changes.
  const hashKey = torrents.map((torrent) => torrent.hash).join(',');
  useEffect(() => {
    const hashes = hashKey ? hashKey.split(',') : [];
    if (hashes.length === 0) {
      setTrackerHosts({});
      return;
    }
    api
      .trackerHosts(hashes)
      .then(setTrackerHosts)
      .catch(() => {
        /* tracker grouping is cosmetic; ignore failures */
      });
  }, [hashKey]);

  /** Toast badges the user has not been told about yet. */
  const announceBadges = useCallback(
    (state: GameState | null | undefined) => {
      if (!state?.enabled) return;
      let seen: string[] = [];
      try {
        seen = JSON.parse(localStorage.getItem(SEEN_BADGES_KEY) ?? '[]') as string[];
      } catch {
        seen = [];
      }
      const earned = state.achievements.filter((item) => item.unlockedAt !== null);
      const fresh = earned.filter((item) => !seen.includes(item.id));
      if (fresh.length === 0) return;
      // A first run against an established session can earn several at once;
      // only shout about them once the baseline is known.
      if (seen.length === 0 && fresh.length > 2) {
        localStorage.setItem(SEEN_BADGES_KEY, JSON.stringify(earned.map((item) => item.id)));
        return;
      }
      for (const item of fresh) {
        toast.push('achievement', `Badge unlocked — ${item.title}: ${item.description}`);
      }
      localStorage.setItem(SEEN_BADGES_KEY, JSON.stringify(earned.map((item) => item.id)));
    },
    [toast],
  );

  /* --------------------------- drag and drop ---------------------------- */

  const acceptTorrents = (list: FileList | null): File[] =>
    [...(list ?? [])].filter(
      (file) =>
        file.name.toLowerCase().endsWith('.torrent') || file.type === 'application/x-bittorrent',
    );

  const carriesFiles = (event: DragEvent): boolean =>
    [...(event.dataTransfer?.types ?? [])].includes('Files');

  const onDragEnter = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    dragDepth.current += 1;
    setDropping(true);
  };

  const onDragLeave = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropping(false);
  };

  const onDropFiles = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    const files = acceptTorrents(event.dataTransfer?.files ?? null);
    const rejected = (event.dataTransfer?.files.length ?? 0) - files.length;
    if (rejected > 0) {
      toast.push('info', `${rejected} file(s) ignored — only .torrent files are accepted`);
    }
    if (files.length === 0) return;
    setPendingFiles(files);
    setDialog('add');
  };

  /* ------------------------------ filtering ---------------------------- */

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = torrents.filter((torrent) => {
      if (filter.kind === 'status' && !matchesStatus(torrent, filter.value)) return false;
      if (filter.kind === 'label' && torrent.label !== filter.value) return false;
      if (filter.kind === 'tracker' && trackerHosts[torrent.hash] !== filter.value) return false;
      if (needle && !torrent.name.toLowerCase().includes(needle) && !torrent.hash.toLowerCase().includes(needle))
        return false;
      return true;
    });
    return sortTorrents(filtered, sort);
  }, [torrents, filter, search, sort, trackerHosts]);

  const byHash = useMemo(() => {
    const map = new Map<string, Torrent>();
    for (const torrent of torrents) map.set(torrent.hash, torrent);
    return map;
  }, [torrents]);

  const focusedTorrent = focused ? (byHash.get(focused) ?? null) : null;
  const selectedHashes = useMemo(
    () => [...selected].filter((hash) => byHash.has(hash)),
    [selected, byHash],
  );
  const targets = selectedHashes.length > 0 ? selectedHashes : focused ? [focused] : [];

  /* ------------------------------ selection ---------------------------- */

  const onSelect = useCallback(
    (hash: string, mods: SelectMods) => {
      setFocused(hash);
      setSelected((current) => {
        const next = new Set(current);
        if (mods.shift && lastAnchor.current) {
          const from = visible.findIndex((t) => t.hash === lastAnchor.current);
          const to = visible.findIndex((t) => t.hash === hash);
          if (from >= 0 && to >= 0) {
            const [start, end] = from < to ? [from, to] : [to, from];
            for (let i = start; i <= end; i++) next.add(visible[i].hash);
            return next;
          }
        }
        if (mods.ctrl) {
          if (next.has(hash)) next.delete(hash);
          else next.add(hash);
          lastAnchor.current = hash;
          return next;
        }
        lastAnchor.current = hash;
        return new Set([hash]);
      });
    },
    [visible],
  );

  const onSelectAll = useCallback(
    (checked: boolean) => {
      setSelected(checked ? new Set(visible.map((torrent) => torrent.hash)) : new Set());
    },
    [visible],
  );

  /* ------------------------------- actions ----------------------------- */

  const runAction = useCallback(
    async (action: string, hashes: string[] = targets) => {
      if (hashes.length === 0) return;
      try {
        const result = await api.bulkAction(hashes, action);
        for (const error of result.errors) toast.push('error', error);
        await refresh();
      } catch (error) {
        toast.error(error);
      }
    },
    [targets, refresh, toast],
  );

  const removeTorrents = useCallback(
    async (deleteData: boolean, hashes: string[] = targets) => {
      if (hashes.length === 0) return;
      const names = hashes
        .map((hash) => byHash.get(hash)?.name ?? hash)
        .slice(0, 5)
        .join('\n  ');
      const suffix = hashes.length > 5 ? `\n  …and ${hashes.length - 5} more` : '';
      const question = deleteData
        ? `Remove ${hashes.length} torrent(s) AND delete their downloaded data?\n\n  ${names}${suffix}\n\nThis cannot be undone.`
        : `Remove ${hashes.length} torrent(s) from rtorrent? Downloaded data is kept.\n\n  ${names}${suffix}`;
      if (!window.confirm(question)) return;
      try {
        const result = await api.remove(hashes, deleteData);
        for (const error of result.errors) toast.push('error', error);
        if (result.errors.length === 0) {
          toast.push('success', `Removed ${hashes.length} torrent(s)`);
        }
        setSelected(new Set());
        setFocused(null);
        await refresh();
      } catch (error) {
        toast.error(error);
      }
    },
    [targets, byHash, refresh, toast],
  );

  const patchTorrents = useCallback(
    async (patch: Record<string, unknown>, hashes: string[] = targets) => {
      try {
        for (const hash of hashes) await api.patch(hash, patch);
        await refresh();
      } catch (error) {
        toast.error(error);
      }
    },
    [targets, refresh, toast],
  );

  const promptLabel = useCallback(() => {
    const current = focusedTorrent?.label ?? '';
    const label = window.prompt('Label (empty to clear):', current);
    if (label === null) return;
    void patchTorrents({ label });
  }, [focusedTorrent, patchTorrents]);

  const promptDirectory = useCallback(() => {
    const current = focusedTorrent?.directory ?? '';
    const directory = window.prompt(
      'Move to directory (rtorrent updates the session; move the files yourself if already downloaded):',
      current,
    );
    if (!directory) return;
    void patchTorrents({ directory });
  }, [focusedTorrent, patchTorrents]);

  /* ----------------------------- keyboard ------------------------------ */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === 'Delete') {
        void removeTorrents(event.shiftKey);
      } else if (event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        onSelectAll(true);
      } else if (event.key === 'Escape') {
        setSelected(new Set());
        setMenu(null);
      } else if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey) {
        setDialog('add');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [removeTorrents, onSelectAll]);

  /* ------------------------------- render ------------------------------ */

  const onSort = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'name' || key === 'label' ? 'asc' : 'desc' },
    );

  const onContextMenu = (hash: string, event: MouseEvent) => {
    event.preventDefault();
    if (!selected.has(hash)) {
      setSelected(new Set([hash]));
      lastAnchor.current = hash;
    }
    setFocused(hash);
    setMenu({ x: event.clientX, y: event.clientY, hash });
  };

  const labels = useMemo(
    () => [...new Set(torrents.map((torrent) => torrent.label).filter(Boolean))].sort(),
    [torrents],
  );

  const menuTargets = menu ? (selected.has(menu.hash) ? selectedHashes : [menu.hash]) : [];

  return (
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(event) => carriesFiles(event) && event.preventDefault()}
      onDrop={onDropFiles}
    >
      <Header
        status={status}
        game={game}
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        onAdd={() => setDialog('add')}
        onSettings={() => setDialog('settings')}
        onThrottles={() => setDialog('throttles')}
        onConsole={() => setDialog('console')}
        onProgress={() => setDialog('progress')}
      />

      <Sidebar
        torrents={torrents}
        status={status}
        filter={filter}
        onFilter={setFilter}
        trackerHosts={trackerHosts}
      />

      <main className="main">
        {connectionError && (
          <div className="banner">
            <IconAlert size={15} />
            <span>{connectionError}</span>
            <button className="btn sm ghost" onClick={() => void refresh()}>
              <IconRefresh size={13} />
              Retry
            </button>
          </div>
        )}

        <div className="toolbar">
          <button className="btn sm" onClick={() => void runAction('start')} disabled={targets.length === 0}>
            <IconPlay size={12} />
            Start
          </button>
          <button className="btn sm" onClick={() => void runAction('pause')} disabled={targets.length === 0}>
            <IconPause size={13} />
            Pause
          </button>
          <button className="btn sm" onClick={() => void runAction('stop')} disabled={targets.length === 0}>
            <IconStop size={12} />
            Stop
          </button>
          <button
            className="btn sm danger"
            onClick={() => void removeTorrents(false)}
            disabled={targets.length === 0}
          >
            <IconTrash size={13} />
            Remove
          </button>

          <div className="divider" />

          <button className="btn sm" onClick={() => void runAction('recheck')} disabled={targets.length === 0}>
            <IconRefresh size={13} />
            Recheck
          </button>
          <button className="btn sm" onClick={promptLabel} disabled={targets.length === 0}>
            <IconTag size={13} />
            Label
          </button>

          {targets.length > 0 && (
            <span className="selection-pill">
              {targets.length} selected
              <button
                className="btn sm ghost"
                style={{ height: 18, padding: '0 4px' }}
                onClick={() => setSelected(new Set())}
              >
                clear
              </button>
            </span>
          )}

          <div className="header-spacer" />

          <button className="btn sm" onClick={() => setDialog('log')} title="rtorrent log">
            <IconList size={13} />
            Log
          </button>

          <div className="search">
            <IconSearch size={14} />
            <input
              className="input"
              placeholder="Search torrents…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>

        <TorrentTable
          torrents={visible}
          selected={selected}
          focused={focused}
          sort={sort}
          onSort={onSort}
          onSelect={onSelect}
          onSelectAll={onSelectAll}
          onContextMenu={onContextMenu}
          emptyHint={
            torrents.length === 0
              ? 'Add a .torrent file or magnet link to get started.'
              : 'No torrents match the current filter.'
          }
        />

        {focusedTorrent && (
          <DetailPanel
            torrent={focusedTorrent}
            height={detailHeight}
            onHeightChange={setDetailHeight}
            onClose={() => setFocused(null)}
          />
        )}
      </main>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem
            icon={<IconPlay size={13} />}
            label="Start"
            onClick={() => {
              setMenu(null);
              void runAction('start', menuTargets);
            }}
          />
          <MenuItem
            icon={<IconPause size={13} />}
            label="Pause"
            onClick={() => {
              setMenu(null);
              void runAction('pause', menuTargets);
            }}
          />
          <MenuItem
            icon={<IconStop size={12} />}
            label="Stop"
            onClick={() => {
              setMenu(null);
              void runAction('stop', menuTargets);
            }}
          />
          <MenuItem
            icon={<IconRefresh size={13} />}
            label="Force recheck"
            onClick={() => {
              setMenu(null);
              void runAction('recheck', menuTargets);
            }}
          />
          <MenuItem
            icon={<IconRefresh size={13} />}
            label="Announce to trackers"
            onClick={() => {
              setMenu(null);
              void runAction('announce', menuTargets);
            }}
          />
          <hr />
          <div className="heading">Priority</div>
          {[
            [3, 'High'],
            [2, 'Normal'],
            [1, 'Low'],
            [0, 'Off'],
          ].map(([value, label]) => (
            <MenuItem
              key={String(value)}
              label={label as string}
              onClick={() => {
                setMenu(null);
                void patchTorrents({ priority: value }, menuTargets);
              }}
            />
          ))}
          <hr />
          <div className="heading">Throttle group</div>
          <MenuItem
            icon={<IconGauge size={13} />}
            label="Global (none)"
            onClick={() => {
              setMenu(null);
              void patchTorrents({ throttle: '' }, menuTargets);
            }}
          />
          {throttles.map((group) => (
            <MenuItem
              key={group.name}
              icon={<IconGauge size={13} />}
              label={group.name}
              onClick={() => {
                setMenu(null);
                void patchTorrents({ throttle: group.name }, menuTargets);
              }}
            />
          ))}
          <hr />
          <MenuItem
            icon={<IconTag size={13} />}
            label="Set label…"
            onClick={() => {
              setMenu(null);
              promptLabel();
            }}
          />
          <MenuItem
            icon={<IconMove size={13} />}
            label="Change directory…"
            onClick={() => {
              setMenu(null);
              promptDirectory();
            }}
          />
          <hr />
          <MenuItem
            icon={<IconTrash size={13} />}
            label="Remove torrent"
            onClick={() => {
              setMenu(null);
              void removeTorrents(false, menuTargets);
            }}
          />
          <MenuItem
            icon={<IconTrash size={13} />}
            label="Remove + delete data"
            danger
            onClick={() => {
              setMenu(null);
              void removeTorrents(true, menuTargets);
            }}
          />
        </ContextMenu>
      )}

      {dropping && (
        <div className="drop-overlay">
          <div className="drop-card">
            <IconUpload size={30} />
            <strong>Drop to add torrents</strong>
            <span>.torrent files only</span>
          </div>
        </div>
      )}

      <Celebrate trigger={celebration} onDone={() => setCelebration(0)} />

      {dialog === 'add' && (
        <AddDialog
          onClose={() => {
            setDialog(null);
            setPendingFiles([]);
          }}
          onAdded={() => void refresh()}
          defaultDirectory={''}
          labels={labels}
          initialFiles={pendingFiles}
        />
      )}
      {dialog === 'progress' && game && (
        <AchievementsDialog game={game} onClose={() => setDialog(null)} />
      )}
      {dialog === 'settings' && (
        <SettingsDialog onClose={() => setDialog(null)} backend={status?.backend ?? null} />
      )}
      {dialog === 'throttles' && (
        <ThrottleDialog onClose={() => setDialog(null)} backend={status?.backend ?? null} />
      )}
      {dialog === 'console' && <RpcConsole onClose={() => setDialog(null)} />}
      {dialog === 'log' && <LogDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
