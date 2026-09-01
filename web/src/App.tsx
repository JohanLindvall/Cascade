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
import { DropBurst, type Burst } from './components/DropBurst';
import { DetailPanel } from './components/DetailPanel';
import { Header } from './components/Header';
import { LogDialog } from './components/LogDialog';
import { RpcConsole } from './components/RpcConsole';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar, type ToolId } from './components/Sidebar';
import { ThrottleDialog } from './components/ThrottleDialog';
import { TorrentMenu, type MenuActions } from './components/TorrentMenu';
import { SORT_OPTIONS, TorrentTable, type SelectMods } from './components/TorrentTable';
import { useDialogs } from './components/dialogs';
import {
  IconAlert,
  IconFilter,
  IconList,
  IconPause,
  IconPlay,
  IconRefresh,
  IconSearch,
  IconStop,
  IconTag,
  IconTrash,
  IconUpload,
} from './components/icons';
import { useToast } from './components/ui';
import { acceptTorrents } from './files';
import { filterTorrents, type Filter } from './filter';
import { grimAchievement, grimGame } from './grim';
import { COMPACT_QUERY, useMediaQuery } from './useMediaQuery';
import {
  fetchPreferences,
  readCache,
  savePreferences,
  type Preferences,
} from './prefs';
import { defaultSortDir, sortTorrents, type SortKey, type SortState } from './sort';
import { applyTheme, fxFlavor, resolveTheme, type ResolvedTheme, type ThemeMode } from './theme';
import type { GameState, GlobalStatus, ThrottleGroup, Torrent } from './types';

