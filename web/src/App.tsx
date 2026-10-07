// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { rowOf } from './app/dom';
import { focusOnMenu, focusOnSelection } from './app/rowFocus';
import { Toolbar } from './app/Toolbar';
import { useDropToAdd } from './app/useDropToAdd';
import { useShortcuts } from './app/useShortcuts';
import { useTorrentActions } from './app/useTorrentActions';
import { useTrackerHosts } from './app/useTrackerHosts';
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
import { TorrentMenu } from './components/TorrentMenu';
import { TorrentTable } from './components/TorrentTable';
import { useDialogs } from './components/dialogs';
import { IconAlert, IconRefresh, IconUpload } from './components/icons';
import { useToast } from './components/toast';
import { filterTorrents, type Filter } from './filter';
import { grimAchievement, grimGame } from './grim';
import { useLatest, usePolling } from './hooks';
import { fetchPreferences, readCache, savePreferences, type Preferences } from './prefs';
import { redactSecrets } from './redact';
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
import { sharedValue } from './sharedValue';
import { defaultSortDir, sortTorrents, type SortKey, type SortState } from './sort';
import { applyTheme, fxFlavor, resolveTheme, type ResolvedTheme, type ThemeMode } from './theme';
import type { GameState, ThrottleGroup, Torrent } from './types';
import { COMPACT_QUERY, useMediaQuery } from './useMediaQuery';
import { useStateStream } from './useStateStream';

type Dialog = 'add' | 'settings' | 'throttles' | 'console' | 'log' | 'progress' | null;

interface MenuState {
  x: number;
  y: number;
  /** The row the menu was opened on. */
  hash: string;
}

// Stable stand-ins until the first snapshot: a fresh [] on every render
// would recompute everything keyed on the list.
const NO_TORRENTS: Torrent[] = [];
const NO_THROTTLES: ThrottleGroup[] = [];

