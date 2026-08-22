import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Modal, useToast } from './ui';

export function LogDialog({ onClose }: { onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const toast = useToast();
  const viewRef = useRef<HTMLPreElement>(null);
  // Follow the tail like `tail -f`, but stop the moment the user scrolls up.
  const stickToEnd = useRef(true);

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
