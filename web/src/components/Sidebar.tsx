import { useMemo } from 'react';
import { STATUS_FILTERS, countByStatus, type Filter, type StatusFilter } from '../filter';
import { bytes, rate } from '../format';
import type { GlobalStatus, Torrent } from '../types';
import { IconGauge, IconGlobe, IconList, IconSettings, IconTag, IconTerminal, IconTrophy } from './icons';

/** Dialogs reachable from the drawer on compact layouts, where the header has
 *  no room for their buttons. */
export type ToolId = 'progress' | 'settings' | 'throttles' | 'console';

interface SidebarProps {
  /** Extra classes — used to slide the drawer in on narrow viewports. */
  className?: string;
  torrents: Torrent[];
  status: GlobalStatus | null;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  trackerHosts: Record<string, string>;
  /** Compact layout only: render the tools group and route its clicks here. */
  compact?: boolean;
  onTool?: (tool: ToolId) => void;
  showProgress?: boolean;
  /** Whether the API console may be offered (CASCADE_ALLOW_RAW_RPC). */
  showConsole?: boolean;
}

/** How each status filter is shown; the order is STATUS_FILTERS' own. */
const STATUS_LOOK: Record<StatusFilter, { label: string; color?: string }> = {
  all: { label: 'All torrents' },
  downloading: { label: 'Downloading', color: 'var(--down)' },
  seeding: { label: 'Seeding', color: 'var(--ok)' },
  active: { label: 'Active', color: 'var(--accent)' },
  paused: { label: 'Paused', color: 'var(--warn)' },
  stopped: { label: 'Stopped', color: 'var(--text-faint)' },
  checking: { label: 'Checking', color: 'var(--accent-2)' },
  error: { label: 'Error', color: 'var(--danger)' },
};

const MAX_TRACKER_ROWS = 14;

/** Occurrences of each key, sorted by the given comparator. */
function tally(keys: Iterable<string>, order: (a: [string, number], b: [string, number]) => number) {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.entries()].sort(order);
}

export function Sidebar({
  className = '',
  torrents,
  status,
  filter,
  onFilter,
  trackerHosts,
  compact,
  onTool,
  showProgress,
  showConsole = true,
}: SidebarProps) {
  // One pass per poll for everything the panel counts, rather than a filter
  // per status row and a reduce per total.
  const counts = useMemo(() => countByStatus(torrents), [torrents]);
  const totals = useMemo(() => {
    const sum = { size: 0, down: 0, up: 0 };
    for (const torrent of torrents) {
      sum.size += torrent.size;
      sum.down += torrent.downTotal;
      sum.up += torrent.upTotal;
    }
    return sum;
  }, [torrents]);
  const labels = useMemo(
    () => tally(torrents.map((torrent) => torrent.label).filter(Boolean), (a, b) => a[0].localeCompare(b[0])),
    [torrents],
  );
  const trackers = useMemo(
    () => tally(torrents.map((torrent) => trackerHosts[torrent.hash]).filter(Boolean), (a, b) => b[1] - a[1]),
    [torrents, trackerHosts],
  );

  const isActive = (kind: Filter['kind'], value: string) =>
    filter.kind === kind && filter.value === value;

  return (
    <nav className={`sidebar ${className}`} aria-label="Filters">
      <div className="side-group">
        <h4>Status</h4>
        {STATUS_FILTERS.map((value) => {
          const { label, color } = STATUS_LOOK[value];
          return (
            <button
              key={value}
              className={`side-item ${isActive('status', value) ? 'active' : ''}`}
              aria-pressed={isActive('status', value)}
              onClick={() => onFilter({ kind: 'status', value })}
            >
              {color ? <span className="side-dot" style={{ background: color }} /> : <IconList size={14} />}
              <span className="label">{label}</span>
              <span className="count">{counts[value]}</span>
            </button>
          );
        })}
      </div>

      {labels.length > 0 && (
        <div className="side-group">
          <h4>Labels</h4>
          {labels.map(([label, count]) => (
            <button
              key={label}
              className={`side-item ${isActive('label', label) ? 'active' : ''}`}
              aria-pressed={isActive('label', label)}
              onClick={() => onFilter({ kind: 'label', value: label })}
            >
              <IconTag size={14} />
              <span className="label">{label}</span>
              <span className="count">{count}</span>
            </button>
          ))}
        </div>
      )}

      {trackers.length > 0 && (
        <div className="side-group">
          <h4>Trackers</h4>
          {trackers.slice(0, MAX_TRACKER_ROWS).map(([host, count]) => (
            <button
              key={host}
              className={`side-item ${isActive('tracker', host) ? 'active' : ''}`}
              aria-pressed={isActive('tracker', host)}
              onClick={() => onFilter({ kind: 'tracker', value: host })}
              title={host}
            >
              <IconGlobe size={14} />
              <span className="label">{host}</span>
              <span className="count">{count}</span>
            </button>
          ))}
          {trackers.length > MAX_TRACKER_ROWS && (
            <div className="side-more">…and {trackers.length - MAX_TRACKER_ROWS} more</div>
          )}
        </div>
      )}

      {compact && onTool && (
        <div className="side-group">
          <h4>Tools</h4>
          {showProgress && (
            <button className="side-item" onClick={() => onTool('progress')}>
              <IconTrophy size={14} />
              <span className="label">Progress &amp; badges</span>
            </button>
          )}
          <button className="side-item" onClick={() => onTool('throttles')}>
            <IconGauge size={14} />
            <span className="label">Throttle groups</span>
          </button>
          {showConsole && (
            <button className="side-item" onClick={() => onTool('console')}>
              <IconTerminal size={14} />
              <span className="label">API console</span>
            </button>
          )}
          <button className="side-item" onClick={() => onTool('settings')}>
            <IconSettings size={14} />
            <span className="label">rtorrent settings</span>
          </button>
        </div>
      )}

      <div className="side-stats">
        <div>
          <span>Torrents</span>
          <b>{torrents.length}</b>
        </div>
        <div>
          <span>Total size</span>
          <b>{bytes(totals.size)}</b>
        </div>
        <div>
          <span>Downloaded</span>
          <b>{bytes(totals.down)}</b>
        </div>
        <div>
          <span>Uploaded</span>
          <b>{bytes(totals.up)}</b>
        </div>
        <div>
          <span>Down rate</span>
          <b>{rate(status?.downRate ?? 0)}</b>
        </div>
        <div>
          <span>Up rate</span>
          <b>{rate(status?.upRate ?? 0)}</b>
        </div>
        <div>
          <span>Down limit</span>
          <b>{status?.downLimit ? rate(status.downLimit) : '∞'}</b>
        </div>
        <div>
          <span>Up limit</span>
          <b>{status?.upLimit ? rate(status.upLimit) : '∞'}</b>
        </div>
        {status?.diskFree != null && (
          <div>
            <span>Free space</span>
            <b>{bytes(status.diskFree)}</b>
          </div>
        )}
        <div>
          <span>Listen port</span>
          <b>{status?.listenPort || '—'}</b>
        </div>
        <div>
          <span>DHT nodes</span>
          <b>{status?.dhtNodes ?? 0}</b>
        </div>
      </div>
    </nav>
  );
}
