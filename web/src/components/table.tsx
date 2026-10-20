// SPDX-License-Identifier: MIT

import { useMemo, useState } from 'react';
import { nextSort, sortRows, type SortColumns, type TableSort } from '../tableSort';

/** A native button for keyboard access, with the current order on its column header. */
export function SortHeader<Key extends string>({
  column,
  label,
  sort,
  onSort,
  className = '',
  title,
}: {
  column: Key;
  label: string;
  sort: TableSort<Key> | null;
  onSort: (key: Key) => void;
  className?: string;
  title?: string;
}) {
  const sorted = sort?.key === column;
  return (
    <th
      scope="col"
      className={`${className} sortable ${sorted ? 'sorted' : ''}`}
      aria-sort={sorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      title={title ?? label}
    >
      <button
        type="button"
        className="sort-button"
        aria-label={`Sort by ${label}`}
        onClick={() => onSort(column)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSort(column);
          }
        }}
      >
        <span className="sort-label">{label}</span>
        <span className="sort-arrow" aria-hidden="true">{sorted ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );
}

/** Sort state survives polls; memoization also avoids re-sorting on clock ticks. */
export function useTableSort<Row, Key extends string>(
  rows: readonly Row[] | undefined,
  columns: SortColumns<Row, Key>,
  identity: (row: Row) => string | number,
) {
  const [sort, setSort] = useState<TableSort<Key> | null>(null);
  const sorted = useMemo(() => rows && sortRows(rows, sort, columns, identity), [rows, sort, columns, identity]);
  const onSort = (key: Key) => setSort((previous) => nextSort(previous, key, columns[key].dir));
  const headers = (Object.keys(columns) as Key[]).map((key) => (
    <SortHeader
      key={key}
      column={key}
      label={columns[key].label}
      className={columns[key].className}
      title={columns[key].title}
      sort={sort}
      onSort={onSort}
    />
  ));
  return { rows: sorted, headers };
}
