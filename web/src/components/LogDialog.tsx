import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { logDay, logTime, parseLogLine } from '../format';
import { usePolling } from '../hooks';
import { redactSecrets } from '../redact';
import type { LogScopes } from '../types';
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

  const load = useCallback(
    async (isCurrent: () => boolean) => {
      try {
        const result = await api.log();
        // rtorrent echoes tracker URLs, passkeys and all, into its log.
        if (isCurrent()) setLines(result.lines.map(redactSecrets));
      } catch (error) {
        if (isCurrent()) toast.error(error);
      }
    },
    [toast],
  );
  usePolling(load, 4000);

  useEffect(() => {
    const view = viewRef.current;
    if (view && stickToEnd.current) view.scrollTop = view.scrollHeight;
  }, [lines]);

  /**
   * The lines as rows: a clock in the viewer's own timezone instead of raw
   * epoch seconds, the level as a colour, and a separator wherever the day
   * changes — the times alone would otherwise be ambiguous across a log that
   * spans midnight. Anything that is not a log line is shown verbatim.
   */
  const rows = useMemo(() => {
    let day = '';
    return lines.map((raw, index) => {
      const line = parseLogLine(raw);
      const rowDay = line.at ? logDay(line.at) : '';
      const newDay = rowDay !== '' && rowDay !== day;
      if (newDay) day = rowDay;
      return (
        <Fragment key={index}>
          {newDay && <div className="log-day">{rowDay}</div>}
          {line.at ? (
            <div className={`log-row ${line.level}`}>
              <span className="log-time" title={line.at.toLocaleString()}>
                {logTime(line.at)}
              </span>
              {line.level && <span className="log-level">{line.level}</span>}
              <span className="log-text">{line.text}</span>
            </div>
          ) : (
            <div className="log-row">
              <span className="log-text">{raw}</span>
            </div>
          )}
        </Fragment>
      );
    });
  }, [lines]);

  return (
    <Modal
      title="rtorrent log"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="foot-note">Refreshes every few seconds; scroll up to pause following.</span>
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
        ref={viewRef}
        onScroll={(event) => {
          const view = event.currentTarget;
          stickToEnd.current = view.scrollHeight - view.scrollTop - view.clientHeight < 48;
        }}
      >
        {lines.length > 0 ? (
          rows
        ) : scopes?.supported ? (
          'Log is empty — raise a scope above to see more.'
        ) : (
          'Log is empty — set RT_LOG_LEVEL to raise verbosity.'
        )}
      </pre>
    </Modal>
  );
}
