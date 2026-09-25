import { TORRENT_PRIORITIES } from '../format';
import type { Policy, ThrottleGroup } from '../types';
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
  setLabel: (hashes: string[]) => void;
  changeDirectory: (hashes: string[]) => void;
  copyMagnets: (hashes: string[]) => void;
  remove: (deleteData: boolean, hashes: string[]) => void;
}

interface TorrentMenuProps {
  x: number;
  y: number;
  /** The torrents the menu applies to: the selection, or the row it opened on. */
  targets: string[];
  throttles: ThrottleGroup[];
  /** The backend's feature map; a missing entry counts as supported. */
  supports: Record<string, boolean> | undefined;
  /** What the server allows; unknown until the first poll, and permissive until then. */
  policy: Policy | undefined;
  actions: MenuActions;
  onClose: () => void;
}

const UNSUPPORTED = 'Not supported by this rtorrent build';

/**
 * The right-click (or long-press, or context-menu key) menu for one or several
 * torrents. It offers only what will work: an item this rtorrent build lacks
 * is disabled with the reason, and one the server has switched off is not
 * shown at all — both used to be offered and then refused.
 */
export function TorrentMenu({ x, y, targets, throttles, supports, policy, actions, onClose }: TorrentMenuProps) {
  const has = (feature: string) => supports?.[feature] !== false;
  // Every item closes the menu first, then acts — a stale menu over a
  // confirmation dialog would be the alternative.
  const pick = (act: () => void) => () => {
    onClose();
    act();
  };
  const run = (action: string) => pick(() => actions.run(action, targets));
  return (
    <ContextMenu
      x={x}
      y={y}
      label={targets.length === 1 ? 'Torrent actions' : `Actions for ${targets.length} torrents`}
      onClose={onClose}
    >
      <MenuItem icon={<IconPlay size={13} />} label="Start" onClick={run('start')} />
      <MenuItem icon={<IconPause size={13} />} label="Pause" onClick={run('pause')} />
      <MenuItem icon={<IconPlay size={13} />} label="Resume" onClick={run('resume')} />
      <MenuItem icon={<IconStop size={12} />} label="Stop" onClick={run('stop')} />
      <MenuItem icon={<IconRefresh size={13} />} label="Force recheck" onClick={run('recheck')} />
      <MenuItem
        icon={<IconRefresh size={13} />}
        label="Recheck & restart"
        onClick={pick(() => actions.recheckRestart(targets))}
      />
      <MenuItem
        icon={<IconRefresh size={13} />}
        label="Announce to trackers"
        disabled={!has('trackerAnnounce')}
        title={has('trackerAnnounce') ? undefined : UNSUPPORTED}
        onClick={run('announce')}
      />
      <hr />
      <div className="heading">Priority</div>
      {TORRENT_PRIORITIES.map(({ value, label }) => (
        <MenuItem key={value} label={label} onClick={pick(() => actions.patch({ priority: value }, targets))} />
      ))}
      {has('perTorrentThrottle') && (
        <>
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
        </>
      )}
      <hr />
      <MenuItem
        icon={<IconTag size={13} />}
        label="Set label…"
        disabled={!has('labels')}
        title={has('labels') ? undefined : UNSUPPORTED}
        onClick={pick(() => actions.setLabel(targets))}
      />
      <MenuItem
        icon={<IconMove size={13} />}
        label="Change directory…"
        onClick={pick(() => actions.changeDirectory(targets))}
      />
      <MenuItem
        icon={<IconLink size={13} />}
        label={targets.length === 1 ? 'Copy magnet link' : 'Copy magnet links'}
        onClick={pick(() => actions.copyMagnets(targets))}
      />
      <hr />
      <MenuItem icon={<IconTrash size={13} />} label="Remove torrent" onClick={pick(() => actions.remove(false, targets))} />
      {policy?.deleteData !== false && (
        <MenuItem
          icon={<IconTrash size={13} />}
          label="Remove + delete data"
          danger
          onClick={pick(() => actions.remove(true, targets))}
        />
      )}
    </ContextMenu>
  );
}
