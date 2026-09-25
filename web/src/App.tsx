import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { api, type BulkResult } from './api';
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
import { SORT_OPTIONS, TorrentTable } from './components/TorrentTable';
import { useDialogs } from './components/dialogs';
import {
  IconAlert,
  IconClose,
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
import { acceptTorrents, dropText, droppedFiles, linksFromDrop } from './files';
import { filterTorrents, type Filter } from './filter';
import { magnetLink, nameErrors } from './format';
import { grimAchievement, grimGame } from './grim';
import { useLatest, usePolling } from './hooks';
import { fetchPreferences, readCache, savePreferences, type Preferences } from './prefs';
import {
  EMPTY_SELECTION,
  actionTargets,
  hiddenSelected,
  selectOnly,
  selectRow,
  stepRow,
  type SelectMods,
  type Selection,
} from './selection';
import { defaultSortDir, sortTorrents, type SortKey, type SortState } from './sort';
import { applyTheme, fxFlavor, resolveTheme, type ResolvedTheme, type ThemeMode } from './theme';
import type { GameState, GlobalStatus, ThrottleGroup, Torrent } from './types';
import { COMPACT_QUERY, useMediaQuery } from './useMediaQuery';

type Dialog = 'add' | 'settings' | 'throttles' | 'console' | 'log' | 'progress' | null;

interface MenuState {
  x: number;
  y: number;
  /** The row the menu was opened on. */
  hash: string;
}

const REFRESH_MS = 1500;

/** Fields that take typing, and dropped text, for themselves. A checkbox does not. */
const TEXT_ENTRY =
  'textarea, select, [contenteditable]:not([contenteditable="false"]), ' +
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])';

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TEXT_ENTRY) !== null;
}

const NO_DATA_DELETE =
  'Deleting data is switched off on this server (CASCADE_ALLOW_DATA_DELETE) — Delete alone removes the torrent and keeps its data.';

