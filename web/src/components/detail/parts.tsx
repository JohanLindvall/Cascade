// SPDX-License-Identifier: MIT

/** Pieces the detail tabs share: flag tags, expandable rows and their key/value blocks. */
import { useCallback, useState, type ReactNode } from 'react';

export interface Flag {
  label: string;
  title: string;
  tone?: 'good' | 'warn' | 'bad';
}

export function Flags({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return <span className="faint">—</span>;
  return (
    <span className="flags">
      {flags.map((flag) => (
        <span key={flag.label} className={flag.tone ? `tag ${flag.tone}` : 'tag'} title={flag.title}>
          {flag.label}
        </span>
      ))}
    </span>
  );
}

export const yesNo = (value: boolean) => (value ? 'yes' : 'no');

/** Key/value block shown when a peer or tracker row is expanded. */
export function MiniKv({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <div className="mini-kv">
      {rows.map(([key, value]) => (
        <div key={key}>
          <span>{key}</span>
          <b>{value}</b>
        </div>
      ))}
    </div>
  );
}

/** A table row spanning every column, for "loading" and "nothing here". */
export function NoteRow({ span, children }: { span: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={span} className="faint">
        {children}
      </td>
    </tr>
  );
}

/** Which rows of a table are expanded. A tab is keyed by torrent, so a new one starts collapsed. */
export function useExpanded(): [(key: string) => boolean, (key: string) => void] {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (key: string) =>
      setOpen((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );
  return [(key) => open.has(key), toggle];
}

/**
 * The first cell's content of an expandable row. The whole row takes a click,
 * but only this button takes the keyboard and says whether it is open — the
 * row itself is not focusable, so an aria-expanded there announced nothing.
 */
export function RowToggle({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button
      className="row-toggle"
      aria-expanded={open}
      onClick={(event) => {
        // The row toggles on click too; once is enough.
        event.stopPropagation();
        onToggle();
      }}
    >
      <span className="caret" aria-hidden="true">
        {open ? '▾' : '▸'}
      </span>
      {children}
    </button>
  );
}
