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

const PRELOAD_TYPES = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'madvise' },
  { value: 2, label: 'Direct paging' },
];

/**
 * Live rtorrent settings, grouped by domain: bandwidth, peers, network,
 * trackers & DHT, storage & disk, resource limits. Every field name doubles as
 * a feature key in the backend's capability map, so a control this rtorrent
 * build cannot apply is greyed out rather than silently ignored.
 */
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
    opts: { hint?: string; min?: number } = {},
  ) => (
    <Field label={label} hint={opts.hint}>
      <input
        className="input"
        type="number"
        min={opts.min ?? 0}
        disabled={!supports(key)}
        value={String(draft[key] ?? '')}
        onChange={(event) => set(key, Number(event.target.value) as never)}
      />
    </Field>
  );

  const textField = (
    key: keyof Settings,
    label: string,
    opts: { hint?: string; placeholder?: string } = {},
  ) => (
    <Field label={label} hint={opts.hint}>
      <input
        className="input"
        placeholder={opts.placeholder}
        disabled={!supports(key)}
        value={String(draft[key] ?? '')}
        onChange={(event) => set(key, event.target.value as never)}
      />
    </Field>
  );

  const switchField = (key: keyof Settings, label: string) => (
    <Switch
      checked={!!draft[key]}
      disabled={!supports(key)}
      onChange={(value) => set(key, value as never)}
      label={label}
    />
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
        <h3>Bandwidth &amp; slots</h3>
        <div className="form-grid">
          <Field
            label="Global download limit"
            hint={draft.downloadRate ? bytes(draft.downloadRate) + '/s' : 'unlimited'}
          >
            <input
              className="input"
              placeholder="unlimited — e.g. 500k, 2M"
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
              placeholder="unlimited — e.g. 500k, 2M"
              defaultValue={formatRateInput(settings.uploadRate ?? 0)}
              onChange={(event) => set('uploadRate', parseRate(event.target.value))}
            />
          </Field>
          {numberField('maxUploads', 'Max upload slots per torrent')}
          {numberField('minUploads', 'Min upload slots per torrent')}
          {numberField('maxDownloads', 'Max download slots per torrent')}
          {numberField('minDownloads', 'Min download slots per torrent')}
          {numberField('maxUploadsGlobal', 'Max upload slots (all torrents)', {
            hint: '0 = unlimited',
          })}
          {numberField('maxDownloadsGlobal', 'Max download slots (all torrents)', {
            hint: '0 = unlimited',
          })}
        </div>
      </div>

      <div className="section">
        <h3>Peers</h3>
        <div className="form-grid">
          {numberField('minPeers', 'Min peers while leeching')}
          {numberField('maxPeers', 'Max peers while leeching')}
          {numberField('minPeersSeed', 'Min peers while seeding', { hint: '-1 disables', min: -1 })}
          {numberField('maxPeersSeed', 'Max peers while seeding', { hint: '-1 disables', min: -1 })}
          {numberField('trackersNumwant', 'Peers requested per announce', {
            hint: '-1 = tracker default',
            min: -1,
          })}
        </div>
        <div className="switch-row">{switchField('pex', 'Peer exchange (PEX)')}</div>
      </div>

      <div className="section">
        <h3>Network</h3>
        <div className="form-grid">
          {textField('portRange', 'Listening port range', { hint: 'e.g. 50000-50000' })}
          {textField('bindAddress', 'Bind address', { hint: 'all connections' })}
          {textField('localAddress', 'Address reported to trackers')}
          {supports('bindAddressV4') &&
            textField('bindAddressV4', 'Bind address (IPv4)', { hint: 'rtorrent 0.16+' })}
          {supports('bindAddressV6') &&
            textField('bindAddressV6', 'Bind address (IPv6)', { hint: 'rtorrent 0.16+' })}
          {textField('proxyAddress', 'HTTP proxy for announces', { placeholder: 'host:port' })}
          {supports('proxyHttp') &&
            textField('proxyHttp', 'HTTP proxy (all HTTP)', {
              hint: 'rtorrent 0.16+',
              placeholder: 'host:port',
            })}
          {supports('proxyGlobal') &&
            textField('proxyGlobal', 'Global proxy (all traffic)', {
              hint: 'rtorrent 0.16+',
              placeholder: 'host:port',
            })}
          <Field label="Protocol encryption" hint="write-only — cannot be read back">
            <select
              className="select"
              disabled={!supports('encryption')}
              value={String(draft.encryption ?? '')}
              onChange={(event) => set('encryption', event.target.value)}
            >
              <option value="">(leave unchanged)</option>
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
        <div className="switch-row">
          {switchField('portRandom', 'Randomise listening port')}
          {supports('portOpen') && switchField('portOpen', 'Open the listening port')}
          {supports('blockOutgoing') && switchField('blockOutgoing', 'Block outgoing connections')}
        </div>
      </div>

      <div className="section">
        <h3>Trackers &amp; DHT</h3>
        <div className="form-grid">
          <Field label="DHT mode" hint="write-only — disable · off · auto · on">
            <select
              className="select"
              disabled={!supports('dhtMode')}
              value={String(draft.dhtMode ?? '')}
              onChange={(event) => set('dhtMode', event.target.value)}
            >
              <option value="">(leave unchanged)</option>
              {['disable', 'off', 'auto', 'on'].map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </Field>
          {numberField('dhtPort', 'DHT port')}
          {supports('dhtOverridePort') &&
            numberField('dhtOverridePort', 'DHT announce port override', {
              hint: '0 uses the listening port',
            })}
          {textField('httpCapath', 'Trusted CA directory', { hint: 'for tracker TLS' })}
          {textField('httpCacert', 'Trusted CA bundle', { hint: 'for tracker TLS' })}
        </div>
        <div className="switch-row">
          {switchField('udpTrackers', 'UDP trackers')}
          {supports('sslVerifyPeer') &&
            switchField('sslVerifyPeer', 'Verify tracker TLS certificates')}
          {supports('sslVerifyHost') &&
            switchField('sslVerifyHost', 'Verify tracker TLS hostnames')}
        </div>
      </div>

      <div className="section">
        <h3>Storage &amp; disk</h3>
        <div className="form-grid">
          {textField('directory', 'Default download directory')}
          <Field label="Session directory" hint="read-only — set with RT_SESSION_DIR">
            <input className="input" value={String(settings.sessionDirectory ?? '')} readOnly />
          </Field>
          {numberField('memoryMax', 'Piece memory limit', {
            hint: draft.memoryMax ? bytes(draft.memoryMax) : 'bytes',
          })}
          {numberField('maxFileSize', 'Largest accepted file', {
            hint: draft.maxFileSize ? bytes(draft.maxFileSize) : 'bytes',
          })}
          {numberField('syncTimeout', 'Disk sync timeout', { hint: 'seconds' })}
          <Field label="Piece preload" hint="how pieces are read for uploading">
            <select
              className="select"
              disabled={!supports('preloadType')}
              value={String(draft.preloadType ?? 0)}
              onChange={(event) => set('preloadType', Number(event.target.value))}
            >
              {PRELOAD_TYPES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          {numberField('preloadMinSize', 'Preload for torrents over', {
            hint: draft.preloadMinSize ? bytes(draft.preloadMinSize) : 'bytes',
          })}
          {numberField('preloadMinRate', 'Preload above upload rate', {
            hint: draft.preloadMinRate ? bytes(draft.preloadMinRate) + '/s' : 'bytes/s',
          })}
        </div>
        <div className="switch-row">
          {switchField('preallocate', 'Preallocate files')}
          {switchField('checkHashOnCompletion', 'Verify hash on completion')}
          {supports('adviseRandomHashing') &&
            switchField('adviseRandomHashing', 'Random-access hint while hashing')}
        </div>
      </div>

      <div className="section">
        <h3>Resource limits</h3>
        <div className="form-grid">
          {numberField('maxOpenFiles', 'Max open files')}
          {numberField('maxOpenSockets', 'Max open sockets')}
          {numberField('maxHttpOpen', 'Max concurrent HTTP requests', {
            hint: supports('maxHttpOpen') ? undefined : 'read-only on rtorrent 0.16+',
          })}
          {supports('httpMaxHostConnections') &&
            numberField('httpMaxHostConnections', 'HTTP connections per host', {
              hint: 'rtorrent 0.16+',
            })}
          {numberField('dnsCacheTimeout', 'DNS cache timeout', { hint: 'seconds' })}
          {numberField('receiveBuffer', 'Socket receive buffer', {
            hint: draft.receiveBuffer ? bytes(draft.receiveBuffer) : 'bytes, 0 = OS default',
          })}
          {numberField('sendBuffer', 'Socket send buffer', {
            hint: draft.sendBuffer ? bytes(draft.sendBuffer) : 'bytes, 0 = OS default',
          })}
          {numberField('xmlrpcSizeLimit', 'XML-RPC size limit', {
            hint: draft.xmlrpcSizeLimit ? bytes(draft.xmlrpcSizeLimit) : 'bytes',
          })}
          {numberField('maxUploadsDiv', 'Upload slot divider', { hint: '0 disables' })}
          {numberField('maxDownloadsDiv', 'Download slot divider', { hint: '0 disables' })}
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
            {backend.rpcFacility && (
              <div className="kv">
                <span>RPC facility</span>
                <b>{backend.rpcFacility}</b>
              </div>
            )}
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
