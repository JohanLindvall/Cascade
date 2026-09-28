import type { ReactNode, RefObject } from 'react';
import {
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
} from '../components/icons';
import { SORT_OPTIONS } from '../components/TorrentTable';
import { defaultSortDir, type SortKey, type SortState } from '../sort';

interface ToolbarProps {
  /** The phone layout: a drawer button and a sort control take the headers' place. */
  compact: boolean;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  /** How many visible rows the actions reach, and how many selected rows the filter hides. */
  selected: number;
  hidden: number;
  onClearSelection: () => void;
  onAction: (action: 'start' | 'pause' | 'stop' | 'recheck') => void;
  onRemove: () => void;
  onLabel: () => void;
  /** Labels are a backend feature (d.custom1); false greys the button out. */
  labelsSupported: boolean;
  sort: SortState;
  onSort: (sort: SortState) => void;
  onLog: () => void;
  search: string;
  onSearch: (text: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}

/** One toolbar button: an icon, and a label the compact layout hides (styles.css). */
function Tool({
  icon,
  label,
  onClick,
  disabled,
  title,
  name = label,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  /** The accessible name, when the label alone is too terse: it is all a compact button has. */
  name?: string;
  danger?: boolean;
}) {
  return (
    <button
      className={danger ? 'btn sm danger' : 'btn sm'}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={name}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** The actions on the selection, the sort control of the compact layout, the log and the search. */
export function Toolbar({
  compact,
  drawerOpen,
  onToggleDrawer,
  selected,
  hidden,
  onClearSelection,
  onAction,
  onRemove,
  onLabel,
  labelsSupported,
  sort,
  onSort,
  onLog,
  search,
  onSearch,
  searchRef,
}: ToolbarProps) {
  const none = selected === 0;
  return (
    <div className="toolbar">
      <button
        className="btn sm compact-only"
        onClick={onToggleDrawer}
        title="Filters"
        aria-label="Filters"
        aria-expanded={drawerOpen}
      >
        <IconFilter size={14} />
      </button>
      <Tool icon={<IconPlay size={12} />} label="Start" onClick={() => onAction('start')} disabled={none} />
      <Tool icon={<IconPause size={13} />} label="Pause" onClick={() => onAction('pause')} disabled={none} />
      <Tool icon={<IconStop size={12} />} label="Stop" onClick={() => onAction('stop')} disabled={none} />
      <Tool icon={<IconTrash size={13} />} label="Remove" onClick={onRemove} disabled={none} title="Remove (Delete)" danger />

      <div className="divider" />

      <Tool icon={<IconRefresh size={13} />} label="Recheck" onClick={() => onAction('recheck')} disabled={none} />
      <Tool
        icon={<IconTag size={13} />}
        label="Label"
        onClick={onLabel}
        disabled={none || !labelsSupported}
        title={labelsSupported ? undefined : 'Not supported by this rtorrent build'}
      />

      {compact && (
        <>
          <select
            className="select sort-select"
            value={sort.key}
            aria-label="Sort by"
            // Picking a column keeps the direction if it is the same one.
            onChange={(event) => {
              const key = event.target.value as SortKey;
              onSort({ key, dir: key === sort.key ? sort.dir : defaultSortDir(key) });
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            className="btn sm"
            onClick={() => onSort({ key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
            aria-label={`Sort direction: ${sort.dir === 'asc' ? 'ascending' : 'descending'}`}
            title="Sort direction"
          >
            {sort.dir === 'asc' ? '▲' : '▼'}
          </button>
        </>
      )}

      {(selected > 0 || hidden > 0) && (
        <span className="selection-pill">
          {selected} selected
          {hidden > 0 && (
            <span
              className="pill-hidden"
              title="Selected, but hidden by the current filter or search — actions skip them until they are shown again"
            >
              +{hidden} hidden
            </span>
          )}
          <button className="btn sm ghost pill-clear" onClick={onClearSelection}>
            clear
          </button>
        </span>
      )}

      <div className="header-spacer" />

      <Tool icon={<IconList size={13} />} label="Log" onClick={onLog} title="rtorrent log" name="rtorrent log" />

      <div className="search">
        <IconSearch size={14} />
        <input
          ref={searchRef}
          className="input"
          placeholder="Search torrents… ( / )"
          aria-label="Search torrents"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            onSearch('');
            event.currentTarget.blur();
          }}
        />
        {search && (
          <button
            className="search-clear"
            onClick={() => {
              onSearch('');
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
  );
}
