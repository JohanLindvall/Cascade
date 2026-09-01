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
  logDay,
  logTime,
  parseLogLine,
  parseRate,
  percent,
  rate,
  relative,
  timestamp,
  until,
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

test('log lines split into time, level and message', () => {
  // The shape both 0.9.8 and 0.16.20 write.
  const line = parseLogLine('1788016396 W Ignoring rtorrent.rc.');
  assert.equal(line.level, 'warn');
  assert.equal(line.text, 'Ignoring rtorrent.rc.');
  assert.equal(line.at?.getTime(), 1788016396 * 1000);

  assert.equal(parseLogLine('1788015928 I resource_manager: adjusting').level, 'info');
  assert.equal(parseLogLine('1788015928 D could not open input history').level, 'debug');
  assert.equal(parseLogLine('1788015928 N rtorrent main: Starting thread.').level, 'notice');
  assert.equal(parseLogLine('1788015928 E something failed').level, 'error');
  assert.equal(parseLogLine('1788015928 C the worst kind').level, 'critical');
});

test('a message keeps everything after the level, colons and all', () => {
  const line = parseLogLine(
    '1788015928 I ABC123->tracker_list: added tracker (group:0 url:http://t/announce)',
  );
  assert.equal(line.text, 'ABC123->tracker_list: added tracker (group:0 url:http://t/announce)');
});

test('anything that is not a log line is handed back whole', () => {
  for (const raw of [
    'a bare sentence',
    '1788015928 X unknown level letter',
    '1788015928I missing the space',
    '12345 I timestamp too short to be epoch seconds',
    '',
    '  1788015928 I leading space',
  ]) {
    const line = parseLogLine(raw);
    assert.equal(line.at, null, raw);
    assert.equal(line.text, raw, raw);
    assert.equal(line.level, '', raw);
  }
});

test('an implausible epoch is text, not a date from 1970', () => {
  const line = parseLogLine('0000000001 I long ago');
  assert.equal(line.at, null);
  assert.equal(line.text, '0000000001 I long ago');
});

test('a message spanning lines keeps its tail', () => {
  const line = parseLogLine('1788015928 E first\nsecond');
  assert.equal(line.text, 'first\nsecond');
});

test('the rendered time and day are stable strings', () => {
  const at = new Date(1788016396 * 1000);
  assert.match(logTime(at), /^\d{2}:\d{2}:\d{2}$/);
  assert.ok(logDay(at).length > 0);
});

test('timestamps, countdowns and ages treat zero as unset', () => {
  assert.equal(timestamp(0), '—');
  assert.match(timestamp(1788016396), /2026/);
  assert.equal(until(0), '—');
  assert.equal(relative(0), '—');
  const now = Date.now() / 1000;
  assert.equal(until(now - 5), 'due');
  assert.match(until(now + 90), /^in 1m/);
  assert.equal(relative(now - 5), 'just now');
  assert.match(relative(now - 3 * 3600), /^3h .* ago$/);
});
