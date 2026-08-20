import { useRef, useState, type DragEvent } from 'react';
import { api } from '../api';
import { bytes } from '../format';
import { IconClose, IconFile, IconUpload } from './icons';
import { Field, Modal, Switch, useToast } from './ui';

interface AddDialogProps {
  onClose: () => void;
  onAdded: () => void;
  defaultDirectory: string;
  labels: string[];
  /** Files dropped onto the window before the dialog opened. */
  initialFiles?: File[];
}

export function AddDialog({
  onClose,
  onAdded,
  defaultDirectory,
  labels,
  initialFiles,
}: AddDialogProps) {
  const [files, setFiles] = useState<File[]>(initialFiles ?? []);
  const [urls, setUrls] = useState('');
  const [directory, setDirectory] = useState('');
  const [label, setLabel] = useState('');
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const accepted = [...list].filter(
      (file) => file.name.toLowerCase().endsWith('.torrent') || file.type === 'application/x-bittorrent',
    );
    const rejected = list.length - accepted.length;
    if (rejected > 0) toast.push('info', `${rejected} file(s) ignored — only .torrent files are accepted`);
    setFiles((current) => [...current, ...accepted]);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };

  const submit = async () => {
    if (files.length === 0 && urls.trim() === '') {
      toast.push('error', 'Add at least one .torrent file, magnet link or URL');
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      for (const file of files) form.append('torrents', file);
      form.append('urls', urls);
      form.append('start', start ? '1' : '0');
      if (directory.trim()) form.append('directory', directory.trim());
      if (label.trim()) form.append('label', label.trim());
      const result = await api.upload(form);
      if (result.errors.length > 0) {
        for (const error of result.errors) toast.push('error', error);
      }
      if (result.added > 0) {
        toast.push('success', `Added ${result.added} torrent${result.added === 1 ? '' : 's'}`);
        onAdded();
        onClose();
      }
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add torrents"
      onClose={onClose}
      footer={
        <>
          <Switch checked={start} onChange={setStart} label="Start immediately" />
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </>
      }
    >
      <div
        className={`dropzone ${dragging ? 'over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <div className="glyph">
          <IconUpload size={26} />
        </div>
        <strong>Drop .torrent files here</strong>
        <span>or click to browse — multiple files are fine</span>
        <input
          ref={inputRef}
          type="file"
          accept=".torrent,application/x-bittorrent"
          multiple
          hidden
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </div>

      {files.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {files.map((file, index) => (
            <div className="file-chip" key={`${file.name}-${index}`}>
              <IconFile size={14} />
              <span className="name" title={file.name}>
                {file.name}
              </span>
              <span className="num" style={{ color: 'var(--text-faint)' }}>
                {bytes(file.size)}
              </span>
              <button
                className="btn icon ghost sm"
                onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                aria-label="Remove"
              >
                <IconClose size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <Field
        label="Magnet links or torrent URLs"
        hint="One per line. Magnet links are handed to rtorrent as-is."
      >
        <textarea
          className="textarea"
          rows={3}
          placeholder={'magnet:?xt=urn:btih:…\nhttps://example.org/file.torrent'}
          value={urls}
          onChange={(event) => setUrls(event.target.value)}
        />
      </Field>

      <div className="form-grid">
        <Field label="Destination directory" hint={`Default: ${defaultDirectory || 'rtorrent default'}`}>
          <input
            className="input"
            placeholder={defaultDirectory}
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
          />
        </Field>
        <Field label="Label" hint="Stored in rtorrent's custom1 field">
          <input
            className="input"
            list="cascade-labels"
            placeholder="none"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <datalist id="cascade-labels">
            {labels.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </Field>
      </div>
    </Modal>
  );
}
