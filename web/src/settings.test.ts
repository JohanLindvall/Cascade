// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RATE, appliedRate, parseGlobalRate, settingsPatch } from './settings.ts';

test('returning a write-only choice to leave unchanged sends no setter', () => {
  assert.deepEqual(settingsPatch({}, { encryption: '', dhtMode: '' }), {});
  assert.deepEqual(settingsPatch({}, { encryption: 'none', dhtMode: 'disable' }), {
    encryption: 'none', dhtMode: 'disable',
  });
});

test('settings patch retains intentional zeroes, false and empty readable strings', () => {
  assert.deepEqual(settingsPatch({ uploadRate: 1024, pex: true, proxyAddress: 'proxy:80', maxPeers: 50 }, {
    uploadRate: 0, pex: false, proxyAddress: '', maxPeers: 50,
  }), { uploadRate: 0, pex: false, proxyAddress: '' });
});

test('a global rate is held to what rtorrent keeps: whole KiB/s, rounded up, under 4 GiB/s', () => {
  assert.equal(appliedRate(0), 0);
  // rtorrent drops a fraction of a KiB: 800 B/s would have been unlimited.
  assert.equal(appliedRate(800), 1024);
  assert.equal(appliedRate(1025), 2048);
  assert.equal(appliedRate(MAX_RATE), MAX_RATE);
  assert.equal(parseGlobalRate('500k'), 512_000);
  assert.equal(parseGlobalRate(''), 0);
  assert.equal(parseGlobalRate(`${MAX_RATE} B/s`), MAX_RATE);
  assert.equal(parseGlobalRate(`${MAX_RATE + 1} B/s`), null);
  assert.equal(parseGlobalRate('4G'), null);
  assert.equal(parseGlobalRate('12 parsecs'), null);
});
