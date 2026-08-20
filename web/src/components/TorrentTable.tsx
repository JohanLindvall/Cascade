import { useMemo, type MouseEvent } from 'react';

/** Modifier keys that drive multi-select, decoupled from the DOM event type. */
export interface SelectMods {
  ctrl: boolean;
  shift: boolean;
}
import { bytes, duration, percent, rate, relative } from '../format';
import type { Torrent } from '../types';
import { EmptyState, ProgressBar } from './ui';
import { IconDown } from './icons';

export type SortKey =
  | 'name'
  | 'size'
  | 'progress'
  | 'status'
  | 'downRate'
  | 'upRate'
  | 'ratio'
  | 'eta'
  | 'peers'
  | 'addedAt'
  | 'label';

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

interface Column {
  key: SortKey;
  label: string;
  className?: string;
  align?: 'right';
}

const COLUMNS: Column[] = [
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size', align: 'right' },
  { key: 'progress', label: 'Progress' },
  { key: 'status', label: 'Status' },
  { key: 'peers', label: 'Peers', align: 'right', className: 'col-hide' },
  { key: 'downRate', label: 'Down', align: 'right' },
  { key: 'upRate', label: 'Up', align: 'right' },
  { key: 'ratio', label: 'Ratio', align: 'right', className: 'col-hide' },
  { key: 'eta', label: 'ETA', align: 'right', className: 'col-hide' },
  { key: 'addedAt', label: 'Added', align: 'right', className: 'col-hide' },
];

function sortValue(torrent: Torrent, key: SortKey): number | string {
  switch (key) {
    case 'name':
      return torrent.name.toLowerCase();
    case 'label':
      return torrent.label.toLowerCase();
    case 'status':
      return torrent.status;
    case 'peers':
      return torrent.peersConnected;
    case 'eta':
      return torrent.eta === null ? Number.MAX_SAFE_INTEGER : torrent.eta;
    default:
      return torrent[key] as number;
  }
}

export function sortTorrents(torrents: Torrent[], sort: SortState): Torrent[] {
  const factor = sort.dir === 'asc' ? 1 : -1;
  return [...torrents].sort((a, b) => {
    const left = sortValue(a, sort.key);
    const right = sortValue(b, sort.key);
    if (typeof left === 'string' || typeof right === 'string') {
      return String(left).localeCompare(String(right)) * factor;
    }
    return (left - right) * factor;
  });
}

/** Colour the ratio by how much the torrent has given back. */
function ratioTier(ratio: number): string {
  if (ratio >= 5) return 'gold';
  if (ratio >= 1) return 'good';
  if (ratio >= 0.5) return 'fair';
  return 'poor';
}

function barVariant(torrent: Torrent) {
  if (torrent.status === 'error') return 'error' as const;
  if (torrent.status === 'checking') return 'checking' as const;
  if (torrent.progress >= 1) return 'done' as const;
  if (torrent.status === 'stopped' || torrent.status === 'paused') return 'idle' as const;
  return 'default' as const;
}

interface TorrentTableProps {
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
              />
            </td>
            <td className="col-name">
              <div className="name-cell">
                <div className="name-line">
                  <span className="name-text" title={torrent.name}>
                    {torrent.name || torrent.hash}
                  </span>
                  {torrent.label && <span className="tag accent">{torrent.label}</span>}
                  {torrent.throttle && <span className="tag">⇅ {torrent.throttle}</span>}
                  {torrent.isPrivate && <span className="tag">private</span>}
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
              <div className="progress-cell">
                <ProgressBar
                  value={torrent.progress}
                  variant={barVariant(torrent)}
                  striped={torrent.status === 'checking'}
                  live={torrent.status === 'downloading' && torrent.progress < 1}
                />
                <span className="num">{percent(torrent.progress, torrent.progress >= 1 ? 0 : 1)}</span>
              </div>
            </td>
            <td>
              <StatusPill torrent={torrent} />
            </td>
            <td className="num col-hide" style={{ textAlign: 'right' }}>
              <span style={{ color: 'var(--text-dim)' }}>{torrent.peersConnected}</span>
              <span style={{ color: 'var(--text-faint)' }}>/{torrent.peersNotConnected}</span>
            </td>
            <td className={`num rate-num ${torrent.downRate ? 'down' : 'zero'}`} style={{ textAlign: 'right' }}>
              {rate(torrent.downRate)}
            </td>
            <td className={`num rate-num ${torrent.upRate ? 'up' : 'zero'}`} style={{ textAlign: 'right' }}>
              {rate(torrent.upRate)}
            </td>
            <td className={`num col-hide ratio ${ratioTier(torrent.ratio)}`} style={{ textAlign: 'right' }}>
              {torrent.ratio.toFixed(2)}
            </td>
            <td className="num col-hide" style={{ textAlign: 'right' }}>
              {torrent.progress >= 1 ? '—' : duration(torrent.eta)}
            </td>
            <td className="num col-hide" style={{ textAlign: 'right', color: 'var(--text-faint)' }}>
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
              />
            </th>
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                className={`${column.className ?? ''} ${sort.key === column.key ? 'sorted' : ''}`}
                style={column.align === 'right' ? { textAlign: 'right' } : undefined}
                onClick={() => onSort(column.key)}
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
