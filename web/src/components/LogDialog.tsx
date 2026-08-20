import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal, useToast } from './ui';

export function LogDialog({ onClose }: { onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const toast = useToast();

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

  return (
    <Modal
      title="rtorrent log"
      wide
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <pre className="console-output log-view" style={{ maxHeight: '60vh' }}>
        {lines.length > 0 ? lines.join('\n') : 'Log is empty — set RT_LOG_LEVEL to raise verbosity.'}
      </pre>
    </Modal>
  );
}
