// SPDX-License-Identifier: MIT

import { useId, useRef, useState, type DragEvent } from 'react';
import { api } from '../api';
import { acceptTorrents, dropText, droppedFiles, linksFromDrop } from '../files';
import { bytes } from '../format';
import { useMounted } from '../hooks';
import { redactSecrets } from '../redact';
import { directoryProblem, linesProblem, sentence } from '../rtorrentText';
import { IconClose, IconFile, IconUpload } from './icons';
import { Field, Switch } from './form';
import { Modal } from './modal';
import { useToast } from './toast';

interface AddDialogProps {
  onClose: () => void;
  defaultDirectory: string;
  labels: string[];
}

export function AddDialog({ onClose, defaultDirectory, labels }: AddDialogProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [urls, setUrls] = useState('');
  const [directory, setDirectory] = useState('');
  const [label, setLabel] = useState('');
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const alive = useMounted();
  const inputRef = useRef<HTMLInputElement>(null);
  const labelListId = useId();
  const toast = useToast();
  // What the server would refuse is held here, as typed, to be put right
  // before anything is added: a directory, which refuses the whole batch
  // (validate.Directory), and a link line, which would fail on its own. An
  // empty directory is rtorrent's default, and is not sent at all.
  const directoryError = directoryProblem(directory);
  const urlsError = linesProblem(urls);
  const invalid = directoryError !== null || urlsError !== null;

  const addFiles = (list: Iterable<File>) => {
    if (busy) return;
    const { accepted, ignored } = acceptTorrents(list);
    if (ignored) toast.push('info', ignored);
    setFiles((current) => [...current, ...accepted]);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    // Keep the drop here: the window-level handler adds torrents immediately,
    // which would both stage and add the same file.
    event.stopPropagation();
    setDragging(false);
    if (busy) return;
    // The same reading as the window drop (see droppedFiles): a file manager
    // that hands over the file only through dataTransfer.items is not refused.
    const dropped = droppedFiles(event.dataTransfer);
    if (dropped.length > 0) {
      addFiles(dropped);
      return;
    }
    // A magnet dragged out of a browser tab joins the link list rather than
    // vanishing: the zone used to take files only, and said nothing otherwise.
    const { links, problem } = linksFromDrop(dropText(event.dataTransfer));
    if (links.length > 0) setUrls((current) => [current.trim(), ...links].filter(Boolean).join('\n'));
    if (problem) toast.push(problem.level, problem.text);
  };

  const browse = () => { if (!busy) inputRef.current?.click(); };

  const submit = async () => {
    if (busy || invalid) return;
    if (files.length === 0 && urls.trim() === '') {
      toast.push('error', 'Add at least one .torrent file, magnet link or URL');
      return;
    }
    setBusy(true);
    setProblems([]);
    try {
      const form = new FormData();
      for (const file of files) form.append('torrents', file);
      form.append('urls', urls);
      form.append('start', start ? '1' : '0');
      if (directory.trim()) form.append('directory', directory.trim());
      if (label.trim()) form.append('label', label.trim());
      const result = await api.upload(form);
      if (alive.current) {
        setProblems(result.errors.map(redactSecrets));
        const failedFiles = new Set(result.failedFiles);
        const failedUrls = new Set(result.failedUrls);
        setFiles(files.filter((_file, index) => failedFiles.has(index)));
        setUrls(urls.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean)
          .filter((_url, index) => failedUrls.has(index)).join('\n'));
      } else for (const error of result.errors) toast.push('error', error);
      if (result.added > 0) {
        toast.push('success', `Added ${result.added} torrent${result.added === 1 ? '' : 's'}`);
        if (alive.current && result.errors.length === 0) onClose();
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
          <fieldset className="form-fields" disabled={busy}>
            <Switch checked={start} onChange={setStart} label="Start immediately" />
          </fieldset>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={busy || invalid}
            title={invalid ? 'Fix the fields marked in red first' : undefined}
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </>
      }
    >
      {problems.length > 0 && (
        <div className="banner" role="alert">
          <div>Some torrents could not be added. Only the failed items remain below.
            <ul>{problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul>
          </div>
        </div>
      )}
      <fieldset className="form-fields" disabled={busy}>
        <div
          className={`dropzone ${dragging ? 'over' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="Choose .torrent files, or drop files or links here"
          aria-disabled={busy}
          onClick={browse}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              browse();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            // Moving between the zone's own children fires dragleave on the way;
            // only leaving the zone itself ends the highlight.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={onDrop}
        >
          <div className="glyph">
            <IconUpload size={26} />
          </div>
          <strong>Drop .torrent files or magnet links here</strong>
          <span>or click to browse — multiple files are fine</span>
          <input
            ref={inputRef}
            type="file"
            accept=".torrent,application/x-bittorrent"
            multiple
            hidden
            onChange={(event) => {
              addFiles(event.target.files ?? []);
              event.target.value = '';
            }}
          />
        </div>

        {files.length > 0 && (
          <div className="file-list">
            {files.map((file, index) => (
              <div className="file-chip" key={`${file.name}-${index}`}>
                <IconFile size={14} />
                <span className="name" title={file.name}>
                  {file.name}
                </span>
                <span className="num faint">{bytes(file.size)}</span>
                <button
                  className="btn icon ghost sm"
                  onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                  aria-label={`Remove ${file.name}`}
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
          error={urlsError === null ? undefined : sentence(urlsError)}
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
          <Field
            label="Destination directory"
            hint={defaultDirectory ? `Default: ${defaultDirectory}` : 'Default: rtorrent’s own'}
            error={directoryError === null ? undefined : sentence(directoryError)}
          >
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
              list={labelListId}
              placeholder="none"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <datalist id={labelListId}>
              {labels.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </Field>
        </div>
      </fieldset>
    </Modal>
  );
}
