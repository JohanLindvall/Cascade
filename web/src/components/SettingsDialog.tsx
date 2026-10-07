// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { bytes, formatRateInput, interval, parseWholeNumber, rate } from '../format';
import { useMounted } from '../hooks';
import { redactSecrets } from '../redact';
import { appliedRate, parseGlobalRate, settingsPatch } from '../settings';
import type { BackendSummary, Settings } from '../types';
import { IconRefresh } from './icons';
import { Field, ParsedInput, Switch } from './form';
import { Modal } from './modal';
import { useToast } from './toast';
import { KvGrid } from './ui';

interface SettingsDialogProps {
  onClose: () => void;
  backend: BackendSummary | null;
  /** The refresh-interval preference, ms; null leaves it to the server. */
  statePollMs: number | null;
  /** The server's own interval (CASCADE_STATE_POLL_MS); null before the first state. */
  statePollDefaultMs: number | null;
  onStatePollChange: (statePollMs: number | null) => void;
}

const ENCRYPTION_PRESETS = [
  { value: 'none', label: 'Disabled' },
  { value: 'allow_incoming,try_outgoing', label: 'Allow incoming, try outgoing' },
  { value: 'allow_incoming,try_outgoing,enable_retry', label: 'Allow incoming, try outgoing, retry' },
  { value: 'require,require_RC4,allow_incoming,enable_retry', label: 'Require encryption (RC4)' },
];

/** Refresh intervals on offer, ms: faster than 100 shows nothing new and costs rtorrent. */
const POLL_INTERVALS = [100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000];

const PRELOAD_TYPES = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'madvise' },
  { value: 2, label: 'Direct paging' },
];

/** The keys of Settings whose value has a given type, so a number field cannot be pointed at a switch. */
type KeysOfType<V> = { [K in keyof Settings]-?: NonNullable<Settings[K]> extends V ? K : never }[keyof Settings];
type NumberKey = KeysOfType<number>;
type TextKey = KeysOfType<string>;
type BoolKey = KeysOfType<boolean>;

/**
 * Live rtorrent settings, grouped by domain: bandwidth, peers, network,
 * trackers & DHT, storage & disk, torrent & file names, resource limits.
 * Every field name doubles as a feature key in the backend's capability map,
 * so a control this rtorrent build cannot apply is greyed out rather than
 * silently ignored.
 */
