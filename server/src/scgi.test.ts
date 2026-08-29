/** parseScgiTarget accepts every way an endpoint is written in the wild. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeTarget, parseScgiTarget } from './scgi';

test('unix socket forms', () => {
  assert.deepEqual(parseScgiTarget('unix:/run/rt/rpc.socket'), {
    kind: 'unix',
    path: '/run/rt/rpc.socket',
  });
  assert.deepEqual(parseScgiTarget('/run/rt/rpc.socket'), {
    kind: 'unix',
    path: '/run/rt/rpc.socket',
  });
  assert.deepEqual(parseScgiTarget('./rpc.socket'), { kind: 'unix', path: './rpc.socket' });
});

test('tcp forms', () => {
  assert.deepEqual(parseScgiTarget('rt.internal:5000'), {
    kind: 'tcp',
    host: 'rt.internal',
    port: 5000,
  });
  assert.deepEqual(parseScgiTarget('scgi://rt.internal:5000'), {
    kind: 'tcp',
    host: 'rt.internal',
    port: 5000,
  });
  assert.deepEqual(parseScgiTarget('[::1]:5000'), { kind: 'tcp', host: '::1', port: 5000 });
  assert.deepEqual(parseScgiTarget('5000'), { kind: 'tcp', host: '127.0.0.1', port: 5000 });
});

test('describeTarget round-trips into log lines', () => {
  assert.equal(describeTarget(parseScgiTarget('unix:/a/b')), 'unix:/a/b');
  assert.equal(describeTarget(parseScgiTarget('h:1')), 'h:1');
});
