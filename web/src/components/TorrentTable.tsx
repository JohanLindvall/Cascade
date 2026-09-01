import { useMemo, useRef, type MouseEvent, type TouchEvent as ReactTouchEvent } from 'react';
import { bytes, duration, percent, rate, relative } from '../format';
import type { SortKey, SortState } from '../sort';
import type { Torrent } from '../types';
import { EmptyState, ProgressBar, type BarVariant } from './ui';
import { IconDown } from './icons';

/** Modifier keys that drive multi-select, decoupled from the DOM event type. */
export interface SelectMods {
  ctrl: boolean;
  shift: boolean;
}

interface Column {
  key: SortKey;
  label: string;
  className?: string;
  align?: 'right';
}

/**
 * Every column carries a class so styles.css can pin its width. Without that
 * the browser sizes columns from their content, and since most of these change
 * text on every poll ("2m 54s" becomes "2m 9s") the whole table shifts
 * sideways twice a second.
 */
const COLUMNS: Column[] = [
  { key: 'name', label: 'Name', className: 'col-name' },
  { key: 'size', label: 'Size', align: 'right', className: 'col-size' },
  { key: 'progress', label: 'Progress', className: 'col-progress' },
  { key: 'status', label: 'Status', className: 'col-status' },
  { key: 'peers', label: 'Peers', align: 'right', className: 'col-peers' },
  { key: 'downRate', label: 'Down', align: 'right', className: 'col-down' },
  { key: 'upRate', label: 'Up', align: 'right', className: 'col-up' },
  { key: 'ratio', label: 'Ratio', align: 'right', className: 'col-ratio' },
  { key: 'eta', label: 'ETA', align: 'right', className: 'col-eta' },
  { key: 'addedAt', label: 'Added', align: 'right', className: 'col-added' },
];

/** Sortable fields with labels, for the compact layout's sort dropdown. */
export const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  ...COLUMNS.map(({ key, label }) => ({ key, label })),
  { key: 'label', label: 'Label' },
];

/** Colour the ratio by how much the torrent has given back. */
function ratioTier(ratio: number): string {
  if (ratio >= 5) return 'gold';
  if (ratio >= 1) return 'good';
  if (ratio >= 0.5) return 'fair';
  return 'poor';
}

function barVariant(torrent: Torrent): BarVariant {
  if (torrent.status === 'error') return 'error';
  if (torrent.status === 'checking') return 'checking';
  if (torrent.progress >= 1) return 'done';
  if (torrent.status === 'stopped' || torrent.status === 'paused') return 'idle';
  return 'default';
}

/** The bar and its percentage, shared by the table row and the card. */
function TorrentProgress({ torrent }: { torrent: Torrent }) {
  return (
    <div className="progress-cell">
      <ProgressBar
        value={torrent.progress}
        variant={barVariant(torrent)}
        striped={torrent.status === 'checking'}
        live={torrent.status === 'downloading' && torrent.progress < 1}
      />
      <span className="num">{percent(torrent.progress, torrent.progress >= 1 ? 0 : 1)}</span>
    </div>
  );
}

/** Label and throttle chips; the row adds the private flag, the card has no room. */
function TorrentTags({ torrent, showPrivate }: { torrent: Torrent; showPrivate?: boolean }) {
  return (
    <>
      {torrent.label && <span className="tag accent">{torrent.label}</span>}
      {torrent.throttle && <span className="tag">⇅ {torrent.throttle}</span>}
      {showPrivate && torrent.isPrivate && <span className="tag">private</span>}
    </>
  );
}

interface TorrentTableProps {
  /** Render as stacked cards instead of a table (narrow viewports). */
  compact?: boolean;
  torrents: Torrent[];
  selected: Set<string>;
  focused: string | null;
  sort: SortState;
  onSort: (key: SortKey) => void;
  onSelect: (hash: string, mods: SelectMods) => void;
  onSelectAll: (checked: boolean) => void;
  onContextMenu: (hash: string, event: MouseEvent) => void;
  emptyHint: string;
}

