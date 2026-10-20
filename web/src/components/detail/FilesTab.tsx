// SPDX-License-Identifier: MIT

import { memo } from 'react';
import { FILE_COLUMNS, fileIdentity } from '../../detailSort';
import { FILE_PRIORITIES, bytes, fileName, percent } from '../../format';
import type { TorrentFile } from '../../types';
import { ProgressBar } from '../ui';
import { useTableSort } from '../table';
import { NoteRow } from './parts';

/**
 * The torrent's files, each with its progress and a download priority.
 * Memoized, like every fetched tab: the rows change only on the tab's own
 * poll, while the app around it redraws on every stream delta.
 */
export const FilesTab = memo(function FilesTab({
  files,
  onPriority,
}: {
  /** Undefined until the first answer. */
  files: TorrentFile[] | undefined;
  onPriority: (index: number, priority: number) => void;
}) {
  const { rows, headers } = useTableSort(files, FILE_COLUMNS, fileIdentity);
  return (
    <table className="grid files-grid">
      <thead>
        <tr>{headers}</tr>
      </thead>
      <tbody>
        {rows?.map((file) => {
          const name = fileName(file.path);
          return (
            <tr key={file.index}>
              <td className="wrap" title={file.path}>
                {name}
                {file.path.includes('/') && <div className="subline">{file.path}</div>}
                {file.onDisk && (
                  <div
                    className="subline warn-text"
                    title="The name was longer than the filesystem allows, so it was shortened to fit"
                  >
                    on disk as {file.onDisk}
                  </div>
                )}
              </td>
              <td className="num right">{bytes(file.size)}</td>
              <td>
                <div className="progress-cell">
                  <ProgressBar
                    value={file.progress}
                    variant={file.progress >= 1 ? 'done' : file.priority === 0 ? 'idle' : 'default'}
                    label={`Progress of ${name}`}
                  />
                  <span className="num">{percent(file.progress, 0)}</span>
                </div>
              </td>
              <td>
                <select
                  className="select compact"
                  value={file.priority}
                  aria-label={`Priority of ${name}`}
                  onChange={(event) => onPriority(file.index, Number(event.target.value))}
                >
                  {FILE_PRIORITIES.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          );
        })}
        {!files && <NoteRow span={4}>Loading…</NoteRow>}
        {files?.length === 0 && <NoteRow span={4}>No file information available.</NoteRow>}
      </tbody>
    </table>
  );
});
