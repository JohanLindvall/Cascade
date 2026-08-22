import { bytes, rate } from '../format';
import type { GlobalStatus, Torrent, TorrentStatus } from '../types';
import { IconGauge, IconGlobe, IconList, IconSettings, IconTag, IconTerminal, IconTrophy } from './icons';

export interface Filter {
  kind: 'status' | 'label' | 'tracker';
  value: string;
}

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
}

const STATUS_ORDER: Array<{ value: string; label: string; color?: string }> = [
  { value: 'all', label: 'All torrents' },
  { value: 'downloading', label: 'Downloading', color: 'var(--down)' },
  { value: 'seeding', label: 'Seeding', color: 'var(--ok)' },
  { value: 'active', label: 'Active', color: 'var(--accent)' },
  { value: 'paused', label: 'Paused', color: 'var(--warn)' },
  { value: 'stopped', label: 'Stopped', color: 'var(--text-faint)' },
  { value: 'checking', label: 'Checking', color: 'var(--accent-2)' },
  { value: 'error', label: 'Error', color: 'var(--danger)' },
];

const MAX_TRACKER_ROWS = 14;

export function matchesStatus(torrent: Torrent, value: string): boolean {
  if (value === 'all') return true;
  if (value === 'active') return torrent.downRate > 0 || torrent.upRate > 0;
  return torrent.status === (value as TorrentStatus);
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
}: SidebarProps) {
  const countFor = (value: string) => torrents.filter((t) => matchesStatus(t, value)).length;

  const labels = new Map<string, number>();
  for (const torrent of torrents) {
    const label = torrent.label || '';
    if (!label) continue;
    labels.set(label, (labels.get(label) ?? 0) + 1);
  }

  const trackers = new Map<string, number>();
  for (const torrent of torrents) {
    const host = trackerHosts[torrent.hash];
    if (!host) continue;
    trackers.set(host, (trackers.get(host) ?? 0) + 1);
  }

  const isActive = (kind: Filter['kind'], value: string) =>
    filter.kind === kind && filter.value === value;

  const totalDown = torrents.reduce((sum, t) => sum + t.downTotal, 0);
  const totalUp = torrents.reduce((sum, t) => sum + t.upTotal, 0);
  const totalSize = torrents.reduce((sum, t) => sum + t.size, 0);

  return (
    <nav className={`sidebar ${className}`}>
      <div className="side-group">
        <h4>Status</h4>
        {STATUS_ORDER.map((item) => (
          <button
            key={item.value}
            className={`side-item ${isActive('status', item.value) ? 'active' : ''}`}
            onClick={() => onFilter({ kind: 'status', value: item.value })}
          >
            {item.color ? (
              <span className="side-dot" style={{ background: item.color }} />
            ) : (
              <IconList size={14} />
            )}
            <span className="label">{item.label}</span>
            <span className="count">{countFor(item.value)}</span>
          </button>
        ))}
      </div>

      {labels.size > 0 && (
        <div className="side-group">
          <h4>Labels</h4>
          {[...labels.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([label, count]) => (
              <button
                key={label}
                className={`side-item ${isActive('label', label) ? 'active' : ''}`}
                onClick={() => onFilter({ kind: 'label', value: label })}
              >
                <IconTag size={14} />
                <span className="label">{label}</span>
                <span className="count">{count}</span>
              </button>
            ))}
        </div>
      )}

      {trackers.size > 0 && (
        <div className="side-group">
          <h4>Trackers</h4>
          {[...trackers.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, MAX_TRACKER_ROWS)
            .map(([host, count]) => (
              <button
                key={host}
                className={`side-item ${isActive('tracker', host) ? 'active' : ''}`}
                onClick={() => onFilter({ kind: 'tracker', value: host })}
                title={host}
              >
                <IconGlobe size={14} />
                <span className="label">{host}</span>
                <span className="count">{count}</span>
              </button>
            ))}
          {trackers.size > MAX_TRACKER_ROWS && (
            <div className="side-more">…and {trackers.size - MAX_TRACKER_ROWS} more</div>
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
          <button className="side-item" onClick={() => onTool('console')}>
            <IconTerminal size={14} />
            <span className="label">API console</span>
          </button>
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
          <b>{bytes(totalSize)}</b>
        </div>
        <div>
          <span>Downloaded</span>
          <b>{bytes(totalDown)}</b>
        </div>
        <div>
          <span>Uploaded</span>
          <b>{bytes(totalUp)}</b>
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
