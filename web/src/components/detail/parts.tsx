// SPDX-License-Identifier: MIT

/** Pieces the detail tabs share: flag tags, expandable rows and their key/value blocks. */
import { Fragment, useCallback, useState, type ReactNode } from 'react';
import { flagsTitle, type Flag } from './flags';

/**
 * A row's flags, on one line of fixed height (.flags in styles.css), and the
 * dash for none in the same box, so no flag a poll brings or takes changes
 * the row's height, not even the first. One title on the box names them all,
 * those the ellipsis hides too; a title on each tag would show in its place
 * wherever a tag is hovered. A space parts the tags, drawn zero wide
 * (.flag-gap): inline tags back to back are one word in the accessible name,
 * in innerText and in a copy ("bannedsnub").
 */
export function Flags({ flags }: { flags: Flag[] }) {
  return (
    <span className="flags" title={flagsTitle(flags)}>
      {flags.length === 0
        ? '—'
        : flags.map((flag, i) => (
            <Fragment key={flag.label}>
              {i > 0 && <span className="flag-gap">{' '}</span>}
              <span className={flag.tone ? `tag ${flag.tone}` : 'tag'}>{flag.label}</span>
            </Fragment>
          ))}
    </span>
  );
}

export const yesNo = (value: boolean) => (value ? 'yes' : 'no');

/**
 * Key/value block shown when a peer or tracker row is expanded, as wide as
 * the pane on screen however wide the table. Every value shows whole, wrapping
 * where its column is too narrow; a 'wide' row has a line of its own, for a
 * long value that is read or copied whole: a peer's address, ID and client.
 * A value that changes with the polls must fit beside its key unwrapped, or
 * the block grows and shrinks as it changes: expanded.test.ts counts letters.
 */
export function MiniKv({ rows }: { rows: Array<[key: string, value: ReactNode, width?: 'wide']> }) {
  return (
    <div className="mini-kv">
      {rows.map(([key, value, width]) => (
        <div key={key} className={width}>
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
      <span className="row-toggle-label">{children}</span>
    </button>
  );
}
