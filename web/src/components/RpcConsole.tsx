import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { IconTerminal } from './icons';
import { Field, Modal, useToast } from './ui';

/**
 * Direct access to every command rtorrent exposes — anything the typed UI does
 * not cover can be driven from here.
 */
export function RpcConsole({ onClose }: { onClose: () => void }) {
  const [methods, setMethods] = useState<string[]>([]);
  const [method, setMethod] = useState('system.listMethods');
  const [params, setParams] = useState('[]');
  const [output, setOutput] = useState('');
  const [fault, setFault] = useState(false);
  const [help, setHelp] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  // The command whose help was asked for last: a slower answer for an earlier
  // click must not overwrite it.
  const helpFor = useRef('');
  const toast = useToast();

  useEffect(() => {
    api
      .rpcMethods()
      .then((result) => setMethods(result.methods))
      .catch((error) => toast.error(error));
  }, [toast]);

  const { shown, hidden } = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = needle ? methods.filter((name) => name.toLowerCase().includes(needle)) : methods;
    return { shown: list.slice(0, 400), hidden: Math.max(0, list.length - 400) };
  }, [methods, filter]);

  const run = async () => {
    setBusy(true);
    setFault(false);
    try {
      let parsed: unknown[];
      try {
        const value = JSON.parse(params || '[]');
        parsed = Array.isArray(value) ? value : [value];
      } catch {
        throw new Error('Parameters must be a JSON array, e.g. ["", "main", "d.name="]');
      }
      const result = await api.rpc(method.trim(), parsed);
      if (result.ok) {
        setOutput(JSON.stringify(result.result, null, 2));
      } else {
        setFault(true);
        setOutput(`fault ${result.fault?.code}: ${result.fault?.message}`);
      }
    } catch (error) {
      setFault(true);
      setOutput(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (name: string) => {
    setMethod(name);
    setHelp('');
    helpFor.current = name;
    try {
      const result = await api.rpcHelp(name);
      if (helpFor.current === name) setHelp(result.help || '(no help text)');
    } catch {
      // No help is fine; the command still runs.
    }
  };

  return (
    <Modal
      title={
        <span className="title-with-icon">
          <IconTerminal size={16} /> rtorrent API console
        </span>
      }
      wide
      onClose={onClose}
      footer={
        <>
          <span className="foot-note">
            {methods.length} commands · also reachable over HTTP at <code>POST /RPC2</code>
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={() => void run()} disabled={busy}>
            {busy ? 'Running…' : 'Execute'}
          </button>
        </>
      }
    >
      <div className="console-layout">
        <div className="console-methods">
          <input
            className="input"
            placeholder="Filter commands…"
            aria-label="Filter commands"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="method-list">
            {shown.map((name) => (
              <button key={name} onClick={() => void pick(name)} title={name}>
                {name}
              </button>
            ))}
            {hidden > 0 && <div className="method-more">…{hidden} more — narrow the filter</div>}
            {shown.length === 0 && <div className="method-more">No matches</div>}
          </div>
        </div>

        <div className="console-main">
          <Field label="Command" hint={help || undefined}>
            <input
              className="input"
              value={method}
              onChange={(event) => setMethod(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && !busy && void run()}
            />
          </Field>
          <Field
            label="Parameters (JSON array)"
            hint='Example: ["", "main", "d.name=", "d.down.rate="]'
          >
            <textarea
              className="textarea"
              rows={3}
              value={params}
              onChange={(event) => setParams(event.target.value)}
            />
          </Field>
          <pre className={`console-output ${fault ? 'fault' : ''}`}>{output || '—'}</pre>
        </div>
      </div>
    </Modal>
  );
}
