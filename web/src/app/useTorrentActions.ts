// SPDX-License-Identifier: MIT

import { useCallback, useMemo } from 'react';
import { api, type BulkResult } from '../api';
import { useDialogs } from '../components/dialogs';
import { useToast } from '../components/toast';
import type { MenuActions } from '../components/TorrentMenu';
import { magnetLink, nameErrors } from '../format';
import { sharedValue } from '../sharedValue';
import type { Policy, Torrent } from '../types';
import { copyToClipboard } from './dom';

const NO_DATA_DELETE =
  'Deleting data is switched off on this server (CASCADE_ALLOW_DATA_DELETE) — Delete alone removes the torrent and keeps its data.';

export interface TorrentActions {
  /** Run an action on each torrent; false when any failed (and was toasted). */
  run: (action: string, hashes?: string[]) => Promise<boolean>;
  recheckRestart: (hashes?: string[]) => Promise<void>;
  remove: (deleteData: boolean, hashes?: string[]) => Promise<void>;
  patch: (patch: Record<string, unknown>, hashes?: string[]) => Promise<void>;
  promptLabel: (hashes?: string[]) => Promise<void>;
  promptDirectory: (hashes?: string[]) => Promise<void>;
  copyMagnets: (hashes: string[]) => Promise<void>;
  /** The same, in the shape the torrent menu takes. */
  menu: MenuActions;
}

interface Context {
  /** What an action without explicit hashes applies to: the visible selection. */
  targets: string[];
  byHash: ReadonlyMap<string, Torrent>;
  /** Labels in use, offered when setting one. */
  labels: string[];
  policy: Policy | undefined;
  /** rtorrent's default directory, the placeholder of "Change directory". */
  downloadDir: string;
  /** After torrents are removed: the selection is gone with them. */
  onRemoved: () => void;
}

/**
 * Everything the toolbar, the keyboard and the torrent menu can do to
 * torrents. Each reports its own failures as toasts — by torrent name, one
 * per failure — so callers only decide what to act on. The state stream
 * shows the effect: the server reads rtorrent again after every change.
 */
export function useTorrentActions({ targets, byHash, labels, policy, downloadDir, onRemoved }: Context): TorrentActions {
  const toast = useToast();
  const dialogs = useDialogs();
  const nameOf = useCallback((hash: string) => byHash.get(hash)?.name, [byHash]);
  const names = useCallback((hashes: string[]) => hashes.map((hash) => nameOf(hash) || hash), [nameOf]);

  /** Toast each failure a bulk call reports; true when there were none. */
  const report = useCallback(
    (result: BulkResult) => {
      for (const error of nameErrors(result.errors, nameOf)) toast.push('error', error);
      return result.errors.length === 0;
    },
    [nameOf, toast],
  );

  const run = useCallback(
    async (action: string, hashes: string[] = targets): Promise<boolean> => {
      if (hashes.length === 0) return false;
      try {
        return report(await api.bulkAction(hashes, action));
      } catch (error) {
        toast.error(error);
        return false;
      }
    },
    [targets, report, toast],
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
      if (hashes.length === 0 || !(await run('recheck-restart', hashes))) return;
      toast.push(
        'info',
        `Rechecking ${hashes.length === 1 ? 'torrent' : `${hashes.length} torrents`} — starting again when the check completes`,
      );
    },
    [targets, run, toast],
  );

  const remove = useCallback(
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
        items: names(hashes),
        confirmLabel: deleteData ? 'Remove and delete' : 'Remove',
        danger: deleteData,
      });
      if (!ok) return;
      try {
        if (report(await api.remove(hashes, deleteData))) {
          toast.push('success', `Removed ${hashes.length} torrent${hashes.length === 1 ? '' : 's'}`);
        }
        onRemoved();
      } catch (error) {
        toast.error(error);
      }
    },
    [targets, policy, dialogs, names, report, toast, onRemoved],
  );

  const patch = useCallback(
    async (change: Record<string, unknown>, hashes: string[] = targets) => {
      if (hashes.length === 0) return;
      try {
        report(await api.patchEach(hashes, change));
      } catch (error) {
        toast.error(error);
      }
    },
    [targets, report, toast],
  );

  const promptLabel = useCallback(
    async (hashes: string[] = targets) => {
      if (hashes.length === 0) return;
      const label = await dialogs.prompt({
        title: 'Set label',
        label: 'Label',
        message: 'Leave it empty to clear the label.',
        items: names(hashes),
        initial: sharedValue(byHash, hashes, (torrent) => torrent.label) ?? '',
        placeholder: 'none',
        suggestions: labels,
        confirmLabel: 'Apply',
      });
      if (label !== null) await patch({ label: label.trim() }, hashes);
    },
    [targets, dialogs, names, byHash, labels, patch],
  );

  const promptDirectory = useCallback(
    async (hashes: string[] = targets) => {
      if (hashes.length === 0) return;
      const directory = await dialogs.prompt({
        title: 'Change directory',
        label: 'Directory',
        message:
          'The torrent will be stopped and its download path changed. Move any downloaded files yourself, then use Recheck & restart.',
        items: names(hashes),
        initial: sharedValue(byHash, hashes, (torrent) => torrent.directory) ?? '',
        placeholder: downloadDir || '/downloads',
        confirmLabel: 'Change directory',
      });
      if (directory?.trim()) await patch({ directory: directory.trim() }, hashes);
    },
    [targets, dialogs, names, byHash, downloadDir, patch],
  );

  const copyMagnets = useCallback(
    async (hashes: string[]) => {
      const links = hashes.map((hash) => magnetLink(hash, nameOf(hash)));
      try {
        await copyToClipboard(links.join('\n'));
        toast.push('success', `Copied ${links.length === 1 ? 'magnet link' : `${links.length} magnet links`}`);
      } catch {
        toast.push('error', 'Could not write to the clipboard');
      }
    },
    [nameOf, toast],
  );

  return useMemo(
    () => ({
      run,
      recheckRestart,
      remove,
      patch,
      promptLabel,
      promptDirectory,
      copyMagnets,
      menu: {
        run: (action, hashes) => void run(action, hashes),
        recheckRestart: (hashes) => void recheckRestart(hashes),
        patch: (change, hashes) => void patch(change, hashes),
        setLabel: (hashes) => void promptLabel(hashes),
        changeDirectory: (hashes) => void promptDirectory(hashes),
        copyMagnets: (hashes) => void copyMagnets(hashes),
        remove: (deleteData, hashes) => void remove(deleteData, hashes),
      },
    }),
    [run, recheckRestart, remove, patch, promptLabel, promptDirectory, copyMagnets],
  );
}