export function TorrentTable({
  compact,
  torrents,
  selected,
  focused,
  sort,
  onSort,
  onSelect,
  onSelectAll,
  onContextMenu,
  emptyHint,
}: TorrentTableProps) {
  const allSelected = torrents.length > 0 && torrents.every((t) => selected.has(t.hash));
  const someSelected = torrents.some((t) => selected.has(t.hash));

  const rows = useMemo(
    () =>
      torrents.map((torrent) => {
        const checked = selected.has(torrent.hash);
        return (
          <tr
            key={torrent.hash}
            data-hash={torrent.hash}
            className={`${checked ? 'selected' : ''} ${focused === torrent.hash ? 'focused' : ''}`}
            onClick={(event) =>
              onSelect(torrent.hash, {
                ctrl: event.ctrlKey || event.metaKey,
                shift: event.shiftKey,
              })
            }
            onContextMenu={(event) => onContextMenu(torrent.hash, event)}
          >
            <td className="col-check" onClick={(event) => event.stopPropagation()}>
              <input
                className="check"
                type="checkbox"
                checked={checked}
                onChange={() => onSelect(torrent.hash, { ctrl: true, shift: false })}
                aria-label={`Select ${torrent.name}`}
              />
            </td>
            <td className="col-name">
              <div className="name-cell">
                <div className="name-line">
                  <span className="name-text" title={torrent.name}>
                    {torrent.name || torrent.hash}
                  </span>
                  <TorrentTags torrent={torrent} showPrivate />
                </div>
                {torrent.message && (
                  <div className="name-meta" style={{ color: 'var(--warn)' }} title={torrent.message}>
                    {torrent.message.slice(0, 120)}
                  </div>
                )}
              </div>
            </td>
            <td className="num" style={{ textAlign: 'right' }}>
              {bytes(torrent.size)}
            </td>
            <td>
              <TorrentProgress torrent={torrent} />
            </td>
            <td>
              <StatusPill torrent={torrent} />
            </td>
            <td className="num col-peers" style={{ textAlign: 'right' }}>
              <span style={{ color: 'var(--text-dim)' }}>{torrent.peersConnected}</span>
              <span style={{ color: 'var(--text-faint)' }}>/{torrent.peersNotConnected}</span>
            </td>
            <td className={`num rate-num ${torrent.downRate ? 'down' : 'zero'}`} style={{ textAlign: 'right' }}>
              {rate(torrent.downRate)}
            </td>
            <td className={`num rate-num ${torrent.upRate ? 'up' : 'zero'}`} style={{ textAlign: 'right' }}>
              {rate(torrent.upRate)}
            </td>
            <td className={`num col-ratio ratio ${ratioTier(torrent.ratio)}`} style={{ textAlign: 'right' }}>
              {torrent.ratio.toFixed(2)}
            </td>
            <td className="num col-eta" style={{ textAlign: 'right' }}>
              {torrent.progress >= 1 ? '—' : duration(torrent.eta)}
            </td>
            <td className="num col-added" style={{ textAlign: 'right', color: 'var(--text-faint)' }}>
              {relative(torrent.addedAt)}
            </td>
          </tr>
        );
      }),
    [torrents, selected, focused, onSelect, onContextMenu],
  );

  if (torrents.length === 0) {
    return (
      <div className="table-wrap">
        <EmptyState glyph={<IconDown size={26} />} title="Nothing here yet">
          {emptyHint}
        </EmptyState>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="table-wrap">
        <div className="card-list">
          {torrents.map((torrent) => (
            <TorrentCard
              key={torrent.hash}
              torrent={torrent}
              selected={selected.has(torrent.hash)}
              focused={focused === torrent.hash}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="torrents">
        <thead>
          <tr>
            <th className="col-check">
              <input
                className="check"
                type="checkbox"
                checked={allSelected}
                ref={(element) => {
                  if (element) element.indeterminate = !allSelected && someSelected;
                }}
                onChange={(event) => onSelectAll(event.target.checked)}
                aria-label="Select all"
              />
            </th>
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                className={`${column.className ?? ''} ${sort.key === column.key ? 'sorted' : ''}`}
                style={column.align === 'right' ? { textAlign: 'right' } : undefined}
                aria-sort={
                  sort.key === column.key
                    ? sort.dir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : undefined
                }
                onClick={() => onSort(column.key)}
                // Sorting is an action, so the headers take the keyboard too.
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSort(column.key);
                  }
                }}
              >
                {column.label}
                {sort.key === column.key && (
                  <span className="arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

/**
 * One torrent as a stacked card. Touch has no hover or right-click, so the
 * whole card is the tap target and a long press stands in for the context menu.
 */
function TorrentCard({
  torrent,
  selected,
  focused,
  onSelect,
  onContextMenu,
}: {
  torrent: Torrent;
  selected: boolean;
  focused: boolean;
  onSelect: (hash: string, mods: SelectMods) => void;
  onContextMenu: (hash: string, event: MouseEvent) => void;
}) {
  const press = useRef<number | undefined>(undefined);
  // Whether the long press already opened the menu; the synthesized click that
  // follows touchend must then be swallowed, or it instantly closes the menu
  // and selects the card underneath it.
  const pressFired = useRef(false);
  const pressStart = useRef({ x: 0, y: 0 });

  const startPress = (event: ReactTouchEvent) => {
    const touch = event.touches[0];
    pressFired.current = false;
    pressStart.current = { x: touch.clientX, y: touch.clientY };
    press.current = window.setTimeout(() => {
      pressFired.current = true;
      onContextMenu(torrent.hash, {
        preventDefault: () => {},
        clientX: touch.clientX,
        clientY: touch.clientY,
      } as MouseEvent);
    }, 500);
  };
  const cancelPress = () => {
    window.clearTimeout(press.current);
    pressFired.current = false;
  };
  // A held finger trembles a few pixels; only real travel is a scroll. Any
  // movement at all used to cancel, which made the menu a lottery.
  const movePress = (event: ReactTouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return cancelPress();
    const dx = touch.clientX - pressStart.current.x;
    const dy = touch.clientY - pressStart.current.y;
    if (dx * dx + dy * dy > 10 * 10) cancelPress();
  };
  const endPress = (event: ReactTouchEvent) => {
    window.clearTimeout(press.current);
    if (pressFired.current) event.preventDefault();
  };

  return (
    <article
      className={`torrent-card ${selected ? 'selected' : ''} ${focused ? 'focused' : ''}`}
      data-hash={torrent.hash}
      onClick={(event) => {
        if (pressFired.current) {
          // Belt to the preventDefault braces: some browsers fire the click anyway.
          pressFired.current = false;
          return;
        }
        onSelect(torrent.hash, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
      }}
      onContextMenu={(event) => onContextMenu(torrent.hash, event)}
      onTouchStart={startPress}
      onTouchEnd={endPress}
      onTouchMove={movePress}
      onTouchCancel={cancelPress}
    >
      <div className="card-top">
        <input
          className="check"
          type="checkbox"
          checked={selected}
          onClick={(event) => event.stopPropagation()}
          onChange={() => onSelect(torrent.hash, { ctrl: true, shift: false })}
          aria-label={`Select ${torrent.name}`}
        />
        <span className="card-name" title={torrent.name}>
          {torrent.name || torrent.hash}
        </span>
        <StatusPill torrent={torrent} />
      </div>

      <TorrentProgress torrent={torrent} />

      <div className="card-stats num">
        <span>{bytes(torrent.size)}</span>
        <span className={torrent.downRate ? 'rate-num down' : 'rate-num zero'}>
          ↓ {rate(torrent.downRate)}
        </span>
        <span className={torrent.upRate ? 'rate-num up' : 'rate-num zero'}>
          ↑ {rate(torrent.upRate)}
        </span>
        <span>{torrent.peersConnected} peers</span>
        <span>ratio {torrent.ratio.toFixed(2)}</span>
        {torrent.progress < 1 && <span>{duration(torrent.eta)}</span>}
      </div>

      {(torrent.label || torrent.throttle || torrent.message) && (
        <div className="card-tags">
          <TorrentTags torrent={torrent} />
          {torrent.message && (
            <span className="card-message" title={torrent.message}>
              {torrent.message}
            </span>
          )}
        </div>
      )}
    </article>
  );
}

export function StatusPill({ torrent }: { torrent: Torrent }) {
  const label =
    torrent.status === 'checking'
      ? `checking ${percent(torrent.hashing > 0 ? torrent.chunksDone / Math.max(1, torrent.chunksTotal) : 0, 0)}`
      : torrent.status;
  const live = torrent.status === 'downloading' || torrent.status === 'seeding';
  return (
    <span className={`pill ${torrent.status}`} title={torrent.message || undefined}>
      <span className={`dot ${live ? 'pulse' : ''}`} />
      {label}
    </span>
  );
}
