// SPDX-License-Identifier: MIT

import type { SortDir } from './preferences.ts';

export interface TableSort<Key extends string> {
  key: Key;
  dir: SortDir;
}

type Scalar = string | number;
/** Tuples order compound columns (e.g. successes, then failures); null is unknown. */
type SortValue = Scalar | readonly Scalar[] | null;

export interface SortColumn<Row> {
  label: string;
  value: (row: Row) => SortValue;
  dir: SortDir;
  className?: string;
  title?: string;
}

export type SortColumns<Row, Key extends string> = Record<Key, SortColumn<Row>>;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareScalar(a: Scalar, b: Scalar): number {
  if (typeof a === 'string' || typeof b === 'string') return collator.compare(String(a), String(b));
  // Unlike subtraction, this also compares two unlimited (Infinity) values.
  return a < b ? -1 : a > b ? 1 : 0;
}

function compare(a: Exclude<SortValue, null>, b: Exclude<SortValue, null>): number {
  if (typeof a !== 'object' && typeof b !== 'object') return compareScalar(a, b);
  const left = typeof a === 'object' ? a : [a];
  const right = typeof b === 'object' ? b : [b];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const order = compareScalar(left[i], right[i]);
    if (order) return order;
  }
  return left.length - right.length;
}

export function nextSort<Key extends string>(
  current: TableSort<Key> | null,
  key: Key,
  defaultDir: SortDir,
): TableSort<Key> {
  return { key, dir: current?.key === key ? (current.dir === 'asc' ? 'desc' : 'asc') : defaultDir };
}

/**
 * Keep the backend's order until a header is clicked. After that, ties use a
 * unique row identity, always ascending, so polling cannot shuffle equal rows.
 * Read each value once; do not mutate the shared API arrays.
 */
export function sortRows<Row, Key extends string>(
  rows: readonly Row[],
  sort: TableSort<Key> | null,
  columns: SortColumns<Row, Key>,
  identity: (row: Row) => string | number,
): readonly Row[] {
  if (!sort) return rows;
  const factor = sort.dir === 'asc' ? 1 : -1;
  return rows.map((row) => ({ row, value: columns[sort.key].value(row), id: identity(row) }))
    .sort((a, b) => {
      // Missing times/values stay last in either direction.
      const order = a.value === null ? (b.value === null ? 0 : 1)
        : b.value === null ? -1 : compare(a.value, b.value) * factor;
      // Raw identity also separates names the natural collator considers equal.
      return order || compareScalar(a.id, b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    })
    .map(({ row }) => row);
}
