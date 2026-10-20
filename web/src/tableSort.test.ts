// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextSort, sortRows, type SortColumns } from './tableSort.ts';

const columns: SortColumns<{ id: string; value: number | null }, 'value'> = {
  value: { label: 'Value', value: (row) => row.value, dir: 'desc' },
};
const identity = (row: { id: string }) => row.id;

test('a new column uses its default direction; another click reverses it', () => {
  const first = nextSort<'name' | 'size'>(null, 'size', 'desc');
  assert.deepEqual(first, { key: 'size', dir: 'desc' });
  const second = nextSort(first, 'size', 'desc');
  assert.deepEqual(second, { key: 'size', dir: 'asc' });
  assert.deepEqual(nextSort(second, 'size', 'desc'), first);
  assert.deepEqual(nextSort(first, 'name', 'asc'), { key: 'name', dir: 'asc' });
});

test('rows keep the API order until sorted, and sorting leaves the API array intact', () => {
  const rows = Object.freeze([{ id: 'a', value: 20 }, { id: 'b', value: 100 }, { id: 'c', value: 9 }]);
  assert.equal(sortRows(rows, null, columns, identity), rows);
  assert.deepEqual(sortRows(rows, { key: 'value', dir: 'desc' }, columns, identity).map(identity), ['b', 'a', 'c']);
  assert.deepEqual(rows.map(identity), ['a', 'b', 'c']);
});

test('unknown values stay last in either direction; infinity is a value, not unknown', () => {
  const rows = [
    { id: 'unknown', value: null }, { id: 'unlimited', value: Infinity },
    { id: 'small', value: 9 }, { id: 'large', value: 200 },
  ];
  for (const [dir, expected] of [
    ['asc', ['small', 'large', 'unlimited', 'unknown']],
    ['desc', ['unlimited', 'large', 'small', 'unknown']],
  ] as const) {
    assert.deepEqual(sortRows(rows, { key: 'value', dir }, columns, identity).map(identity), expected);
  }
});

test('ties stay deterministic across polls, even when identities collate equally', () => {
  for (const value of [0, null, Infinity]) {
    const rows = ['group10', 'group2', 'Group2', 'group02'].map((id) => ({ id, value }));
    for (const dir of ['asc', 'desc'] as const) {
      for (const input of [rows, [...rows].reverse()]) {
        assert.deepEqual(sortRows(input, { key: 'value', dir }, columns, identity).map(identity),
          ['Group2', 'group02', 'group2', 'group10']);
      }
    }
  }
});
