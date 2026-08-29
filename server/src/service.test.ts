/**
 * The restart half of "recheck & restart" is a decision fed by d.hashing
 * readings, and the timing traps are exactly what these pin: a check the
 * polls never saw because it finished between two of them, a queued check
 * that has not started yet, and a torrent that vanished mid-wait.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOG_SCOPES, PendingRestarts, sanitizeLogScopes } from './service';

const HASH = 'A'.repeat(40);

test('the ordinary arc: queued, checking, finished, started once', () => {
  const pending = new PendingRestarts();
  pending.add(HASH);
  assert.equal(pending.step(HASH, 1), 'wait'); // queued counts as running
  assert.equal(pending.step(HASH, 3), 'wait'); // checking
  assert.equal(pending.step(HASH, 0), 'start'); // first zero after that: done
  assert.equal(pending.step(HASH, 0), 'drop'); // never twice
  assert.equal(pending.size, 0);
});

test('a check faster than the poll still restarts, after the zero floor', () => {
  const pending = new PendingRestarts();
  pending.add(HASH);
  for (let i = 1; i < PendingRestarts.ZERO_READS_FLOOR; i++) {
    assert.equal(pending.step(HASH, 0), 'wait', `zero reading ${i} must still wait`);
  }
  assert.equal(pending.step(HASH, 0), 'start');
});

test('a slow queue does not trip the floor once hashing is seen', () => {
  const pending = new PendingRestarts();
  pending.add(HASH);
  assert.equal(pending.step(HASH, 0), 'wait');
  assert.equal(pending.step(HASH, 0), 'wait');
  assert.equal(pending.step(HASH, 2), 'wait'); // the check finally started
  assert.equal(pending.step(HASH, 0), 'start'); // zero counter was reset
});

test('a torrent that cannot be asked is dropped, not restarted', () => {
  const pending = new PendingRestarts();
  pending.add(HASH);
  assert.equal(pending.step(HASH, null), 'drop'); // erased, or the call faulted
  assert.equal(pending.size, 0);
});

test('a wait past the ceiling expires instead of lingering forever', () => {
  const pending = new PendingRestarts();
  pending.add(HASH, 1_000);
  assert.equal(pending.step(HASH, 2, 2_000), 'wait');
  assert.equal(pending.step(HASH, 2, 1_000 + PendingRestarts.MAX_AGE_MS + 1), 'drop');
});

test('an unknown hash answers drop and disturbs nothing', () => {
  const pending = new PendingRestarts();
  pending.add(HASH);
  assert.equal(pending.step('B'.repeat(40), 0), 'drop');
  assert.equal(pending.size, 1);
});

test('log scopes: only the catalog passes, in catalog order, once', () => {
  assert.deepEqual(
    sanitizeLogScopes(['tracker_debug', 'debug', 'tracker_debug', 'made_up', 42]),
    ['debug', 'tracker_debug'],
  );
  assert.deepEqual(sanitizeLogScopes('debug'), []); // not an array: nothing
  assert.deepEqual(sanitizeLogScopes(undefined), []);
  assert.deepEqual(sanitizeLogScopes([...LOG_SCOPES]), [...LOG_SCOPES]);
});