export function App() {
  const [torrents, setTorrents] = useState<Torrent[]>([]);
  const [status, setStatus] = useState<GlobalStatus | null>(null);
  const [throttles, setThrottles] = useState<ThrottleGroup[]>([]);
  const [game, setGame] = useState<GameState | null>(null);
  const [trackerHosts, setTrackerHosts] = useState<Record<string, string>>({});
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const [filter, setFilter] = useState<Filter>({ kind: 'status', value: 'all' });
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [focused, setFocused] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dropping, setDropping] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [celebration, setCelebration] = useState(0);
  const [burst, setBurst] = useState<Burst | null>(null);
  const burstId = useRef(0);
  // Seeded from the cache so the first paint is already themed, then replaced
  // by whatever the server's preferences file says. Sort order and the detail
  // pane's height are read from here too, rather than mirrored into state.
  const [prefs, setPrefs] = useState<Preferences>(readCache);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(prefs.theme));
  const themeMode = prefs.theme;
  const sort = useMemo<SortState>(() => ({ key: prefs.sortKey, dir: prefs.sortDir }), [prefs.sortKey, prefs.sortDir]);
  const grim = resolvedTheme === 'blackmetal';
  const flavor = fxFlavor(resolvedTheme);
  const supports = status?.backend.supports;
  const policy = status?.policy;

  const toast = useToast();
  const dialogs = useDialogs();
  const compact = useMediaQuery(COMPACT_QUERY);
  const searchRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const completedRef = useRef<Set<string> | null>(null);
  const seenBadgesRef = useRef<string[] | null>(null);
  // Read by badge toasts without re-subscribing the poll to theme changes.
  const grimRef = useLatest(grim);
  // A refresh after an action and the poll's own tick can be in flight
  // together; an answer older than the one on screen is dropped, or the
  // pre-action state would flash back until the next tick.
  const stateSeq = useRef({ issued: 0, shown: 0 });
  // Any modal — the app's own dialogs or a confirm/prompt — takes the keyboard.
  const modalOpen = dialog !== null || dialogs.open;

  // The black metal theme re-carves the gamification copy; the server's ids
  // and progress stay canonical, so switching themes never changes what is
  // earned.
  const displayGame = useMemo(() => (game && grim ? grimGame(game) : game), [game, grim]);

  const clearBurst = useCallback(() => setBurst(null), []);
  const clearCelebration = useCallback(() => setCelebration(0), []);

  const updatePrefs = useCallback((patch: Partial<Preferences>) => {
    setPrefs((current) => ({ ...current, ...patch }));
    savePreferences(patch);
  }, []);

  useEffect(() => {
    fetchPreferences()
      .then((stored) => {
        setPrefs(stored);
        seenBadgesRef.current = stored.seenBadges;
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
    [grimRef, toast, updatePrefs],
  );

  const refresh = useCallback(async () => {
    const seq = ++stateSeq.current.issued;
    /** Whether a newer answer is already on screen; if not, this one takes its place. */
    const superseded = () => {
      if (seq < stateSeq.current.shown) return true;
      stateSeq.current.shown = seq;
      return false;
    };
    try {
      const state = await api.state();
      if (superseded()) return;

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
      if (superseded()) return;
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }, [announceBadges, toast]);

  usePolling(refresh, REFRESH_MS);

  // Tracker hosts change rarely; refresh them only when the torrent set changes.
  const hashKey = torrents.map((torrent) => torrent.hash).join(',');
  useEffect(() => {
    const hashes = hashKey ? hashKey.split(',') : [];
    if (hashes.length === 0) {
      setTrackerHosts({});
      return;
    }
    let current = true;
    api
      .trackerHosts(hashes)
      .then((hosts) => {
        if (current) setTrackerHosts(hosts);
      })
      .catch(() => {
        /* tracker grouping is cosmetic; ignore failures */
      });
    return () => {
      current = false;
    };
  }, [hashKey]);

  /* ------------------------------ filtering ---------------------------- */

  const visible = useMemo(
    () => sortTorrents(filterTorrents(torrents, filter, search, trackerHosts), sort),
    [torrents, filter, search, sort, trackerHosts],
  );
  const order = useMemo(() => visible.map((torrent) => torrent.hash), [visible]);

  const byHash = useMemo(() => {
    const map = new Map<string, Torrent>();
    for (const torrent of torrents) map.set(torrent.hash, torrent);
    return map;
  }, [torrents]);

  const focusedTorrent = focused ? (byHash.get(focused) ?? null) : null;
  // Actions reach only rows that are on screen (see selection.ts); selected
  // rows the filter hides are counted beside the pill instead.
  const targets = useMemo(
    () => actionTargets(selection.selected, order, focused),
    [selection.selected, order, focused],
  );
  const hidden = hiddenSelected(selection.selected, order, (hash) => byHash.has(hash));

  const labels = useMemo(
    () => [...new Set(torrents.map((torrent) => torrent.label).filter(Boolean))].sort(),
    [torrents],
  );

  const nameOf = useCallback((hash: string) => byHash.get(hash)?.name, [byHash]);

  /** The value every one of `hashes` shares for a field, or empty when they differ. */
  const shared = (hashes: string[], pick: (torrent: Torrent) => string) => {
    const values = new Set(
      hashes.map((hash) => {
        const torrent = byHash.get(hash);
        return torrent ? pick(torrent) : '';
      }),
    );
    return values.size === 1 ? [...values][0] : '';
  };

  /* ------------------------------ selection ---------------------------- */

  const onSelect = useCallback(
    (hash: string, mods: SelectMods) => {
      setFocused(hash);
      setSelection((current) => selectRow(current, order, hash, mods));
    },
    [order],
  );

  /** The header checkbox and Ctrl+A act on the rows it shows, leaving hidden ones alone. */
  const onSelectAll = useCallback(
    (checked: boolean) => {
      setSelection((current) => {
        const next = new Set(current.selected);
        for (const hash of order) {
          if (checked) next.add(hash);
          else next.delete(hash);
        }
        return { selected: next, anchor: current.anchor };
      });
    },
    [order],
  );

  const clearSelection = () => {
    setSelection(EMPTY_SELECTION);
    setFocused(null);
  };

  /** Keyboard movement: focus a row, selecting it — or, with Shift, the range to it. */
  const moveTo = (hash: string, extend: boolean) => {
    setFocused(hash);
    setSelection((current) =>
      extend ? selectRow(current, order, hash, { ctrl: false, shift: true }) : selectOnly(hash),
    );
    document.querySelector(`[data-hash="${hash}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  /* ------------------------------- actions ----------------------------- */

  /** Toast each failure a bulk call reports, by torrent name; true when there were none. */
  const report = useCallback(
    (result: BulkResult) => {
      for (const error of nameErrors(result.errors, nameOf)) toast.push('error', error);
      return result.errors.length === 0;
    },
    [nameOf, toast],
  );

  const runAction = useCallback(
    async (action: string, hashes: string[] = targets): Promise<boolean> => {
      if (hashes.length === 0) return false;
      try {
        const ok = report(await api.bulkAction(hashes, action));
        await refresh();
        return ok;
      } catch (error) {
        toast.error(error);
        return false;
      }
    },
    [targets, report, refresh, toast],
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
      // Refused here rather than after a confirmation the server would then refuse.
      if (deleteData && policy?.deleteData === false) {
        toast.push('info', NO_DATA_DELETE);
        return;
      }
      const count = hashes.length === 1 ? 'this torrent' : `these ${hashes.length} torrents`;
      const ok = await dialogs.confirm({
        title: deleteData ? 'Remove and delete data' : 'Remove torrent',
        message: deleteData
          ? `Remove ${count} from rtorrent and delete the downloaded data? This cannot be undone.`
          : `Remove ${count} from rtorrent? The downloaded data is kept.`,
        items: hashes.map((hash) => nameOf(hash) ?? hash),
        confirmLabel: deleteData ? 'Remove and delete' : 'Remove',
        danger: deleteData,
      });
      if (!ok) return;
      try {
        if (report(await api.remove(hashes, deleteData))) {
          toast.push('success', `Removed ${hashes.length} torrent${hashes.length === 1 ? '' : 's'}`);
        }
        setSelection(EMPTY_SELECTION);
        setFocused(null);
        await refresh();
      } catch (error) {
        toast.error(error);
      }
    },
    [targets, policy, dialogs, nameOf, report, refresh, toast],
  );

  const patchTorrents = useCallback(
    async (patch: Record<string, unknown>, hashes: string[] = targets) => {
      if (hashes.length === 0) return;
      report(await api.patchEach(hashes, patch));
      await refresh();
    },
    [targets, report, refresh],
  );

  const promptLabel = async (hashes: string[] = targets) => {
    if (hashes.length === 0) return;
    const label = await dialogs.prompt({
      title: 'Set label',
      label: 'Label',
      message: 'Leave it empty to clear the label.',
      items: hashes.map((hash) => nameOf(hash) ?? hash),
      initial: shared(hashes, (torrent) => torrent.label),
      placeholder: 'none',
      suggestions: labels,
      confirmLabel: 'Apply',
    });
    if (label === null) return;
    await patchTorrents({ label: label.trim() }, hashes);
  };

  const promptDirectory = async (hashes: string[] = targets) => {
    if (hashes.length === 0) return;
    const directory = await dialogs.prompt({
      title: 'Change directory',
      label: 'Directory',
      message:
        'rtorrent updates its session only — move the files yourself if they are already downloaded, or recheck afterwards.',
      items: hashes.map((hash) => nameOf(hash) ?? hash),
      initial: shared(hashes, (torrent) => torrent.directory),
      placeholder: status?.downloadDir || '/downloads',
      confirmLabel: 'Move',
    });
    if (!directory?.trim()) return;
    await patchTorrents({ directory: directory.trim() }, hashes);
  };

  const copyMagnets = async (hashes: string[]) => {
    const links = hashes.map((hash) => magnetLink(hash, nameOf(hash)));
    try {
      await copyToClipboard(links.join('\n'));
      toast.push('success', `Copied ${links.length === 1 ? 'magnet link' : `${links.length} magnet links`}`);
    } catch {
      toast.push('error', 'Could not write to the clipboard');
    }
  };

  const menuActions: MenuActions = {
    run: (action, hashes) => void runAction(action, hashes),
    recheckRestart: (hashes) => void recheckRestart(hashes),
    patch: (patch, hashes) => void patchTorrents(patch, hashes),
    setLabel: (hashes) => void promptLabel(hashes),
    changeDirectory: (hashes) => void promptDirectory(hashes),
    copyMagnets: (hashes) => void copyMagnets(hashes),
    remove: (deleteData, hashes) => void removeTorrents(deleteData, hashes),
  };

  /** Open the torrent menu on a row, making it the selection unless it is already part of it. */
  const openMenu = (hash: string, x: number, y: number) => {
    setSelection((current) => (current.selected.has(hash) ? current : selectOnly(hash)));
    setFocused(hash);
    setMenu({ x, y, hash });
  };

  const onContextMenu = (hash: string, event: MouseEvent) => {
    event.preventDefault();
    openMenu(hash, event.clientX, event.clientY);
  };

  /** The menu key and Shift+F10: the same menu, on the focused row. */
  const openMenuFromKeyboard = (): boolean => {
    if (!focused || !order.includes(focused)) return false;
    const row = document.querySelector(`[data-hash="${focused}"]`)?.getBoundingClientRect();
    if (!row) return false;
    openMenu(focused, row.left + Math.min(row.width / 3, 240), row.top + row.height / 2);
    return true;
  };

  // A row the menu was opened on acts with the rest of the selection it belongs to.
  const menuTargets = menu ? (selection.selected.has(menu.hash) ? targets : [menu.hash]) : [];

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
    // The Add dialog has its own dropzone, and what lands there is staged,
    // not started — the overlay promising otherwise would be wrong.
    if (dialog === 'add' || !carriesPayload(event)) return;
    dragDepth.current += 1;
    setDropping(true);
  };

  const onDragLeave = (event: DragEvent) => {
    if (dialog === 'add' || !carriesPayload(event)) return;
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

  const submitDrop = async (form: FormData) => {
    form.append('start', '1');
    try {
      const result = await api.upload(form);
      for (const error of result.errors) toast.push('error', error);
      if (result.added > 0) await refresh();
    } catch (error) {
      toast.error(error);
    }
  };

  const onDropFiles = (event: DragEvent) => {
    dragDepth.current = 0;
    setDropping(false);
    const transfer = event.dataTransfer;
    // Read files from both .files and .items, synchronously — a browser that
    // exposed the drop only through .items would otherwise look like a bare
    // path drop and be turned away (see droppedFiles).
    const dropped = droppedFiles(transfer);
    // Text or a link dropped on a field is the field's own: a magnet dragged
    // into the Add dialog's link box, a name into the search. A file is still
    // ours, or the browser would navigate to it.
    if (dropped.length === 0 && isTextEntry(event.target)) return;
    event.preventDefault();

    // The Add dialog stages its own drops (its dropzone stops propagation, so
    // this handler only ever sees the ones that missed it) — say where the
    // file should land instead of swallowing the drop without a trace, which
    // read as dragging being broken. Any other dialog has no stake in a
    // drop: the file is handled exactly as if nothing were open.
    if (dialog === 'add') {
      toast.push('info', 'Drop it on the dialog’s dropzone — or close the dialog to add it straight away.');
      return;
    }

    const { accepted, ignored } = acceptTorrents(dropped);
    if (ignored) toast.push('info', ignored);
    const launch = (count: number) =>
      setBurst({ id: ++burstId.current, x: event.clientX, y: event.clientY, count, flavor });

    if (accepted.length > 0) {
      launch(accepted.length);
      const form = new FormData();
      for (const file of accepted) form.append('torrents', file);
      void submitDrop(form);
      return;
    }
    if (dropped.length > 0) return; // Only non-torrents: already said so.

    const { links, problem } = linksFromDrop(dropText(transfer));
    if (problem) {
      toast.push(problem.level, problem.text);
      return;
    }
    launch(links.length);
    const form = new FormData();
    form.append('urls', links.join('\n'));
    void submitDrop(form);
  };

  // A drop that lands outside the app element would otherwise make the browser
  // navigate to the file, discarding the UI.
  useEffect(() => {
    const block = (event: globalThis.DragEvent) => {
      if (isTextEntry(event.target) && !event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  /* ----------------------------- keyboard ------------------------------ */

  // The drawer only exists in the compact layout.
  useEffect(() => {
    if (!compact) setDrawerOpen(false);
  }, [compact]);

  // Read through a ref so the listener is attached once, not re-attached on
  // every poll with a fresh closure over the list.
  const onKey = useLatest((event: KeyboardEvent) => {
    // A key a component handled is claimed (the menus, the detail tabs, the
    // resize handle all prevent the default), and a text field keeps its own.
    if (event.defaultPrevented || isTextEntry(event.target)) return;
    // With anything modal open the keyboard is its: Escape closes it (the
    // modal listens for itself) and must not also clear the selection
    // behind it, and Delete must not stack a second confirmation.
    if (modalOpen) return;
    if (menu || (event.target instanceof Element && event.target.closest('[role="menu"]'))) {
      if (event.key === 'Escape') setMenu(null);
      return;
    }
    const command = event.ctrlKey || event.metaKey;
    switch (event.key) {
      case 'Escape':
        // One layer at a time: the drawer first, then the selection.
        if (drawerOpen) setDrawerOpen(false);
        else clearSelection();
        break;
      case 'Delete':
        void removeTorrents(event.shiftKey);
        break;
      case 'Backspace':
        // ⌘⌫, the Mac spelling of Delete: a laptop keyboard has no Delete key.
        if (command) void removeTorrents(event.shiftKey);
        break;
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Home':
      case 'End': {
        const next =
          event.key === 'Home'
            ? order[0]
            : event.key === 'End'
              ? order[order.length - 1]
              : stepRow(order, focused, event.key === 'ArrowDown' ? 1 : -1);
        if (!next) break;
        event.preventDefault();
        moveTo(next, event.shiftKey);
        break;
      }
      case 'ContextMenu':
      case 'F10':
        if (event.key === 'F10' && !event.shiftKey) break;
        if (openMenuFromKeyboard()) event.preventDefault();
        break;
      case '/':
        event.preventDefault();
        searchRef.current?.focus();
        break;
      case 'a':
      case 'A':
        if (!command) break;
        event.preventDefault();
        onSelectAll(true);
        break;
      case 'n':
      case 'N':
        if (!command && !event.altKey) setDialog('add');
        break;
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onKey]);

  /* ------------------------------- render ------------------------------ */

  const applySort = (next: SortState) => updatePrefs({ sortKey: next.key, sortDir: next.dir });

  /** A header click: flip the direction on the sorted column, open another with its default. */
  const onSort = (key: SortKey) =>
    applySort(
      sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultSortDir(key) },
    );

  /** The compact layout's dropdown: pick a column, keeping the direction if it is the same one. */
  const onSortKey = (key: SortKey) =>
    applySort({ key, dir: sort.key === key ? sort.dir : defaultSortDir(key) });

  const openTool = (tool: ToolId) => {
    setDrawerOpen(false);
    setDialog(tool);
  };

  const none = targets.length === 0;
  const labelsSupported = supports?.labels !== false;
  const showConsole = policy?.rawRpc === true;

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
        showConsole={showConsole}
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
        showConsole={showConsole}
      />

      <main className="main">
        {connectionError && (
          <div className="banner" role="alert">
            <IconAlert size={15} />
            <span className="grow">{connectionError}</span>
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
            aria-expanded={drawerOpen}
          >
            <IconFilter size={14} />
          </button>
          <button className="btn sm" onClick={() => void runAction('start')} disabled={none}>
            <IconPlay size={12} />
            <span>Start</span>
          </button>
          <button className="btn sm" onClick={() => void runAction('pause')} disabled={none}>
            <IconPause size={13} />
            <span>Pause</span>
          </button>
          <button className="btn sm" onClick={() => void runAction('stop')} disabled={none}>
            <IconStop size={12} />
            <span>Stop</span>
          </button>
          <button
            className="btn sm danger"
            onClick={() => void removeTorrents(false)}
            disabled={none}
            title="Remove (Delete)"
          >
            <IconTrash size={13} />
            <span>Remove</span>
          </button>

          <div className="divider" />

          <button className="btn sm" onClick={() => void runAction('recheck')} disabled={none}>
            <IconRefresh size={13} />
            <span>Recheck</span>
          </button>
          <button
            className="btn sm"
            onClick={() => void promptLabel()}
            disabled={none || !labelsSupported}
            title={labelsSupported ? undefined : 'Not supported by this rtorrent build'}
          >
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
                aria-label={`Sort direction: ${sort.dir === 'asc' ? 'ascending' : 'descending'}`}
                title="Sort direction"
              >
                {sort.dir === 'asc' ? '▲' : '▼'}
              </button>
            </>
          )}

          {(targets.length > 0 || hidden > 0) && (
            <span className="selection-pill">
              {targets.length} selected
              {hidden > 0 && (
                <span
                  className="pill-hidden"
                  title="Selected, but hidden by the current filter or search — actions skip them until they are shown again"
                >
                  +{hidden} hidden
                </span>
              )}
              <button className="btn sm ghost pill-clear" onClick={clearSelection}>
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
              aria-label="Search torrents"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                setSearch('');
                event.currentTarget.blur();
              }}
            />
            {search && (
              <button
                className="search-clear"
                onClick={() => {
                  setSearch('');
                  searchRef.current?.focus();
                }}
                aria-label="Clear search"
                title="Clear search (Esc)"
              >
                <IconClose size={12} />
              </button>
            )}
          </div>
        </div>

        <TorrentTable
          compact={compact}
          torrents={visible}
          selected={selection.selected}
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
            height={prefs.detailHeight}
            onHeightChange={(height) => updatePrefs({ detailHeight: height })}
            onClose={() => setFocused(null)}
            onRecheckRestart={recheckRestart}
            supports={supports}
          />
        )}
      </main>

      {menu && (
        <TorrentMenu
          x={menu.x}
          y={menu.y}
          targets={menuTargets}
          throttles={throttles}
          supports={supports}
          policy={policy}
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
      <DropBurst burst={burst} onDone={clearBurst} />

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
