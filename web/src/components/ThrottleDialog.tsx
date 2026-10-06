// SPDX-License-Identifier: MIT

import { useCallback, useRef, useState } from 'react';
import { api } from '../api';
import { formatRateInput, parseRate, rate } from '../format';
import { useMounted, usePolling } from '../hooks';
import type { BackendSummary, ThrottleGroup } from '../types';
import { useDialogs } from './dialogs';
import { IconPlus, IconTrash } from './icons';
import { Field, ParsedInput } from './form';
import { Modal } from './modal';
import { useToast } from './toast';

/** The server's rule for a group name (internal/store/throttle.go), checked here first. */
const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const RATE_ERROR = 'Not a rate — try 500k, 2M or 800 B/s';

type Rates = Record<string, { up: number; down: number }>;

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
  const [rates, setRates] = useState<Rates>({});
  const [name, setName] = useState('');
  const [down, setDown] = useState<number | null>(0);
  const [up, setUp] = useState<number | null>(0);
  // Bumped after a create, to reseed the rate inputs from empty.
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const alive = useMounted();
  const requestId = useRef(0);
  const toast = useToast();
  const dialogs = useDialogs();
  const supported = backend?.supports?.throttleGroups !== false;
  const nameError = name && (!NAME_RE.test(name.trim()) || ['NULL', '.', '..'].includes(name.trim()))
    ? 'Up to 32 letters, digits, "_", "." or "-"; NULL, . and .. are reserved' : undefined;

  const load = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      const id = ++requestId.current;
      const relevant = () => alive.current && isCurrent() && id === requestId.current;
      try {
        const result = await api.throttles();
        if (!relevant()) return;
        setGroups(result.groups);
        setRates(result.rates);
      } catch (error) {
        if (relevant()) toast.error(error);
      }
    },
    [toast, alive],
  );
  usePolling(load, 3000);

  const create = async () => {
    if (busy || !supported) return;
    if (!name.trim()) {
      toast.push('error', 'Give the throttle group a name');
      return;
    }
    if (nameError || up === null || down === null) return;
    setBusy(true);
    try {
      await api.saveThrottle({ name: name.trim(), up, down });
      setName('');
      setUp(0);
      setDown(0);
      setFormKey((key) => key + 1);
      await load();
      toast.push('success', 'Throttle group saved');
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  /** Save one limit on blur — but tabbing through an unchanged field is not a change. */
  const update = async (group: ThrottleGroup, which: 'up' | 'down', text: string) => {
    const value = parseRate(text);
    if (value === null) {
      toast.push('error', `${group.name}: ${RATE_ERROR.toLowerCase()}`);
      return;
    }
    if (value === group[which]) return;
    try {
      await api.patchThrottle(group.name, { [which]: value });
      await load();
    } catch (error) {
      toast.error(error);
    }
  };

  const remove = async (group: ThrottleGroup) => {
    const ok = await dialogs.confirm({
      title: 'Delete throttle group',
      message: `Torrents assigned to "${group.name}" fall back to the global limits. rtorrent cannot drop a group while running, so it is set to unlimited until the next restart.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteThrottle(group.name);
      await load();
      toast.push('info', `Throttle "${group.name}" removed`);
    } catch (error) {
      toast.error(error);
    }
  };

  const canCreate = supported && !busy && !!name.trim() && !nameError && up !== null && down !== null;

  return (
    <Modal
      title="Throttle groups"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="foot-note">Limits round up to whole KiB/s. Assign a group from a torrent’s right-click menu.</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {!supported && <div className="banner">This rtorrent build does not expose throttle groups.</div>}

      <form
        className="section"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <fieldset className="form-fields" disabled={busy || !supported}>
          <h3>New group</h3>
          <div className="form-grid">
            <Field label="Name" error={nameError}>
              <input
                className="input"
                placeholder="slow"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Download limit" error={down === null ? RATE_ERROR : undefined}>
              <ParsedInput
                key={`down-${formKey}`}
                initial=""
                placeholder="unlimited — e.g. 500k, 2M"
                parse={parseRate}
                onValue={setDown}
              />
            </Field>
            <Field label="Upload limit" error={up === null ? RATE_ERROR : undefined}>
              <ParsedInput
                key={`up-${formKey}`}
                initial=""
                placeholder="unlimited — e.g. 100k"
                parse={parseRate}
                onValue={setUp}
              />
            </Field>
            <div className="field">
              <span className="field-spacer" aria-hidden />
              <button className="btn primary" type="submit" disabled={!canCreate}>
                <IconPlus size={14} />
                <span>Create</span>
              </button>
            </div>
          </div>
        </fieldset>
      </form>

      <table className="grid throttle-grid">
        <thead>
          <tr>
            <th>Group</th>
            <th className="col-limit">Download limit</th>
            <th className="col-limit">Upload limit</th>
            <th className="right">Current down</th>
            <th className="right">Current up</th>
            <th className="col-delete">
              <span className="visually-hidden">Delete</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.name}>
              <td>
                <span className="tag accent">{group.name}</span>
              </td>
              {(['down', 'up'] as const).map((which) => (
                <td key={which}>
                  <ParsedInput
                    key={`${group.name}-${which}-${group[which]}`}
                    className="input compact"
                    disabled={!supported}
                    initial={formatRateInput(group[which])}
                    placeholder="unlimited"
                    aria-label={`${group.name} ${which === 'down' ? 'download' : 'upload'} limit`}
                    parse={parseRate}
                    onBlur={(event) => void update(group, which, event.target.value)}
                  />
                </td>
              ))}
              <td className="num right rate-num down">{rate(rates[group.name]?.down ?? 0)}</td>
              <td className="num right rate-num up">{rate(rates[group.name]?.up ?? 0)}</td>
              <td>
                <button
                  className="btn icon ghost sm danger"
                  onClick={() => void remove(group)}
                  aria-label={`Delete ${group.name}`}
                  title={`Delete ${group.name}`}
                >
                  <IconTrash size={14} />
                </button>
              </td>
            </tr>
          ))}
          {groups.length === 0 && (
            <tr>
              <td colSpan={6} className="faint">
                No throttle groups yet. Torrents use the global limits.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Modal>
  );
}
