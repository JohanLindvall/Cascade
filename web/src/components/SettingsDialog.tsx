import { useEffect, useState } from 'react';
import { api } from '../api';
import { bytes, formatRateInput, parseRate } from '../format';
import type { BackendSummary, Settings } from '../types';
import { Field, Modal, Switch, useToast } from './ui';

interface SettingsDialogProps {
  onClose: () => void;
  backend: BackendSummary | null;
}

const ENCRYPTION_PRESETS = [
  { value: 'none', label: 'Disabled' },
  { value: 'allow_incoming,try_outgoing', label: 'Allow incoming, try outgoing' },
  { value: 'allow_incoming,try_outgoing,enable_retry', label: 'Allow incoming, try outgoing, retry' },
  { value: 'require,require_RC4,allow_incoming,enable_retry', label: 'Require encryption (RC4)' },
];

export function SettingsDialog({ onClose, backend }: SettingsDialogProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api
      .settings()
      .then((value) => {
        setSettings(value);
        setDraft(value);
      })
      .catch((error) => toast.error(error));
  }, [toast]);

  const supports = (feature: string) => backend?.supports?.[feature] !== false;
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setBusy(true);
    try {
      const patch: Settings = {};
      for (const key of Object.keys(draft) as Array<keyof Settings>) {
        if (settings && draft[key] !== settings[key]) {
          (patch as Record<string, unknown>)[key] = draft[key];
        }
      }
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      const updated = await api.saveSettings(patch);
      setSettings(updated);
      setDraft(updated);
      toast.push('success', 'Settings applied');
      onClose();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  const numberField = (
    key: keyof Settings,
    label: string,
    hint?: string,
    feature?: string,
  ) => (
    <Field label={label} hint={hint}>
      <input
        className="input"
        type="number"
        min={0}
        disabled={feature ? !supports(feature) : false}
        value={String(draft[key] ?? '')}
        onChange={(event) => set(key, Number(event.target.value) as never)}
      />
    </Field>
  );

  if (!settings) {
    return (
      <Modal title="rtorrent settings" onClose={onClose}>
        <div style={{ color: 'var(--text-faint)' }}>Loading…</div>
      </Modal>
    );
  }

  return (
    <Modal
      title="rtorrent settings"
      wide
      onClose={onClose}
      footer={
        <>
          <span style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>
            Changes apply live and are not written back to rtorrent.rc
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </>
      }
    >
      <div className="section">
        <h3>Bandwidth</h3>
        <div className="form-grid">
          <Field
            label="Global download limit"
            hint={draft.downloadRate ? bytes(draft.downloadRate) + '/s' : 'unlimited'}
          >
            <input
              className="input"
              placeholder="unlimited"
              defaultValue={formatRateInput(settings.downloadRate ?? 0)}
              onChange={(event) => set('downloadRate', parseRate(event.target.value))}
            />
          </Field>
          <Field
            label="Global upload limit"
            hint={draft.uploadRate ? bytes(draft.uploadRate) + '/s' : 'unlimited'}
          >
            <input
              className="input"
              placeholder="unlimited"
              defaultValue={formatRateInput(settings.uploadRate ?? 0)}
              onChange={(event) => set('uploadRate', parseRate(event.target.value))}
            />
          </Field>
          {numberField('maxUploads', 'Upload slots per torrent')}
          {numberField('maxUploadsGlobal', 'Upload slots (global)', '0 = unlimited', 'maxUploadsGlobal')}
          {numberField('maxDownloads', 'Download slots per torrent')}
          {numberField(
            'maxDownloadsGlobal',
            'Download slots (global)',
            '0 = unlimited',
            'maxDownloadsGlobal',
          )}
        </div>
      </div>

      <div className="section">
        <h3>Peers &amp; connections</h3>
        <div className="form-grid">
          {numberField('minPeers', 'Min peers (leeching)', undefined, 'minPeers')}
          {numberField('maxPeers', 'Max peers (leeching)', undefined, 'maxPeers')}
          {numberField('minPeersSeed', 'Min peers (seeding)', '-1 disables', 'seedPeers')}
          {numberField('maxPeersSeed', 'Max peers (seeding)', '-1 disables', 'seedPeers')}
          {numberField('maxOpenFiles', 'Max open files', undefined, 'maxOpenFiles')}
          {numberField('maxHttpOpen', 'Max open HTTP requests', undefined, 'httpMaxOpen')}
        </div>
      </div>

      <div className="section">
        <h3>Network</h3>
        <div className="form-grid">
          <Field label="Listening port range" hint="e.g. 50000-50000">
            <input
              className="input"
              disabled={!supports('portRange')}
              value={String(draft.portRange ?? '')}
              onChange={(event) => set('portRange', event.target.value)}
            />
          </Field>
          <Field label="DHT mode" hint="disable · off · auto · on">
            <select
              className="select"
              disabled={!supports('dht')}
              value={String(draft.dhtMode ?? 'auto')}
              onChange={(event) => set('dhtMode', event.target.value)}
            >
              {['disable', 'off', 'auto', 'on'].map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </Field>
          {numberField('dhtPort', 'DHT port', undefined, 'dht')}
          <Field label="Protocol encryption">
            <select
              className="select"
              disabled={!supports('encryption')}
              value={String(draft.encryption ?? '')}
              onChange={(event) => set('encryption', event.target.value)}
            >
              {ENCRYPTION_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
              {draft.encryption &&
                !ENCRYPTION_PRESETS.some((preset) => preset.value === draft.encryption) && (
                  <option value={draft.encryption}>{draft.encryption}</option>
                )}
            </select>
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 22, marginTop: 14, flexWrap: 'wrap' }}>
          <Switch
            checked={!!draft.portRandom}
            disabled={!supports('portRange')}
            onChange={(value) => set('portRandom', value)}
            label="Randomise listening port"
          />
          <Switch
            checked={!!draft.pex}
            disabled={!supports('pex')}
            onChange={(value) => set('pex', value)}
            label="Peer exchange (PEX)"
          />
          <Switch
            checked={!!draft.udpTrackers}
            disabled={!supports('udpTrackers')}
            onChange={(value) => set('udpTrackers', value)}
            label="UDP trackers"
          />
        </div>
      </div>

      <div className="section">
        <h3>Storage</h3>
        <div className="form-grid">
          <Field label="Default download directory">
            <input
              className="input"
              value={String(draft.directory ?? '')}
              onChange={(event) => set('directory', event.target.value)}
            />
          </Field>
          <Field label="Session directory" hint="read-only — set with RT_SESSION_DIR">
            <input className="input" value={String(settings.sessionDirectory ?? '')} readOnly />
          </Field>
          <Field
            label="Piece memory limit"
            hint={draft.memoryMax ? bytes(draft.memoryMax) : undefined}
          >
            <input
              className="input"
              type="number"
              disabled={!supports('memoryLimit')}
              value={String(draft.memoryMax ?? '')}
              onChange={(event) => set('memoryMax', Number(event.target.value))}
            />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 22, marginTop: 14, flexWrap: 'wrap' }}>
          <Switch
            checked={!!draft.preallocate}
            disabled={!supports('preallocate')}
            onChange={(value) => set('preallocate', value)}
            label="Preallocate files"
          />
          <Switch
            checked={!!draft.checkHashOnCompletion}
            disabled={!supports('checkHashOnCompletion')}
            onChange={(value) => set('checkHashOnCompletion', value)}
            label="Verify hash on completion"
          />
        </div>
      </div>

      {backend && (
        <div className="section">
          <h3>Backend</h3>
          <div className="kv-grid">
            <div className="kv">
              <span>Client</span>
              <b>{backend.clientVersion}</b>
            </div>
            <div className="kv">
              <span>libtorrent</span>
              <b>{backend.libraryVersion}</b>
            </div>
            <div className="kv">
              <span>Flavor</span>
              <b>{backend.flavor}</b>
            </div>
            <div className="kv">
              <span>API version</span>
              <b>{backend.apiVersion}</b>
            </div>
            <div className="kv">
              <span>SCGI endpoint</span>
              <b>{backend.endpoint}</b>
            </div>
            <div className="kv">
              <span>Commands exposed</span>
              <b>{backend.methodCount}</b>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
