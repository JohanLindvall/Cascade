import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatRateInput, parseRate, rate } from '../format';
import type { BackendSummary, ThrottleGroup } from '../types';
import { IconPlus, IconTrash } from './icons';
import { Modal, useToast } from './ui';

/**
 * rtorrent has no per-torrent rate limit: it throttles by named group. Groups
 * are created with throttle.up/throttle.down and assigned with
 * d.throttle_name.set, which is what this dialog manages.
 */
export function ThrottleDialog({
  onClose,
  backend,
}: {
  onClose: () => void;
  backend: BackendSummary | null;
}) {
  const [groups, setGroups] = useState<ThrottleGroup[]>([]);
  const [rates, setRates] = useState<Record<string, { up: number; down: number }>>({});
  const [name, setName] = useState('');
  const [up, setUp] = useState('');
  const [down, setDown] = useState('');
  const toast = useToast();
  const supported = backend?.supports?.throttleGroups !== false;

  const load = async () => {
    try {
      const result = await api.throttles();
      setGroups(result.groups);
      setRates(result.rates);
    } catch (error) {
      toast.error(error);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    if (!name.trim()) {
      toast.push('error', 'Give the throttle group a name');
      return;
    }
    try {
      await api.saveThrottle({
        name: name.trim(),
        up: parseRate(up),
        down: parseRate(down),
      });
      setName('');
      setUp('');
      setDown('');
      await load();
      toast.push('success', 'Throttle group saved');
    } catch (error) {
      toast.error(error);
    }
  };

  const update = async (group: ThrottleGroup, patch: Partial<ThrottleGroup>) => {
    try {
      await api.saveThrottle({ ...group, ...patch });
      await load();
    } catch (error) {
      toast.error(error);
    }
  };

  const remove = async (group: ThrottleGroup) => {
    try {
      await api.deleteThrottle(group.name);
      await load();
      toast.push('info', `Throttle "${group.name}" removed (torrents fall back to global limits)`);
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <Modal
      title="Throttle groups"
      wide
      onClose={onClose}
      footer={
        <>
          <span style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>
            Assign a group to a torrent from its right-click menu.
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {!supported && (
        <div className="banner" style={{ borderRadius: 9 }}>
          This rtorrent build does not expose throttle groups.
        </div>
      )}

      <div className="section">
        <h3>New group</h3>
        <div className="form-grid">
          <div className="field">
            <label>Name</label>
            <input
              className="input"
              placeholder="slow"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field">
            <label>Download limit</label>
            <input
              className="input"
              placeholder="unlimited — e.g. 500k, 2M"
              value={down}
              onChange={(event) => setDown(event.target.value)}
            />
          </div>
          <div className="field">
            <label>Upload limit</label>
            <input
              className="input"
              placeholder="unlimited — e.g. 100k"
              value={up}
              onChange={(event) => setUp(event.target.value)}
            />
          </div>
          <div className="field">
            <label>&nbsp;</label>
            <button className="btn primary" onClick={() => void create()} disabled={!supported}>
              <IconPlus size={14} />
              Create
            </button>
          </div>
        </div>
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>Group</th>
            <th style={{ width: 160 }}>Download limit</th>
            <th style={{ width: 160 }}>Upload limit</th>
            <th style={{ textAlign: 'right' }}>Current down</th>
            <th style={{ textAlign: 'right' }}>Current up</th>
            <th style={{ width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.name}>
              <td>
                <span className="tag accent">{group.name}</span>
              </td>
              <td>
                <input
                  className="input"
                  style={{ height: 26 }}
                  defaultValue={formatRateInput(group.down)}
                  placeholder="unlimited"
                  onBlur={(event) => void update(group, { down: parseRate(event.target.value) })}
                />
              </td>
              <td>
                <input
                  className="input"
                  style={{ height: 26 }}
                  defaultValue={formatRateInput(group.up)}
                  placeholder="unlimited"
                  onBlur={(event) => void update(group, { up: parseRate(event.target.value) })}
                />
              </td>
              <td className="num rate-num down" style={{ textAlign: 'right' }}>
                {rate(rates[group.name]?.down ?? 0)}
              </td>
              <td className="num rate-num up" style={{ textAlign: 'right' }}>
                {rate(rates[group.name]?.up ?? 0)}
              </td>
              <td>
                <button
                  className="btn icon ghost sm danger"
                  onClick={() => void remove(group)}
                  aria-label="Delete"
                >
                  <IconTrash size={14} />
                </button>
              </td>
            </tr>
          ))}
          {groups.length === 0 && (
            <tr>
              <td colSpan={6} style={{ color: 'var(--text-faint)' }}>
                No throttle groups yet. Torrents use the global limits.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Modal>
  );
}
