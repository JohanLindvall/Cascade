/**
 * Passkeys must not reach the screen, and nothing else may be mangled on the
 * way: rtorrent's log is read for info hashes and tracker hosts, so the
 * redaction has to be exact about what it touches.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets, redactUrl } from './redact.ts';

test('credential query parameters are masked, the rest of the URL kept', () => {
  assert.equal(
    redactUrl('http://tracker.example/announce.php?passkey=865daba582d49260a3'),
    'http://tracker.example/announce.php?passkey=•••',
  );
  assert.equal(
    redactUrl('https://t.example/ann?authkey=abc&torrent_pass=def&info=keep'),
    'https://t.example/ann?authkey=•••&torrent_pass=•••&info=keep',
  );
  assert.equal(redactUrl('https://t.example/a?PassKey=X'), 'https://t.example/a?PassKey=•••');
});

test('a passkey carried as a path segment is masked (the Gazelle form)', () => {
  assert.equal(
    redactUrl('https://flacs.example/0123456789abcdef0123456789abcdef/announce'),
    'https://flacs.example/•••/announce',
  );
  // Short or word-like segments are paths, not secrets.
  assert.equal(redactUrl('http://t.example:6969/announce'), 'http://t.example:6969/announce');
  assert.equal(redactUrl('http://t.example/tracker-v2/announce'), 'http://t.example/tracker-v2/announce');
});

test('the host is never touched, even when it looks like a token', () => {
  assert.equal(
    redactUrl('http://abcdefghijklmnopqrstuvwxyz/announce'),
    'http://abcdefghijklmnopqrstuvwxyz/announce',
  );
});

test('user:password in the authority is a credential too', () => {
  assert.equal(redactUrl('https://me:hunter2@t.example/announce'), 'https://•••@t.example/announce');
});

test('URLs are found inside log lines, and info hashes beside them survive', () => {
  const line =
    "1789826031 B990C2A0B0702327F958C1D938065E15EFED5FAA->tracker_list: received failure : url:http://scenehd.example/announce.php?passkey=865daba582d49260a3 msg:'v6 : Could not resolve hostname'";
  assert.equal(
    redactSecrets(line),
    "1789826031 B990C2A0B0702327F958C1D938065E15EFED5FAA->tracker_list: received failure : url:http://scenehd.example/announce.php?passkey=••• msg:'v6 : Could not resolve hostname'",
  );
});

test('several URLs in one line are each redacted', () => {
  assert.equal(
    redactSecrets('a http://x.example/?pk=1 b https://y.example/0123456789abcdef0123/announce c'),
    'a http://x.example/?pk=••• b https://y.example/•••/announce c',
  );
});

test('text without a URL, and URLs without secrets, come back unchanged', () => {
  for (const text of [
    '',
    'Tracker: [Timeout was reached]',
    '7848BD5C169EDA06AFC7344291F81682E5FD685A->download: Starting torrent',
    'udp://tracker.opentrackr.example:1337/announce',
    'magnet:?xt=urn:btih:abc', // not scheme://, so not a URL this looks at
  ]) {
    assert.equal(redactSecrets(text), text, text);
  }
});
