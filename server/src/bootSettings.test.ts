import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupSettings } from './bootSettings';

test('the catalog drives startup defaults, units, booleans and signed values', () => {
  assert.deepEqual(startupSettings({}), { xmlrpcSizeLimit: 16777216 });
  const settings = startupSettings({ RT_DOWNLOAD_RATE: '500', RT_PEX: 'no', RT_MAX_PEERS_SEED: '-1' });
  assert.equal(settings.downloadRate, 500 * 1024);
  assert.equal(settings.pex, false);
  assert.equal(settings.maxPeersSeed, -1);
});

test('quotes and backslashes in startup strings survive JSON encoding', () => {
  const proxy = 'http://user:some"password@proxy.example/path\\';
  assert.equal(JSON.parse(JSON.stringify(startupSettings({ RT_PROXY: proxy }))).proxyAddress, proxy);
});

test('invalid startup input fails by environment name instead of dropping every setting', () => {
  for (const env of [{ RT_DOWNLOAD_RATE: 'fast' }, { RT_PEX: 'perhaps' }, { RT_MAX_UPLOADS: '-1' }]) {
    assert.throws(() => startupSettings(env), new RegExp(Object.keys(env)[0]));
  }
});
