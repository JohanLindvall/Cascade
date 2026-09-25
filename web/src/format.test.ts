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
  FILE_PRIORITIES,
  TORRENT_PRIORITIES,
  bytes,
  duration,
  fileName,
  formatRateInput,
  logDay,
  logTime,
  magnetLink,
  nameErrors,
  parseLogLine,
  parseRate,
  parseWholeNumber,
  percent,
  priorityLabel,
  progressText,
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
  assert.equal(parseRate('  '), 0);
  assert.equal(parseRate('500'), 500 * 1024);
  assert.equal(parseRate('500k'), 500 * 1024);
  assert.equal(parseRate('2M'), 2 * 1024 ** 2);
  assert.equal(parseRate('1.5m'), Math.round(1.5 * 1024 ** 2));
  assert.equal(parseRate('1G'), 1024 ** 3);
  assert.equal(parseRate('.5M'), 512 * 1024);
});

test('parseRate takes the units people actually type', () => {
  assert.equal(parseRate('500 KiB'), 500 * 1024);
  assert.equal(parseRate('2 MiB/s'), 2 * 1024 ** 2);
  assert.equal(parseRate('2mb/s'), 2 * 1024 ** 2);
  assert.equal(parseRate('800 B/s'), 800); // an explicit byte unit means bytes
  assert.equal(parseRate('800b'), 800);
});

test('a typo is invalid, never "unlimited"', () => {
  // These used to parse to 0, which rtorrent reads as no limit at all: one
  // slip of the keyboard lifted a live throttle without a word.
  for (const text of ['junk', 'fast', '1.5.2', '-5', '5x', '5 kbps', 'k', '1,5M', '5 k 5']) {
    assert.equal(parseRate(text), null, text);
  }
});

test('formatRateInput round-trips through parseRate', () => {
  for (const value of [0, 100 * 1024, 2 * 1024 ** 2, 1536 * 1024]) {
    assert.equal(parseRate(formatRateInput(value)), value);
  }
});

test('parseWholeNumber: integers at or above the floor, and nothing else', () => {
  assert.equal(parseWholeNumber('42'), 42);
  assert.equal(parseWholeNumber(' 7 '), 7);
  assert.equal(parseWholeNumber('0'), 0);
  assert.equal(parseWholeNumber('-1', -1), -1);
  assert.equal(parseWholeNumber('-1'), null); // below the default floor of 0
  assert.equal(parseWholeNumber('-2', -1), null);
  // The half-typed states a controlled number input used to collapse to 0.
  for (const text of ['', '-', '1.5', '1e3', 'abc', '12a', '9'.repeat(20)]) {
    assert.equal(parseWholeNumber(text, -1), null, text);
  }
});

test('a magnet link carries the hash and name, and never a tracker', () => {
  assert.equal(magnetLink('ABCDEF0123456789ABCDEF0123456789ABCDEF01'), 'magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01');
  const link = magnetLink('A'.repeat(40), 'Some & Other: Thing.mkv');
  assert.equal(link, `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=Some%20%26%20Other%3A%20Thing.mkv`);
  assert.ok(!link.includes('tr='));
});

test('priority tables name every rtorrent value, and unknown ones pass through', () => {
  assert.deepEqual(TORRENT_PRIORITIES.map((item) => item.value).sort(), [0, 1, 2, 3]);
  assert.deepEqual(FILE_PRIORITIES.map((item) => item.value).sort(), [0, 1, 2]);
  assert.equal(priorityLabel(TORRENT_PRIORITIES, 3), 'High');
  assert.equal(priorityLabel(FILE_PRIORITIES, 0), 'Skip');
  assert.equal(priorityLabel(FILE_PRIORITIES, 9), '9');
});

test('achievement progress reads in the unit the server declares', () => {
  const GIB = 1024 ** 3;
  assert.equal(progressText('bytes', GIB / 2, GIB), '512 MiB / 1.00 GiB');
  assert.equal(progressText('rate', 0, 10 * 1024 ** 2), '0 B/s / 10.0 MiB/s');
  assert.equal(progressText('ratio', 0.456, 1), '0.46 / 1.00');
  assert.equal(progressText('duration', 3600, 7 * 86400), '1h 0m / 7d 0h');
  assert.equal(progressText('count', 3.9, 10), '3 / 10');
});

test('bulk errors name the torrent instead of its hash where it is known', () => {
  const known = 'A'.repeat(40);
  const names: Record<string, string> = { [known]: 'Ubuntu.iso' };
  assert.deepEqual(
    nameErrors(
      [`${known}: unknown action`, `${'b'.repeat(40)}: gone`, 'not a hash: message'],
      (hash) => names[hash],
    ),
    ['Ubuntu.iso: unknown action', `${'b'.repeat(40)}: gone`, 'not a hash: message'],
  );
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

test('a subsystem line has a timestamp but no level', () => {
  // What tracker_events and the *_debug scopes write (0.16.22, checked).
  const line = parseLogLine('1789314611 tracker-manager: added controller: info_hash:7848BD5C');
  assert.equal(line.at?.getTime(), 1789314611 * 1000);
  assert.equal(line.level, '');
  assert.equal(line.text, 'tracker-manager: added controller: info_hash:7848BD5C');
  // A capital that is a word, not a level letter, stays in the text.
  const word = parseLogLine('1789314611 I/O error on chunk 3');
  assert.equal(word.level, '');
  assert.equal(word.text, 'I/O error on chunk 3');
  // An unknown single letter is text as well, not a level.
  const unknown = parseLogLine('1788015928 X unknown level letter');
  assert.equal(unknown.level, '');
  assert.equal(unknown.text, 'X unknown level letter');
  assert.ok(unknown.at);
});

test('anything that is not a log line is handed back whole', () => {
  for (const raw of [
    'a bare sentence',
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