export function App() {
  // The server's state, kept current by the stream: every change made through
  // the API is read back at once, so nothing here asks for it again.
  const stream = useStateStream();
  const loaded = stream.state !== null;
  const torrents = stream.state?.torrents ?? NO_TORRENTS;
  const status = stream.state?.status ?? null;
  const throttles = stream.state?.throttles ?? NO_THROTTLES;
  const game = stream.state?.game ?? null;
  const connectionError =
    stream.error ?? (status && !status.connected ? (status.error ?? 'rtorrent is not responding') : null);
  const trackerHosts = useTrackerHosts(torrents);

  const [filter, setFilter] = useState<Filter>({ kind: 'status', value: 'all' });
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [focused, setFocused] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
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
  const gameEnabled = game?.enabled === true;

  const toast = useToast();
  const dialogs = useDialogs();
  const compact = useMediaQuery(COMPACT_QUERY);
  const compactRef = useLatest(compact);
  const searchRef = useRef<HTMLInputElement>(null);
  const completedRef = useRef<Set<string> | null>(null);
  const seenBadgesRef = useRef<string[] | null>(null);
  // Set once the stored preferences say which badges were already toasted.
  const [badgesKnown, setBadgesKnown] = useState(false);
  const preferencesLoaded = useRef(false);
  // Read by badge toasts without re-running them on theme changes.
  const grimRef = useLatest(grim);

  // The black metal theme re-carves the gamification copy; the server's ids
  // and progress stay canonical, so switching themes never changes what is
  // earned.
  const displayGame = useMemo(() => (game && grim ? grimGame(game) : game), [game, grim]);

  const clearBurst = useCallback(() => setBurst(null), []);
  const clearCelebration = useCallback(() => setCelebration(0), []);
  const closeDialog = useCallback(() => setDialog(null), []);

  const updatePrefs = useCallback((patch: Partial<Preferences>) => {
    setPrefs((current) => ({ ...current, ...patch }));
    savePreferences(patch);
  }, []);

  const loadPreferences = useCallback(async (isCurrent: () => boolean) => {
    if (preferencesLoaded.current) return;
    const stored = await fetchPreferences();
    if (!isCurrent()) return;
    preferencesLoaded.current = true;
    setPrefs(stored);
    seenBadgesRef.current = stored.seenBadges;
    setBadgesKnown(true);
  }, []);
  // A startup connection failure must not make the cache authoritative for
  // this entire visit, or re-announce badges before the saved list arrives.
  usePolling(loadPreferences, 5000);

  useEffect(() => {
    setResolvedTheme(applyTheme(themeMode));
    if (themeMode !== 'system') return;
    // Follow the OS while "system" is selected.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setResolvedTheme(applyTheme('system'));
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [themeMode]);

  /* ------------------------------- state -------------------------------- */

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

  // Celebrate anything that finished since the last state. The first state
  // only seeds the baseline so a page load does not fire off confetti. The
  // list keeps its identity through a delta that touches no torrent (the
  // global rates, the history), so this runs when a torrent changed, not on
  // every delta.
  useEffect(() => {
    if (!loaded) return;
    const done = new Set(torrents.filter((torrent) => torrent.progress >= 1).map((torrent) => torrent.hash));
    const before = completedRef.current;
    completedRef.current = done;
    if (!before) return;
    const fresh = torrents.filter((torrent) => torrent.progress >= 1 && !before.has(torrent.hash));
    if (fresh.length === 0) return;
    // The toast is plain feedback and fires for everyone; only the confetti
    // belongs to the gamification layer and its flag.
    if (gameEnabled) setCelebration((value) => value + 1);
    for (const torrent of fresh) toast.push('success', `Finished — ${torrent.name}`);
  }, [loaded, torrents, gameEnabled, toast]);

  useEffect(() => {
    if (badgesKnown) announceBadges(game);
  }, [game, badgesKnown, announceBadges]);

  /* ------------------------------ filtering ---------------------------- */

  const visible = useMemo(
    () => sortTorrents(filterTorrents(torrents, filter, search, trackerHosts), sort),
    [torrents, filter, search, sort, trackerHosts],
  );
  const order = useMemo(() => visible.map((torrent) => torrent.hash), [visible]);
  const orderRef = useLatest(order);

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

  /* ------------------------------ selection ---------------------------- */

  // Handed to every row, so it must not change with the list: each memoized
  // row would otherwise be drawn again on every update. The order is read
  // when the click lands, which is the order the user clicked in.
  const onSelect = useCallback(
    (hash: string, mods: SelectMods) => {
      const rows = orderRef.current;
      setFocused((current) => focusOnSelection(compactRef.current, current, hash, mods));
      setSelection((current) => selectRow(current, rows, hash, mods));
    },
    [orderRef, compactRef],
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

  const clearSelection = useCallback(() => {
    setSelection(EMPTY_SELECTION);
    setFocused(null);
  }, []);

  /** Keyboard movement: focus a row, selecting it — or, with Shift, the range to it. */
  const move = (to: 'next' | 'previous' | 'first' | 'last', extend: boolean): boolean => {
    const next =
      to === 'first'
        ? order[0]
        : to === 'last'
          ? order[order.length - 1]
          : stepRow(order, focused, to === 'next' ? 1 : -1);
    if (!next) return false;
    setFocused(next);
    setSelection((current) =>
      extend ? selectRow(current, order, next, { ctrl: false, shift: true }) : selectOnly(next),
    );
    rowOf(next)?.scrollIntoView({ block: 'nearest' });
    return true;
  };

  /* ------------------------------- actions ----------------------------- */

  const actions = useTorrentActions({
    targets,
    byHash,
    labels,
    policy,
    downloadDir: status?.downloadDir ?? '',
    onRemoved: clearSelection,
  });

  /**
   * Open the torrent menu on a row, making it the selection unless it is
   * already part of it. The compact layout is read through a ref so that the
   * callback, handed to every row, stays stable.
   */
  const openMenu = useCallback(
    (hash: string, x: number, y: number) => {
      const compactNow = compactRef.current;
      setSelection((current) => (current.selected.has(hash) ? current : selectOnly(hash)));
      setFocused((current) => focusOnMenu(compactNow, current, hash));
      setMenu({ x, y, hash });
    },
    [compactRef],
  );

  // Stable for the same reason as onSelect.
  const onContextMenu = useCallback(
    (hash: string, event: MouseEvent) => {
      event.preventDefault();
      openMenu(hash, event.clientX, event.clientY);
    },
    [openMenu],
  );

  /** The menu key and Shift+F10: the same menu, on the focused row. */
  const openMenuFromKeyboard = (): boolean => {
    if (!focused || !order.includes(focused)) return false;
    const row = rowOf(focused)?.getBoundingClientRect();
    if (!row) return false;
    openMenu(focused, row.left + Math.min(row.width / 3, 240), row.top + row.height / 2);
    return true;
  };

  // A row the menu was opened on acts with the rest of the selection it belongs to.
  const menuTargets = menu ? (selection.selected.has(menu.hash) ? targets : [menu.hash]) : [];

  /* --------------------------- drag and drop ---------------------------- */

  const drop = useDropToAdd({
    staging: dialog === 'add',
    onLaunch: (x, y, count) => {
      if (gameEnabled) setBurst({ id: ++burstId.current, x, y, count, flavor });
    },
  });

  /* ----------------------------- keyboard ------------------------------ */

  // The drawer only exists in the compact layout.
  useEffect(() => {
    if (!compact) setDrawerOpen(false);
  }, [compact]);

  useShortcuts({
    // Any modal — the app's own dialogs or a confirm/prompt — takes the keyboard.
    modalOpen: dialog !== null || dialogs.open || (compact && focusedTorrent !== null),
    drawerOpen,
    menuOpen: menu !== null,
    closeDrawer: () => setDrawerOpen(false),
    closeMenu: () => setMenu(null),
    clearSelection,
    remove: (deleteData) => void actions.remove(deleteData),
    move,
    openMenu: openMenuFromKeyboard,
    focusSearch: () => searchRef.current?.focus(),
    selectAll: () => onSelectAll(true),
    add: () => setDialog('add'),
  });

  /* ------------------------------- render ------------------------------ */

  const applySort = (next: SortState) => updatePrefs({ sortKey: next.key, sortDir: next.dir });

  /** A header click: flip the direction on the sorted column, open another with its default. */
  const onSort = (key: SortKey) =>
    applySort(
      sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultSortDir(key) },
    );

  const openTool = (tool: ToolId) => {
    // The drawer closes as the dialog opens. Give that dialog a visible
    // return target instead of the drawer button about to be hidden.
    document.querySelector<HTMLElement>('[aria-controls="filter-drawer"]')?.focus();
    setDrawerOpen(false);
    setDialog(tool);
  };

  const showConsole = policy?.rawRpc === true;

  return (
    <div className="app" {...drop.handlers}>
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
        open={drawerOpen}
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
        showProgress={gameEnabled}
        showConsole={showConsole}
      />

      <main className="main">
        {connectionError && (
          <div className="banner" role="alert">
            <IconAlert size={15} />
            <span className="grow">{redactSecrets(connectionError)}</span>
            <button className="btn sm ghost" onClick={stream.retry}>
              <IconRefresh size={13} />
              <span>Retry</span>
            </button>
          </div>
        )}

        <Toolbar
          compact={compact}
          drawerOpen={drawerOpen}
          onToggleDrawer={() => setDrawerOpen((value) => !value)}
          selected={targets.length}
          hidden={hidden}
          onClearSelection={clearSelection}
          onAction={(action) => void actions.run(action)}
          onRemove={() => void actions.remove(false)}
          onLabel={() => void actions.promptLabel()}
          labelsSupported={supports?.labels !== false}
          sort={sort}
          onSort={applySort}
          onLog={() => setDialog('log')}
          search={search}
          onSearch={setSearch}
          searchRef={searchRef}
        />

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
          empty={
            !loaded
              ? { title: 'Loading torrents…' }
              : torrents.length === 0
                ? { title: 'Nothing here yet', hint: 'Add a .torrent file or magnet link to get started.' }
                : { title: 'No matches', hint: 'No torrents match the current filter or search.' }
          }
        />

        {focusedTorrent && (
          <DetailPanel
            compact={compact}
            torrent={focusedTorrent}
            height={prefs.detailHeight}
            onHeightChange={(height) => updatePrefs({ detailHeight: height })}
            onClose={() => setFocused(null)}
            onRecheckRestart={actions.recheckRestart}
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
          current={{
            priority: sharedValue(byHash, menuTargets, (torrent) => torrent.priority),
            throttle: sharedValue(byHash, menuTargets, (torrent) => torrent.throttle),
          }}
          actions={actions.menu}
          onClose={() => setMenu(null)}
        />
      )}

      {drop.dropping && (
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
        <AddDialog onClose={closeDialog} defaultDirectory={status?.downloadDir ?? ''} labels={labels} />
      )}
      {dialog === 'progress' && displayGame && (
        <AchievementsDialog game={displayGame} grim={grim} onClose={closeDialog} />
      )}
      {dialog === 'settings' && (
        <SettingsDialog
          onClose={closeDialog}
          backend={status?.backend ?? null}
          statePollMs={prefs.statePollMs}
          statePollDefaultMs={status?.statePollDefaultMs ?? null}
          onStatePollChange={(statePollMs) => updatePrefs({ statePollMs })}
        />
      )}
      {dialog === 'throttles' && <ThrottleDialog onClose={closeDialog} backend={status?.backend ?? null} />}
      {dialog === 'console' && <RpcConsole onClose={closeDialog} />}
      {dialog === 'log' && <LogDialog onClose={closeDialog} />}
    </div>
  );
}
