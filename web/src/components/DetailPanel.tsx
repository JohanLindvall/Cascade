import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { bytes, duration, fileName, percent, rate, relative, timestamp } from '../format';
import type { Peer, Torrent, TorrentFile, Tracker } from '../types';
import { IconClose, IconFile, IconGlobe, IconInfo, IconUsers } from './icons';
import { ProgressBar, useToast } from './ui';

type Tab = 'general' | 'files' | 'peers' | 'trackers';

const PRIORITY_LABELS: Record<number, string> = { 0: 'skip', 1: 'normal', 2: 'high' };

interface DetailPanelProps {
  torrent: Torrent;
  onClose: () => void;
  onHeightChange: (height: number) => void;
  height: number;
}

export function DetailPanel({ torrent, onClose, onHeightChange, height }: DetailPanelProps) {
  const [tab, setTab] = useState<Tab>('general');
  const [files, setFiles] = useState<TorrentFile[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const toast = useToast();
  const hash = torrent.hash;

  const refresh = useCallback(async () => {
    try {
      if (tab === 'files') setFiles(await api.files(hash));
      else if (tab === 'peers') setPeers(await api.peers(hash));
      else if (tab === 'trackers') setTrackers(await api.trackers(hash));
    } catch (error) {
      toast.error(error);
    }
  }, [hash, tab, toast]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const dragState = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    const onMove = (event: globalThis.MouseEvent) => {
      if (!dragState.current) return;
      const delta = dragState.current.startY - event.clientY;
      onHeightChange(
        Math.min(window.innerHeight - 200, Math.max(140, dragState.current.startHeight + delta)),
      );
    };
    const onUp = () => {
      dragState.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onHeightChange]);

  const setFilePriority = async (index: number, priority: number) => {
    try {
      await api.setFilePriority(hash, index, priority);
      setFiles((current) =>
        current.map((file) => (file.index === index ? { ...file, priority } : file)),
      );
    } catch (error) {
      toast.error(error);
    }
  };

  const toggleTracker = async (index: number, enabled: boolean) => {
    try {
      await api.setTrackerEnabled(hash, index, enabled);
      setTrackers((current) =>
        current.map((tracker) => (tracker.index === index ? { ...tracker, enabled } : tracker)),
      );
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <section className="detail" style={{ height }}>
      <div
        className="detail-resize"
        onMouseDown={(event) => {
          dragState.current = { startY: event.clientY, startHeight: height };
        }}
      />
      <div className="detail-head">
        <div className="detail-title" title={torrent.name}>
          {torrent.name}
        </div>
        <div className="tabs">
          <TabButton tab="general" current={tab} onClick={setTab} icon={<IconInfo size={13} />}>
            General
          </TabButton>
          <TabButton tab="files" current={tab} onClick={setTab} icon={<IconFile size={13} />}>
            Files
          </TabButton>
          <TabButton tab="peers" current={tab} onClick={setTab} icon={<IconUsers size={13} />}>
            Peers
          </TabButton>
          <TabButton tab="trackers" current={tab} onClick={setTab} icon={<IconGlobe size={13} />}>
            Trackers
          </TabButton>
        </div>
        <button className="btn icon ghost" onClick={onClose} aria-label="Close details">
          <IconClose size={15} />
        </button>
      </div>

      <div className="detail-body">
        {tab === 'general' && <General torrent={torrent} />}

        {tab === 'files' && (
          <table className="grid">
            <thead>
              <tr>
                <th>File</th>
                <th style={{ textAlign: 'right' }}>Size</th>
                <th style={{ width: 170 }}>Progress</th>
                <th style={{ width: 130 }}>Priority</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.index}>
                  <td className="wrap" title={file.path}>
                    {fileName(file.path)}
                    {file.path.includes('/') && (
                      <div style={{ color: 'var(--text-faint)', fontSize: 11 }}>{file.path}</div>
                    )}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {bytes(file.size)}
                  </td>
                  <td>
                    <div className="progress-cell">
                      <ProgressBar
                        value={file.progress}
                        variant={file.progress >= 1 ? 'done' : file.priority === 0 ? 'idle' : 'default'}
                      />
                      <span className="num">{percent(file.progress, 0)}</span>
                    </div>
                  </td>
                  <td>
                    <select
                      className="select"
                      style={{ height: 26, fontSize: 12 }}
                      value={file.priority}
                      onChange={(event) => void setFilePriority(file.index, Number(event.target.value))}
                    >
                      {[0, 1, 2].map((value) => (
                        <option key={value} value={value}>
                          {PRIORITY_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {files.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ color: 'var(--text-faint)' }}>
                    No file information available.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {tab === 'peers' && (
          <table className="grid">
            <thead>
              <tr>
                <th>Address</th>
                <th>Client</th>
                <th style={{ width: 150 }}>Progress</th>
                <th style={{ textAlign: 'right' }}>Down</th>
                <th style={{ textAlign: 'right' }}>Up</th>
                <th style={{ textAlign: 'right' }}>Downloaded</th>
                <th style={{ textAlign: 'right' }}>Uploaded</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((peer) => (
                <tr key={`${peer.address}:${peer.port}:${peer.id}`}>
                  <td className="num">
                    {peer.address}:{peer.port}
                  </td>
                  <td>{peer.client || '—'}</td>
                  <td>
                    <div className="progress-cell">
                      <ProgressBar value={peer.progress} variant={peer.progress >= 1 ? 'done' : 'default'} />
                      <span className="num">{percent(peer.progress, 0)}</span>
                    </div>
                  </td>
                  <td className="num rate-num down" style={{ textAlign: 'right' }}>
                    {rate(peer.downRate)}
                  </td>
                  <td className="num rate-num up" style={{ textAlign: 'right' }}>
                    {rate(peer.upRate)}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {bytes(peer.downTotal)}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {bytes(peer.upTotal)}
                  </td>
                  <td style={{ display: 'flex', gap: 4 }}>
                    {peer.encrypted && <span className="tag">enc</span>}
                    {peer.obfuscated && <span className="tag">obf</span>}
                    {peer.incoming && <span className="tag">in</span>}
                    {peer.snubbed && <span className="tag">snub</span>}
                  </td>
                </tr>
              ))}
              {peers.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ color: 'var(--text-faint)' }}>
                    No peers connected.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {tab === 'trackers' && (
          <table className="grid">
            <thead>
              <tr>
                <th>URL</th>
                <th>Group</th>
                <th style={{ textAlign: 'right' }}>Seeders</th>
                <th style={{ textAlign: 'right' }}>Leechers</th>
                <th style={{ textAlign: 'right' }}>Downloaded</th>
                <th>Last scrape</th>
                <th style={{ textAlign: 'right' }}>OK / fail</th>
                <th>Enabled</th>
              </tr>
            </thead>
            <tbody>
              {trackers.map((tracker) => (
                <tr key={tracker.index}>
                  <td className="wrap" title={tracker.url}>
                    {tracker.url}
                  </td>
                  <td className="num">{tracker.group}</td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {tracker.seeders || '—'}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {tracker.leechers || '—'}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {tracker.downloaded || '—'}
                  </td>
                  <td className="num">{relative(tracker.lastScrape)}</td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {tracker.successes} / {tracker.failures}
                  </td>
                  <td>
                    <input
                      className="check"
                      type="checkbox"
                      checked={tracker.enabled}
                      onChange={(event) => void toggleTracker(tracker.index, event.target.checked)}
                    />
                  </td>
                </tr>
              ))}
              {trackers.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ color: 'var(--text-faint)' }}>
                    No trackers.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function TabButton({
  tab,
  current,
  onClick,
  icon,
  children,
}: {
  tab: Tab;
  current: Tab;
  onClick: (tab: Tab) => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`tab ${current === tab ? 'active' : ''}`}
      onClick={() => onClick(tab)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
    >
      {icon}
      {children}
    </button>
  );
}

function General({ torrent }: { torrent: Torrent }) {
  const rows: Array<[string, React.ReactNode]> = [
    ['Status', torrent.status],
    ['Size', bytes(torrent.size)],
    ['Completed', `${bytes(torrent.completed)} (${percent(torrent.progress)})`],
    ['Remaining', bytes(torrent.left)],
    ['Downloaded', bytes(torrent.downTotal)],
    ['Uploaded', bytes(torrent.upTotal)],
    ['Ratio', torrent.ratio.toFixed(3)],
    ['Down rate', rate(torrent.downRate)],
    ['Up rate', rate(torrent.upRate)],
    ['ETA', torrent.progress >= 1 ? '—' : duration(torrent.eta)],
    ['Peers', `${torrent.peersConnected} connected / ${torrent.peersNotConnected} known`],
    ['Seeds', String(torrent.peersComplete)],
    ['Trackers', String(torrent.trackerCount)],
    ['Priority', ['off', 'low', 'normal', 'high'][torrent.priority] ?? String(torrent.priority)],
    ['Label', torrent.label || '—'],
    ['Throttle group', torrent.throttle || 'global'],
    ['Chunks', `${torrent.chunksDone} / ${torrent.chunksTotal} × ${bytes(torrent.chunkSize)}`],
    ['Private', torrent.isPrivate ? 'yes' : 'no'],
    ['Multi-file', torrent.isMultiFile ? 'yes' : 'no'],
    ['Directory', torrent.directory || '—'],
    ['Base path', torrent.basePath || '—'],
    ['Hash', torrent.hash],
    ['Added', timestamp(torrent.addedAt)],
    ['Started', timestamp(torrent.startedAt)],
    ['Finished', timestamp(torrent.finishedAt)],
    ['Created', timestamp(torrent.createdAt)],
  ];
  return (
    <>
      {torrent.message && (
        <div className="banner" style={{ marginBottom: 12, borderRadius: 9 }}>
          {torrent.message}
        </div>
      )}
      <div className="kv-grid">
        {rows.map(([key, value]) => (
          <div className="kv" key={key}>
            <span>{key}</span>
            <b title={typeof value === 'string' ? value : undefined}>{value}</b>
          </div>
        ))}
      </div>
    </>
  );
}
