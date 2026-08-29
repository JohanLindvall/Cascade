/**
 * The formatting helpers draw every number in the UI, and two of them parse
 * user input back (rate limits). Wrong answers here are not cosmetic: a rate
 * parsed into the wrong unit becomes a live throttle.
 *
 * Run with `node --experimental-strip-types --test`; no framework involved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bytes,
  duration,
  fileName,
  formatRateInput,
  parseRate,
  percent,
  rate,
} from './format.ts';

test('bytes picks the unit and the precision', () => {
  assert.equal(bytes(0), '0 B');
  assert.equal(bytes(-5), '0 B');
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(1024), '1.00 KiB');
  assert.equal(bytes(1536 * 1024), '1.50 MiB');
  assert.equal(bytes(120 * 1024 ** 3), '120 GiB');
  assert.equal(bytes(3 * 1024 ** 5), '3.00 PiB');
});

test('rate is bytes per second, silent at zero', () => {
  assert.equal(rate(0), '—');
  assert.equal(rate(2048), '2.00 KiB/s');
});

test('duration walks the units; null is forever and zero is nothing', () => {
  assert.equal(duration(null), '∞');
  assert.equal(duration(0), '—');
  assert.equal(duration(59), '59s');
  assert.equal(duration(174), '2m 54s');
  assert.equal(duration(3 * 3600 + 5 * 60), '3h 5m');
  assert.equal(duration(50 * 3600), '2d 2h');
  assert.equal(duration(3 * 365 * 24 * 3600), '3.0y');
});

test('parseRate reads the forms the placeholder promises, in KiB by default', () => {
  assert.equal(parseRate(''), 0);
  assert.equal(parseRate('500'), 500 * 1024);
  assert.equal(parseRate('500k'), 500 * 1024);
  assert.equal(parseRate('2M'), 2 * 1024 ** 2);
  assert.equal(parseRate('1.5m'), Math.round(1.5 * 1024 ** 2));
  assert.equal(parseRate('1G'), 1024 ** 3);
  assert.equal(parseRate('junk'), 0);
});

test('formatRateInput round-trips through parseRate', () => {
  for (const value of [0, 100 * 1024, 2 * 1024 ** 2, 1536 * 1024]) {
    assert.equal(parseRate(formatRateInput(value)), value);
  }
});

test('percent clamps into [0, 100]', () => {
  assert.equal(percent(0.5), '50.0%');
  assert.equal(percent(1.2, 0), '100%');
  assert.equal(percent(-1, 0), '0%');
});

test('fileName takes the last path segment', () => {
  assert.equal(fileName('dir/sub/movie.mkv'), 'movie.mkv');
  assert.equal(fileName('plain.mkv'), 'plain.mkv');
});
