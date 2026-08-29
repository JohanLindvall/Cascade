import { useEffect, useRef, useState } from 'react';
import { api, type LogScopes } from '../api';
import { Modal, useToast } from './ui';

export function LogDialog({ onClose }: { onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [scopes, setScopes] = useState<LogScopes | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const viewRef = useRef<HTMLPreElement>(null);
  // Follow the tail like `tail -f`, but stop the moment the user scrolls up.
  const stickToEnd = useRef(true);

  useEffect(() => {
    api
      .logScopes()
      .then(setScopes)
      .catch(() => setScopes(null)); // no row is better than a broken one
  }, []);

  /**
   * Toggle one scope. Raising takes effect immediately (log.add_output);
   * lowering cannot — rtorrent has no way to detach a scope — so it stays
   * live until rtorrent restarts and is simply not re-attached after. The
   * toast says which of the two just happened.
   */
  const toggleScope = async (scope: string, on: boolean) => {
    if (!scopes || saving) return;
    setSaving(true);
    try {
      const next = on
        ? [...scopes.extra, scope]
        : scopes.extra.filter((item) => item !== scope);
      const result = await api.setLogScopes(next);
      setScopes(result);
      if (result.failed.includes(scope)) {
        // The subsystem groups moved between releases (tracker_debug became
        // tracker_events, for one), so a refusal names the scope instead of
        // failing the whole change.
        toast.push('error', `This rtorrent build has no "${scope}" log scope`);
      } else if (on) toast.push('success', `Logging ${scope} — live now`);
      else if (result.stillActive.includes(scope)) {
        toast.push('info', `${scope} stays on until rtorrent restarts — there is no way to detach a scope`);
      }
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .log(500)
        .then((result) => !cancelled && setLines(result.lines))
        .catch((error) => !cancelled && toast.error(error));
    };
    load();
    const timer = window.setInterval(load, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [toast]);

  useEffect(() => {
    const view = viewRef.current;
    if (view && stickToEnd.current) view.scrollTop = view.scrollHeight;
  }, [lines]);

  return (
    <Modal
      title="rtorrent log"
      wide
      onClose={onClose}
      footer={
        <>
          <span style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>
            Refreshes every few seconds; scroll up to pause following.
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {scopes?.supported && (
        <div className="log-scopes">
          <span className="log-scopes-label">Verbosity</span>
          {scopes.boot.map((scope) => (
            <span
              key={`boot-${scope}`}
              className="tag accent"
              title="Set by RT_LOG_LEVEL at container start"
            >
              {scope}
            </span>
          ))}
          {scopes.available
            .filter((scope) => !scopes.boot.includes(scope))
            .map((scope) => {
              const on = scopes.extra.includes(scope);
              return (
                <button
                  key={scope}
                  className={`tag scope-toggle ${on ? 'on' : ''}`}
                  disabled={saving}
                  title={
                    on
                      ? 'Stop re-attaching this scope (stays live until rtorrent restarts)'
                      : 'Attach this scope to the log now'
                  }
                  onClick={() => void toggleScope(scope, !on)}
                >
                  {scope}
                </button>
              );
            })}
        </div>
      )}
      <pre
        className="console-output log-view"
        style={{ maxHeight: '60vh' }}
        ref={viewRef}
        onScroll={(event) => {
          const view = event.currentTarget;
          stickToEnd.current = view.scrollHeight - view.scrollTop - view.clientHeight < 48;
        }}
      >
        {lines.length > 0 ? lines.join('\n') : 'Log is empty — set RT_LOG_LEVEL to raise verbosity.'}
      </pre>
    </Modal>
  );
}
