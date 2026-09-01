import type { ThrottleGroup } from '../types';
import { ContextMenu, MenuItem } from './ui';
import {
  IconGauge,
  IconLink,
  IconMove,
  IconPause,
  IconPlay,
  IconRefresh,
  IconStop,
  IconTag,
  IconTrash,
} from './icons';

/** What the menu can do to its targets; each is handed the hashes it applies to. */
export interface MenuActions {
  run: (action: string, hashes: string[]) => void;
  recheckRestart: (hashes: string[]) => void;
  patch: (patch: Record<string, unknown>, hashes: string[]) => void;
  setLabel: () => void;
  changeDirectory: () => void;
  copyMagnets: (hashes: string[]) => void;
  remove: (deleteData: boolean, hashes: string[]) => void;
}

/** d.priority values, highest first, as the menu lists them. */
const PRIORITIES: Array<[number, string]> = [
  [3, 'High'],
  [2, 'Normal'],
  [1, 'Low'],
  [0, 'Off'],
];

interface TorrentMenuProps {
  x: number;
  y: number;
  /** The torrents the menu applies to: the selection, or the row it opened on. */
  targets: string[];
  throttles: ThrottleGroup[];
  actions: MenuActions;
  onClose: () => void;
}

/** The right-click (or long-press) menu for one or several torrents. */
export function TorrentMenu({ x, y, targets, throttles, actions, onClose }: TorrentMenuProps) {
  // Every item closes the menu first, then acts — a stale menu over a
  // confirmation dialog would be the alternative.
  const pick = (act: () => void) => () => {
    onClose();
    act();
  };
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <MenuItem icon={<IconPlay size={13} />} label="Start" onClick={pick(() => actions.run('start', targets))} />
      <MenuItem icon={<IconPause size={13} />} label="Pause" onClick={pick(() => actions.run('pause', targets))} />
      <MenuItem icon={<IconPlay size={13} />} label="Resume" onClick={pick(() => actions.run('resume', targets))} />
      <MenuItem icon={<IconStop size={12} />} label="Stop" onClick={pick(() => actions.run('stop', targets))} />
      <MenuItem
        icon={<IconRefresh size={13} />}
        label="Force recheck"
        onClick={pick(() => actions.run('recheck', targets))}
      />
      <MenuItem
        icon={<IconRefresh size={13} />}
        label="Recheck & restart"
        onClick={pick(() => actions.recheckRestart(targets))}
      />
      <MenuItem
        icon={<IconRefresh size={13} />}
        label="Announce to trackers"
        onClick={pick(() => actions.run('announce', targets))}
      />
      <hr />
      <div className="heading">Priority</div>
      {PRIORITIES.map(([value, label]) => (
        <MenuItem key={value} label={label} onClick={pick(() => actions.patch({ priority: value }, targets))} />
      ))}
      <hr />
      <div className="heading">Throttle group</div>
      <MenuItem
        icon={<IconGauge size={13} />}
        label="Global (none)"
        onClick={pick(() => actions.patch({ throttle: '' }, targets))}
      />
      {throttles.map((group) => (
        <MenuItem
          key={group.name}
          icon={<IconGauge size={13} />}
          label={group.name}
          onClick={pick(() => actions.patch({ throttle: group.name }, targets))}
        />
      ))}
      <hr />
      <MenuItem icon={<IconTag size={13} />} label="Set label…" onClick={pick(actions.setLabel)} />
      <MenuItem icon={<IconMove size={13} />} label="Change directory…" onClick={pick(actions.changeDirectory)} />
      <MenuItem icon={<IconLink size={13} />} label="Copy magnet link" onClick={pick(() => actions.copyMagnets(targets))} />
      <hr />
      <MenuItem icon={<IconTrash size={13} />} label="Remove torrent" onClick={pick(() => actions.remove(false, targets))} />
      <MenuItem
        icon={<IconTrash size={13} />}
        label="Remove + delete data"
        danger
        onClick={pick(() => actions.remove(true, targets))}
      />
    </ContextMenu>
  );
}
