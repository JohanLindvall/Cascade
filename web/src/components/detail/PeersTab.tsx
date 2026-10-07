// SPDX-License-Identifier: MIT

import { Fragment, memo, type ReactNode } from 'react';
import { bytes, hostPort, percent, rate } from '../../format';
import type { Peer } from '../../types';
import { ProgressBar } from '../ui';
import { Flags, MiniKv, NoteRow, RowToggle, useExpanded, yesNo, type Flag } from './parts';

const COLUMNS = 9;

function peerFlags(peer: Peer): Flag[] {
  const flags: Flag[] = [];
  if (peer.encrypted) flags.push({ label: 'enc', title: 'Connection is encrypted', tone: 'good' });
  if (peer.obfuscated) flags.push({ label: 'obf', title: 'Header obfuscation in use' });
  if (peer.incoming) flags.push({ label: 'in', title: 'Peer connected to us' });
  if (peer.preferred) flags.push({ label: 'pref', title: 'Preferred peer', tone: 'good' });
  if (peer.snubbed) flags.push({ label: 'snub', title: 'Snubbed — sent us nothing recently', tone: 'warn' });
  if (peer.unwanted) flags.push({ label: 'unwanted', title: 'Marked unwanted', tone: 'warn' });
  if (peer.banned) flags.push({ label: 'banned', title: 'Banned', tone: 'bad' });
  return flags;
}

/**
 * An address that may wrap after any colon, so a narrow screen breaks it
 * between groups rather than inside one. <wbr> adds nothing to a copy, which
 * a zero-width space would.
 */
function breakAtColons(text: string): ReactNode[] {
  return text.split(':').flatMap((part, i) => (i === 0 ? [part] : [':', <wbr key={i} />, part]));
}

/** The connected peers; a row expands to everything rtorrent says about the peer. Memoized, as FilesTab. */
export const PeersTab = memo(function PeersTab({ peers }: { peers: Peer[] | undefined }) {
  const [isOpen, toggle] = useExpanded();
  return (
    <table className="grid peers-grid">
      <thead>
        <tr>
          <th className="col-address">Address</th>
          <th>Client</th>
          <th className="col-progress">Progress</th>
          <th className="right col-down">Down</th>
          <th className="right col-up">Up</th>
          <th className="right col-swarm" title="What this peer is pulling from the swarm">
            Swarm
          </th>
          <th className="right col-down-total">Downloaded</th>
          <th className="right col-up-total">Uploaded</th>
          <th className="col-flags">Flags</th>
        </tr>
      </thead>
      <tbody>
        {peers?.map((peer) => {
          const key = `${peer.address}:${peer.port}`;
          const endpoint = hostPort(peer.address, peer.port);
          const open = isOpen(key);
          return (
            <Fragment key={key}>
              <tr className={open ? 'expandable open' : 'expandable'} onClick={() => toggle(key)}>
                <td className="num clip" title={endpoint}>
                  <RowToggle open={open} onToggle={() => toggle(key)}>
                    {endpoint}
                  </RowToggle>
                </td>
                <td>{peer.client || '—'}</td>
                <td>
                  <div className="progress-cell">
                    <ProgressBar
                      value={peer.progress}
                      variant={peer.progress >= 1 ? 'done' : 'default'}
                      label={`Progress of peer ${endpoint}`}
                    />
                    <span className="num">{percent(peer.progress, 0)}</span>
                  </div>
                </td>
                <td className="num right rate-num down">{rate(peer.downRate)}</td>
                <td className="num right rate-num up">{rate(peer.upRate)}</td>
                <td className="num right faint">{rate(peer.peerRate)}</td>
                <td className="num right">{bytes(peer.downTotal)}</td>
                <td className="num right">{bytes(peer.upTotal)}</td>
                <td>
                  <Flags flags={peerFlags(peer)} />
                </td>
              </tr>
              {open && (
                <tr className="detail-row">
                  <td colSpan={COLUMNS}>
                    <MiniKv
                      rows={[
                        // Whole here, where the column above can show only its start.
                        ['Address', breakAtColons(endpoint), 'wide'],
                        ['Peer ID', peer.id || '—'],
                        ['Client', peer.client || 'unknown'],
                        ['Extensions', peer.options || '—'],
                        ['Direction', peer.incoming ? 'incoming' : 'outgoing'],
                        ['Encryption', peer.encrypted ? 'encrypted' : 'plaintext'],
                        ['Obfuscated header', yesNo(peer.obfuscated)],
                        ['Preferred', yesNo(peer.preferred)],
                        ['Snubbed', yesNo(peer.snubbed)],
                        ['Unwanted', yesNo(peer.unwanted)],
                        ['Banned', yesNo(peer.banned)],
                        ['Swarm rate', rate(peer.peerRate)],
                        ['Swarm total', bytes(peer.peerTotal)],
                      ]}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
        {!peers && <NoteRow span={COLUMNS}>Loading…</NoteRow>}
        {peers?.length === 0 && <NoteRow span={COLUMNS}>No peers connected.</NoteRow>}
      </tbody>
    </table>
  );
});
