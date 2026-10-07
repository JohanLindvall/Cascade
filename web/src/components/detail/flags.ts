// SPDX-License-Identifier: MIT

/**
 * The tags of a peer's Flags cell and a tracker's State cell. The cell holds
 * one line however many there are (.flags in styles.css): as many as its
 * fixed column has room for, then an ellipsis. Each list therefore starts
 * with what the column is scanned for, what is wrong (bad, then warn), then
 * the good and the plain details most rows share, so the tags left out of
 * a narrow cell are the least telling. The cell's title names them all, and
 * the expanded row each in words, for touch screens and screen readers alike.
 */
import type { Peer, Tracker } from '../../types';

export interface Flag {
  label: string;
  title: string;
  tone?: 'good' | 'warn' | 'bad';
}

export function peerFlags(peer: Peer): Flag[] {
  const flags: Flag[] = [];
  if (peer.banned) flags.push({ label: 'banned', title: 'Banned', tone: 'bad' });
  if (peer.snubbed) flags.push({ label: 'snub', title: 'Snubbed — sent us nothing recently', tone: 'warn' });
  if (peer.unwanted) flags.push({ label: 'unwanted', title: 'Marked unwanted', tone: 'warn' });
  if (peer.preferred) flags.push({ label: 'pref', title: 'Preferred peer', tone: 'good' });
  if (peer.encrypted) flags.push({ label: 'enc', title: 'Connection is encrypted', tone: 'good' });
  if (peer.obfuscated) flags.push({ label: 'obf', title: 'Header obfuscation in use' });
  if (peer.incoming) flags.push({ label: 'in', title: 'Peer connected to us' });
  return flags;
}

export function trackerFlags(tracker: Tracker): Flag[] {
  const flags: Flag[] = [];
  if (tracker.failures > 0 && tracker.successes === 0) {
    flags.push({ label: 'failing', title: 'No successful announce yet', tone: 'bad' });
  }
  if (!tracker.usable) flags.push({ label: 'unusable', title: 'Not currently usable', tone: 'warn' });
  if (tracker.busy) flags.push({ label: 'announcing', title: 'Request in flight' });
  if (tracker.open) flags.push({ label: 'open', title: 'Connection open' });
  if (tracker.extra) flags.push({ label: 'extra', title: 'Added at runtime, not from the torrent' });
  if (flags.length === 0 && tracker.successes > 0) {
    flags.push({ label: 'ok', title: 'Announced successfully', tone: 'good' });
  }
  return flags;
}

/** The cell's title: every flag and what it means, one to a line, those the cell has no room for too. */
export function flagsTitle(flags: Flag[]): string | undefined {
  return flags.length > 0 ? flags.map((flag) => `${flag.label}: ${flag.title}`).join('\n') : undefined;
}