export function SettingsDialog({
  onClose, backend, statePollMs, statePollDefaultMs, onStatePollChange,
}: SettingsDialogProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  // Untouched until the select changes, so a preference that arrives while
  // the dialog is open is shown rather than overwritten by a stale copy.
  const [poll, setPoll] = useState<number | null | undefined>(undefined);
  const shownPoll = poll === undefined ? statePollMs : poll;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Settings>({});
  // Fields whose text does not parse; Apply waits until there are none.
  const [invalid, setInvalid] = useState<ReadonlySet<keyof Settings>>(new Set());
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const alive = useMounted();

  const load = useCallback(() => {
    setLoadError(null);
    api
      .settings()
      .then((value) => {
        setSettings(value);
        setDraft(value);
      })
      .catch((error: unknown) => setLoadError(redactSecrets(error instanceof Error ? error.message : String(error))));
  }, []);

  useEffect(load, [load]);

  const supports = (feature: string) => backend?.supports?.[feature] !== false;
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  /** Record a parsed field: its value when valid, its key in `invalid` when not. */
  const commit = (key: NumberKey, value: number | null) => {
    setInvalid((current) => {
      const next = new Set(current);
      if (value === null) next.add(key);
      else next.delete(key);
      return next;
    });
    if (value !== null) set(key, value);
  };

  const save = async () => {
    if (busy || invalid.size > 0) return;
    // A preference of this interface rather than an rtorrent setting: it is
    // saved with the others, and the server reads at the new pace straight away.
    if (poll !== undefined && poll !== statePollMs) onStatePollChange(poll);
    setBusy(true);
    try {
      const patch = settingsPatch(settings ?? {}, draft);
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      const updated = await api.saveSettings(patch);
      setSettings(updated);
      setDraft(updated);
      toast.push('success', 'Settings applied');
      if (alive.current) onClose();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  /**
   * A whole-number setting. Text rather than type="number": a controlled
   * number input turned a lone "-" into 0 (so -1 could not be typed), applied
   * 0 when cleared, and changed value under a scrolling mouse wheel.
   */
  const numberField = (key: NumberKey, label: string, opts: { hint?: string; min?: number; max?: number } = {}) => {
    const min = opts.min ?? 0;
    const max = opts.max ?? Number.MAX_SAFE_INTEGER;
    return (
      <Field
        label={label}
        hint={opts.hint}
        error={invalid.has(key) ? (opts.max === undefined ? `A whole number, ${min} or more` : `A whole number from ${min} to ${max}`) : undefined}
      >
        <ParsedInput
          inputMode="numeric"
          disabled={!supports(key)}
          initial={draft[key] === undefined ? '' : String(draft[key])}
          parse={(text) => {
            const value = parseWholeNumber(text, min);
            return value !== null && value <= max ? value : null;
          }}
          onValue={(value) => commit(key, value)}
        />
      </Field>
    );
  };

  /**
   * A global rate limit, typed the way the throttle dialog takes them. The
   * hint is what rtorrent will hold: the rate rounded up to whole KiB/s.
   */
  const rateField = (key: 'downloadRate' | 'uploadRate', label: string) => (
    <Field
      label={label}
      hint={draft[key] ? rate(appliedRate(draft[key] ?? 0)) : 'unlimited'}
      error={invalid.has(key) ? 'Not a rate under 4 GiB/s — try 500k, 2M or 800 B/s' : undefined}
    >
      <ParsedInput
        placeholder="unlimited — e.g. 500k, 2M"
        disabled={!supports(key)}
        initial={formatRateInput(settings?.[key] ?? 0)}
        parse={parseGlobalRate}
        onValue={(value) => commit(key, value)}
      />
    </Field>
  );

  const textField = (key: TextKey, label: string, opts: { hint?: string; placeholder?: string } = {}) => (
    <Field label={label} hint={opts.hint}>
      <input
        className="input"
        placeholder={opts.placeholder}
        disabled={!supports(key)}
        value={String(draft[key] ?? '')}
        onChange={(event) => set(key, event.target.value)}
      />
    </Field>
  );

  const switchField = (key: BoolKey, label: string, hint?: string) => (
    <Switch
      checked={!!draft[key]}
      disabled={!supports(key)}
      onChange={(value) => set(key, value)}
      label={label}
      hint={hint}
    />
  );

  if (!settings) {
    return (
      <Modal title="rtorrent settings" onClose={onClose}>
        {loadError ? (
          <div className="banner">
            <span className="grow">Could not read the settings: {loadError}</span>
            <button className="btn sm ghost" onClick={load}>
              <IconRefresh size={13} />
              <span>Retry</span>
            </button>
          </div>
        ) : (
          <div className="faint">Loading…</div>
        )}
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
          <span className="foot-note">Changes apply live and are not written back to rtorrent.rc</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => void save()}
            disabled={busy || invalid.size > 0}
            title={invalid.size > 0 ? 'Fix the fields marked in red first' : undefined}
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </>
      }
    >
      <fieldset className="form-fields" disabled={busy}>
        <div className="section">
          <h3>Bandwidth &amp; slots</h3>
          <div className="form-grid">
            {rateField('downloadRate', 'Global download limit')}
            {rateField('uploadRate', 'Global upload limit')}
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
            {textField('portRange', 'Listening port range', {
              // Applying it over XML-RPC does not rebind a running rtorrent
              // (AGENTS.md quirk 6): saying so beats a field that looks applied.
              hint: 'Live changes do not rebind or persist. Set RT_PORT_RANGE and restart the container.',
            })}
            {textField('bindAddress', 'Bind address', { hint: 'all connections' })}
            {textField('localAddress', 'Address reported to trackers')}
            {supports('bindAddressV4') &&
              textField('bindAddressV4', 'Bind address (IPv4)', { hint: 'rtorrent 0.16+' })}
            {supports('bindAddressV6') &&
              textField('bindAddressV6', 'Bind address (IPv6)', { hint: 'rtorrent 0.16+' })}
            {/* 0.16 refuses a proxy without its scheme, which 0.9 took. */}
            {textField('proxyAddress', 'HTTP proxy for announces', { placeholder: 'http://host:port' })}
            {supports('proxyHttp') &&
              textField('proxyHttp', 'HTTP proxy (all HTTP)', {
                hint: 'rtorrent 0.16+',
                placeholder: 'http://host:port',
              })}
            {/* rtorrent crashes on a host name here (CheckProxyHost in the server). */}
            {supports('proxyGlobal') &&
              textField('proxyGlobal', 'Global proxy (all traffic)', {
                hint: 'rtorrent 0.16+ · by IPv4 address, not by name',
                placeholder: 'socks5://10.0.0.1:1080',
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
            {switchField('portRandom', 'Randomise listening port (next start)')}
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
            {numberField('dhtPort', 'DHT port', {
              max: 65535,
              hint: supports('dhtPort') ? undefined : 'read-only on rtorrent 0.16.1+: the port DHT runs on, 0 while it is off',
            })}
            {supports('dhtOverridePort') &&
              numberField('dhtOverridePort', 'DHT announce port override', {
                hint: '0 uses the listening port',
                max: 65535,
              })}
            {textField('httpCapath', 'Trusted CA directory', { hint: 'for tracker TLS' })}
            {textField('httpCacert', 'Trusted CA bundle', { hint: 'for tracker TLS' })}
          </div>
          <div className="switch-row">
            {switchField('udpTrackers', 'UDP trackers', supports('udpTrackers') ? undefined : 'always on from rtorrent 0.16.12')}
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
              hint: draft.preloadMinRate ? rate(draft.preloadMinRate) : 'bytes/s',
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
          <h3>Torrent &amp; file names</h3>
          <div className="switch-row">
            {switchField(
              'useSanitizedName',
              'List torrents under their saved name',
              supports('useSanitizedName')
                ? 'A / in a torrent’s name is saved as _; off, the list shows the / as the torrent has it'
                : 'rtorrent 0.16.22+',
            )}
            {switchField(
              'allowLegacyUtf8',
              'Use a torrent’s UTF-8 names',
              supports('allowLegacyUtf8')
                ? 'name.utf-8 and path.utf-8, which older torrents carry beside a legacy-encoded name — this changes where such files are saved'
                : 'rtorrent 0.16.25+',
            )}
          </div>
          {/* rtorrent names a torrent as it loads it (AGENTS.md quirk 6). */}
          <p className="section-note">
            rtorrent applies both as it loads a torrent: a change here reaches the torrents added after it, until
            rtorrent restarts and loads every torrent as RT_USE_SANITIZED_NAME and RT_ALLOW_LEGACY_UTF8 say.
          </p>
        </div>

        <div className="section">
          <h3>Resource limits</h3>
          <div className="form-grid">
            {numberField('maxOpenFiles', 'Max open files', {
              hint: supports('maxOpenFiles') ? undefined : 'read-only on rtorrent 0.16.15+',
            })}
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

        <div className="section">
          <h3>Interface</h3>
          <div className="form-grid">
            <Field label="Refresh interval" hint="how often rtorrent is read while a page is open">
              <select
                className="select"
                value={shownPoll === null ? '' : String(shownPoll)}
                onChange={(event) => setPoll(event.target.value === '' ? null : Number(event.target.value))}
              >
                <option value="">
                  {statePollDefaultMs === null ? 'Server default' : `Server default (${interval(statePollDefaultMs)})`}
                </option>
                {POLL_INTERVALS.map((ms) => (
                  <option key={ms} value={ms}>
                    {interval(ms)}
                  </option>
                ))}
                {shownPoll !== null && !POLL_INTERVALS.includes(shownPoll) && (
                  <option value={shownPoll}>{interval(shownPoll)}</option>
                )}
              </select>
            </Field>
          </div>
        </div>

        {backend && (
          <div className="section">
            <h3>Backend</h3>
            <KvGrid
              rows={[
                ['Client', backend.clientVersion],
                ['libtorrent', backend.libraryVersion],
                ['Flavor', backend.flavor],
                ['API version', backend.apiVersion],
                ...(backend.rpcFacility ? [['RPC facility', backend.rpcFacility] as [string, string]] : []),
                ['SCGI endpoint', backend.endpoint],
                ['Commands exposed', String(backend.methodCount)],
              ]}
            />
          </div>
        )}
      </fieldset>
    </Modal>
  );
}
