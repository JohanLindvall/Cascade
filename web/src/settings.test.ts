// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsPatch } from './settings.ts';

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