type Dialog = 'add' | 'settings' | 'throttles' | 'console' | 'log' | 'progress' | null;

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
  const [sort, setSort] = useState<SortState>(() => {
    const cached = readCache();
    return { key: cached.sortKey, dir: cached.sortDir };
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [detailHeight, setDetailHeight] = useState(() => readCache().detailHeight);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dropping, setDropping] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [celebration, setCelebration] = useState(0);
  const [burst, setBurst] = useState<Burst | null>(null);
  const burstId = useRef(0);
  // Seeded from the cache so the first paint is already themed, then replaced
  // by whatever the server's preferences file says.
  const [prefs, setPrefs] = useState<Preferences>(() => readCache());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(readCache().theme),
  );
  const themeMode = prefs.theme;
  const grim = resolvedTheme === 'blackmetal';
  const flavor = fxFlavor(resolvedTheme);

  const toast = useToast();
  const dialogs = useDialogs();
  const compact = useMediaQuery(COMPACT_QUERY);
  const searchRef = useRef<HTMLInputElement>(null);
  const lastAnchor = useRef<string | null>(null);
  const dragDepth = useRef(0);
  const completedRef = useRef<Set<string> | null>(null);
  const seenBadgesRef = useRef<string[] | null>(null);
  // Read by badge toasts without re-subscribing the poll to theme changes.
  const grimRef = useRef(grim);
  grimRef.current = grim;
  // Any modal — the app's own dialogs or a confirm/prompt — takes the keyboard.
  const modalOpen = dialog !== null || dialogs.open;

  // The black metal theme re-carves the gamification copy; the server's ids
  // and progress stay canonical, so switching themes never changes what is
  // earned.
  const displayGame = useMemo(() => (game && grim ? grimGame(game) : game), [game, grim]);

  const clearBurst = useCallback(() => setBurst(null), []);
  const clearCelebration = useCallback(() => setCelebration(0), []);

  const updatePrefs = useCallback((patch: Partial<Preferences>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      savePreferences(patch, current);
      return next;
    });
  }, []);

  useEffect(() => {
    fetchPreferences()
      .then((stored) => {
        setPrefs(stored);
        seenBadgesRef.current = stored.seenBadges;
        setSort({ key: stored.sortKey, dir: stored.sortDir });
        setDetailHeight(stored.detailHeight);
      })
      .catch(() => {
        seenBadgesRef.current = readCache().seenBadges;
      });
  }, []);

  useEffect(() => {
    setResolvedTheme(applyTheme(themeMode));
    if (themeMode !== 'system') return;
    // Follow the OS while "system" is selected.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setResolvedTheme(applyTheme('system'));
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [themeMode]);

  /* ------------------------------ polling ------------------------------ */

  /** Toast badges the user has not been told about yet. */
  const announceBadges = useCallback(
    (state: GameState | null | undefined) => {
      if (!state?.enabled) return;
      const seen = seenBadgesRef.current;
      if (seen === null) return; // Preferences have not loaded yet.
      const earned = state.achievements.filter((item) => item.unlockedAt !== null);
      const fresh = earned.filter((item) => !seen.includes(item.id));
      if (fresh.length === 0) return;
      const ids = earned.map((item) => item.id);
      seenBadgesRef.current = ids;
      // A first run against an established session can earn several at once;
      // record the baseline quietly rather than firing a wall of toasts.
      if (seen.length === 0 && fresh.length > 2) {
        updatePrefs({ seenBadges: ids });
        return;
      }
      for (const item of fresh) {
        const shown = grimRef.current ? grimAchievement(item) : item;
        toast.push(
          'achievement',
          `${grimRef.current ? 'Sigil earned' : 'Badge unlocked'} — ${shown.title}: ${shown.description}`,
        );
      }
      updatePrefs({ seenBadges: ids });
    },
    [toast, updatePrefs],
  );

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
        if (fresh.length > 0) {
          // The toast is plain feedback and fires for everyone; only the
          // confetti belongs to the gamification layer and its flag.
          if (state.game?.enabled) setCelebration((value) => value + 1);
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
      setConnectionError(
        state.status.connected ? null : (state.status.error ?? 'rtorrent is not responding'),
      );
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }, [announceBadges, toast]);

  // Poll by chaining timeouts: a slow response never stacks requests, and a
  // hidden tab stops polling entirely until it becomes visible again.
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const tick = async () => {
      if (!document.hidden) await refresh();
      if (alive) timer = window.setTimeout(() => void tick(), REFRESH_MS);
    };
    void tick();
    const onVisible = () => {
      if (!document.hidden && alive) {
        window.clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
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

  /* --------------------------- drag and drop ---------------------------- */

  /**
   * Whether a drag is carrying something droppable: files, or a link — which
   * is how a magnet arrives when dragged out of another tab. Some sources
   * populate dataTransfer.items without advertising the "Files" type, so
   * both are checked. Plain text selections are left out on purpose: they
   * would light the overlay for drags that can never add anything.
   */
  const carriesPayload = (event: DragEvent): boolean => {
    const transfer = event.dataTransfer;
    if (!transfer) return false;
    const types = Array.from(transfer.types ?? []);
    if (types.includes('Files') || types.includes('text/uri-list')) return true;
    return Array.from(transfer.items ?? []).some((item) => item.kind === 'file');
  };

  const onDragEnter = (event: DragEvent) => {
    if (!carriesPayload(event)) return;
    dragDepth.current += 1;
    setDropping(true);
  };

  const onDragLeave = (event: DragEvent) => {
    if (!carriesPayload(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropping(false);
  };

  /**
   * Always cancel the default action while a drag is over the app. Without
   * this the browser handles any drop it does not recognise by navigating to
   * the dropped file, which throws the UI away mid-drop.
   */
  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  const submitDrop = useCallback(
    async (form: FormData) => {
      try {
        const result = await api.upload(form);
        for (const error of result.errors) toast.push('error', error);
        if (result.added > 0) await refresh();
      } catch (error) {
        toast.error(error);
      }
    },
    [refresh, toast],
  );

  const addDropped = useCallback(
    async (files: File[]) => {
      const form = new FormData();
      for (const file of files) form.append('torrents', file);
      form.append('start', '1');
      await submitDrop(form);
    },
    [submitDrop],
  );

  const addDroppedLinks = useCallback(
    async (links: string[]) => {
      const form = new FormData();
      form.append('urls', links.join('\n'));
      form.append('start', '1');
      await submitDrop(form);
    },
    [submitDrop],
  );

  const onDropFiles = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    // The Add dialog stages its own drops (its dropzone stops propagation, so
    // this handler only ever sees the ones that missed it) — say where the
    // file should land instead of swallowing the drop without a trace, which
    // read as dragging being broken. Any other dialog has no stake in a
    // drop: the file is handled exactly as if nothing were open.
    if (dialog === 'add') {
      toast.push('info', 'Drop it on the dialog’s dropzone — or close the dialog to add it straight away.');
      return;
    }

    const transfer = event.dataTransfer;
    const dropped = Array.from(transfer?.files ?? []);
    const { accepted, ignored } = acceptTorrents(dropped);
    if (ignored) toast.push('info', ignored);

    if (accepted.length > 0) {
      setBurst({ id: ++burstId.current, x: event.clientX, y: event.clientY, count: accepted.length });
      void addDropped(accepted);
      return;
    }
    if (dropped.length > 0) return; // Only non-torrents: already said so.

    // No file payload: a link may still be droppable, which is how magnets
    // arrive when dragged out of a browser.
    const text = (
      transfer?.getData('text/uri-list') ||
      transfer?.getData('text/plain') ||
      ''
    ).trim();
    const links = text
      .split(/\s+/)
      .filter((line) => /^(magnet:|https?:)/i.test(line));

    if (links.length > 0) {
      setBurst({ id: ++burstId.current, x: event.clientX, y: event.clientY, count: links.length });
      void addDroppedLinks(links);
      return;
    }

    if (/^file:/i.test(text)) {
      toast.push(
        'error',
        'Your file manager passed the path rather than the file itself, which the browser is not allowed to read. Use the Add torrent button and pick the file, or drag it from a different file manager.',
      );
      return;
    }
    // Anything else, including a drop carrying nothing at all, has to say so:
    // a drop that quietly does nothing looks exactly like a broken torrent.
    toast.push(
      'info',
      text
        ? 'Nothing to add — drop .torrent files, magnet links or URLs.'
        : 'That drop carried no file or link the browser could read — use the Add torrent button instead.',
    );
  };

  /* ------------------------------ filtering ---------------------------- */

  const visible = useMemo(
    () => sortTorrents(filterTorrents(torrents, filter, search, trackerHosts), sort),
    [torrents, filter, search, sort, trackerHosts],
  );

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

  const labels = useMemo(
    () => [...new Set(torrents.map((torrent) => torrent.label).filter(Boolean))].sort(),
    [torrents],
  );

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
    async (action: string, hashes: string[] = targets): Promise<boolean> => {
      if (hashes.length === 0) return false;
      try {
        const result = await api.bulkAction(hashes, action);
        for (const error of result.errors) toast.push('error', error);
        await refresh();
        return result.errors.length === 0;
      } catch (error) {
        toast.error(error);
        return false;
      }
    },
    [targets, refresh, toast],
  );

  /**
   * Recheck, then start again the moment the check completes — the way out
   * of "registered as completed, but hash check returned unfinished
   * chunks", which a plain recheck leaves stopped. The server watches the
   * check end; the toast says so, or the silence afterwards reads as a
   * button that did nothing.
   */
  const recheckRestart = useCallback(
    async (hashes: string[] = targets) => {
      if (hashes.length === 0) return;
      if (!(await runAction('recheck-restart', hashes))) return; // errors already toasted
      toast.push(
        'info',
        `Rechecking ${hashes.length === 1 ? 'torrent' : `${hashes.length} torrents`} — starting again when the check completes`,
      );
    },
    [targets, runAction, toast],
  );

  const removeTorrents = useCallback(
    async (deleteData: boolean, hashes: string[] = targets) => {
      if (hashes.length === 0) return;
      const count = hashes.length === 1 ? 'this torrent' : `these ${hashes.length} torrents`;
      const ok = await dialogs.confirm({
        title: deleteData ? 'Remove and delete data' : 'Remove torrent',
        message: deleteData
          ? `Remove ${count} from rtorrent and delete the downloaded data? This cannot be undone.`
          : `Remove ${count} from rtorrent? The downloaded data is kept.`,
        items: hashes.map((hash) => byHash.get(hash)?.name ?? hash),
        confirmLabel: deleteData ? 'Remove and delete' : 'Remove',
        danger: deleteData,
      });
      if (!ok) return;
      try {
        const result = await api.remove(hashes, deleteData);
        for (const error of result.errors) toast.push('error', error);
        if (result.errors.length === 0) {
          toast.push('success', `Removed ${hashes.length} torrent${hashes.length === 1 ? '' : 's'}`);
        }
        setSelected(new Set());
        setFocused(null);
        await refresh();
      } catch (error) {
        toast.error(error);
      }
    },
    [targets, byHash, dialogs, refresh, toast],
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

  const promptLabel = useCallback(async () => {
    const label = await dialogs.prompt({
      title: 'Set label',
      label: 'Label',
      message: 'Leave it empty to clear the label.',
      initial: focusedTorrent?.label ?? '',
      placeholder: 'none',
      suggestions: labels,
      confirmLabel: 'Apply',
    });
    if (label === null) return;
    void patchTorrents({ label: label.trim() });
  }, [dialogs, focusedTorrent, labels, patchTorrents]);

  const promptDirectory = useCallback(async () => {
    const directory = await dialogs.prompt({
      title: 'Change directory',
      label: 'Directory',
      message:
        'rtorrent updates its session only — move the files yourself if they are already downloaded, or recheck afterwards.',
      initial: focusedTorrent?.directory ?? '',
      placeholder: status?.downloadDir || '/downloads',
      confirmLabel: 'Move',
    });
    if (!directory?.trim()) return;
    void patchTorrents({ directory: directory.trim() });
  }, [dialogs, focusedTorrent, status?.downloadDir, patchTorrents]);

  const copyMagnets = useCallback(
    async (hashes: string[]) => {
      const links = hashes.map((hash) => {
        const name = byHash.get(hash)?.name;
        return `magnet:?xt=urn:btih:${hash.toLowerCase()}${name ? `&dn=${encodeURIComponent(name)}` : ''}`;
      });
      try {
        await copyToClipboard(links.join('\n'));
        toast.push('success', `Copied ${links.length === 1 ? 'magnet link' : `${links.length} magnet links`}`);
      } catch {
        toast.push('error', 'Could not write to the clipboard');
      }
    },
    [byHash, toast],
  );

  const menuActions: MenuActions = {
    run: (action, hashes) => void runAction(action, hashes),
    recheckRestart: (hashes) => void recheckRestart(hashes),
    patch: (patch, hashes) => void patchTorrents(patch, hashes),
    setLabel: () => void promptLabel(),
    changeDirectory: () => void promptDirectory(),
    copyMagnets: (hashes) => void copyMagnets(hashes),
    remove: (deleteData, hashes) => void removeTorrents(deleteData, hashes),
  };

  /* ----------------------------- keyboard ------------------------------ */

  // A drop that lands outside the app element would otherwise make the browser
  // navigate to the file, discarding the UI.
  useEffect(() => {
    const block = (event: globalThis.DragEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea')) return;
      event.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  // The drawer only exists in the compact layout.
  useEffect(() => {
    if (!compact) setDrawerOpen(false);
  }, [compact]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // With anything modal open the keyboard is its: Escape closes it (the
      // modal listens for itself) and must not also clear the selection
      // behind it, and Delete must not stack a second confirmation.
      if (modalOpen) return;
      if (event.key === 'Delete') {
        void removeTorrents(event.shiftKey);
      } else if (event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        onSelectAll(true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (visible.length === 0) return;
        event.preventDefault();
        const index = focused ? visible.findIndex((t) => t.hash === focused) : -1;
        const next =
          event.key === 'ArrowDown'
            ? Math.min(visible.length - 1, index + 1)
            : Math.max(0, index < 0 ? 0 : index - 1);
        const hash = visible[next].hash;
        setFocused(hash);
        setSelected(new Set([hash]));
        lastAnchor.current = hash;
        document
          .querySelector(`[data-hash="${hash}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === 'Escape') {
        setSelected(new Set());
        setFocused(null);
        setMenu(null);
        setDrawerOpen(false);
      } else if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey) {
        setDialog('add');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [removeTorrents, onSelectAll, visible, focused, modalOpen]);

  /* ------------------------------- render ------------------------------ */

  const applySort = (next: SortState) => {
    updatePrefs({ sortKey: next.key, sortDir: next.dir });
    setSort(next);
  };

  /** A header click: flip the direction on the sorted column, open another with its default. */
  const onSort = (key: SortKey) =>
    applySort(
      sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultSortDir(key) },
    );

  /** The compact layout's dropdown: pick a column, keeping the direction if it is the same one. */
  const onSortKey = (key: SortKey) =>
    applySort({ key, dir: sort.key === key ? sort.dir : defaultSortDir(key) });

  const onDetailHeight = (height: number) => {
    setDetailHeight(height);
    updatePrefs({ detailHeight: height });
  };

  const onContextMenu = (hash: string, event: MouseEvent) => {
    event.preventDefault();
    if (!selected.has(hash)) {
      setSelected(new Set([hash]));
      lastAnchor.current = hash;
    }
    setFocused(hash);
    setMenu({ x: event.clientX, y: event.clientY, hash });
  };

  const openTool = (tool: ToolId) => {
    setDrawerOpen(false);
    setDialog(tool);
  };

  const menuTargets = menu ? (selected.has(menu.hash) ? selectedHashes : [menu.hash]) : [];

  return (
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDropFiles}
    >
      <Header
        status={status}
        game={displayGame}
        themeMode={themeMode}
        resolvedTheme={resolvedTheme}
        onThemeChange={(mode: ThemeMode) => updatePrefs({ theme: mode })}
        onAdd={() => setDialog('add')}
        onSettings={() => setDialog('settings')}
        onThrottles={() => setDialog('throttles')}
        onConsole={() => setDialog('console')}
        onProgress={() => setDialog('progress')}
      />

      {drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} />}
      <Sidebar
        className={drawerOpen ? 'open' : ''}
        torrents={torrents}
        status={status}
        filter={filter}
        onFilter={(value) => {
          setFilter(value);
          setDrawerOpen(false);
        }}
        trackerHosts={trackerHosts}
        compact={compact}
        onTool={openTool}
        showProgress={!!game?.enabled}
      />

      <main className="main">
        {connectionError && (
          <div className="banner">
            <IconAlert size={15} />
            <span>{connectionError}</span>
            <button className="btn sm ghost" onClick={() => void refresh()}>
              <IconRefresh size={13} />
              <span>Retry</span>
            </button>
          </div>
        )}

        <div className="toolbar">
          <button
            className="btn sm compact-only"
            onClick={() => setDrawerOpen((value) => !value)}
            title="Filters"
            aria-label="Filters"
          >
            <IconFilter size={14} />
          </button>
          <button className="btn sm" onClick={() => void runAction('start')} disabled={targets.length === 0}>
            <IconPlay size={12} />
            <span>Start</span>
          </button>
          <button className="btn sm" onClick={() => void runAction('pause')} disabled={targets.length === 0}>
            <IconPause size={13} />
            <span>Pause</span>
          </button>
          <button className="btn sm" onClick={() => void runAction('stop')} disabled={targets.length === 0}>
            <IconStop size={12} />
            <span>Stop</span>
          </button>
          <button
            className="btn sm danger"
            onClick={() => void removeTorrents(false)}
            disabled={targets.length === 0}
          >
            <IconTrash size={13} />
            <span>Remove</span>
          </button>

          <div className="divider" />

          <button className="btn sm" onClick={() => void runAction('recheck')} disabled={targets.length === 0}>
            <IconRefresh size={13} />
            <span>Recheck</span>
          </button>
          <button className="btn sm" onClick={() => void promptLabel()} disabled={targets.length === 0}>
            <IconTag size={13} />
            <span>Label</span>
          </button>

          {compact && (
            <>
              <select
                className="select sort-select"
                value={sort.key}
                aria-label="Sort by"
                onChange={(event) => onSortKey(event.target.value as SortKey)}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                className="btn sm"
                onClick={() => applySort({ key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
                aria-label="Sort direction"
                title="Sort direction"
              >
                {sort.dir === 'asc' ? '▲' : '▼'}
              </button>
            </>
          )}

          {targets.length > 0 && (
            <span className="selection-pill">
              {targets.length} selected
              <button className="btn sm ghost pill-clear" onClick={() => setSelected(new Set())}>
                clear
              </button>
            </span>
          )}

          <div className="header-spacer" />

          <button className="btn sm" onClick={() => setDialog('log')} title="rtorrent log">
            <IconList size={13} />
            <span>Log</span>
          </button>

          <div className="search">
            <IconSearch size={14} />
            <input
              ref={searchRef}
              className="input"
              placeholder="Search torrents… ( / )"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>

        <TorrentTable
          compact={compact}
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
            onHeightChange={onDetailHeight}
            onClose={() => setFocused(null)}
          />
        )}
      </main>

      {menu && (
        <TorrentMenu
          x={menu.x}
          y={menu.y}
          targets={menuTargets}
          throttles={throttles}
          actions={menuActions}
          onClose={() => setMenu(null)}
        />
      )}

      {dropping && (
        <div className="drop-overlay">
          <div className="drop-card">
            <IconUpload size={30} />
            <strong>Drop to add</strong>
            <span>.torrent files, magnet links and URLs start immediately</span>
          </div>
        </div>
      )}

      <Celebrate trigger={celebration} flavor={flavor} onDone={clearCelebration} />
      <DropBurst burst={burst} flavor={flavor} onDone={clearBurst} />

      {dialog === 'add' && (
        <AddDialog
          onClose={() => setDialog(null)}
          onAdded={() => void refresh()}
          defaultDirectory={status?.downloadDir ?? ''}
          labels={labels}
        />
      )}
      {dialog === 'progress' && displayGame && (
        <AchievementsDialog game={displayGame} grim={grim} onClose={() => setDialog(null)} />
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

/** Clipboard write with a fallback for non-secure (plain http) origins. */
function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand('copy')) return Promise.reject(new Error('copy rejected'));
  } finally {
    area.remove();
  }
  return Promise.resolve();
}
