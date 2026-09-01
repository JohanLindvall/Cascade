/**
 * loadConfig is the only reader of the environment, and every default it
 * uses comes out of the option catalog — so a fresh environment must give the
 * documented defaults, and the few values that are shaped rather than copied
 * (the base path, the delete roots, the SCGI target) are pinned here.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from './config';
import { documentedDefault } from './options';

test('an empty environment yields the documented defaults', () => {
  const config = loadConfig({});
  assert.equal(config.port, Number(documentedDefault('WEB_PORT')));
  assert.equal(config.host, documentedDefault('WEB_HOST'));
  assert.equal(config.basePath, '/');
  assert.equal(config.downloadDir, documentedDefault('RT_DOWNLOAD_DIR'));
  assert.equal(config.completedDir, undefined);
  assert.deepEqual(config.deleteRoots, [path.resolve(documentedDefault('RT_DOWNLOAD_DIR')!)]);
  assert.deepEqual(config.scgi, { kind: 'unix', path: documentedDefault('RT_SCGI_SOCKET') });
  assert.equal(config.allowRawRpc, true);
  assert.equal(config.gamify, true);
  assert.equal(config.maxUploadBytes, Number(documentedDefault('CASCADE_MAX_UPLOAD_MB')) * 1024 * 1024);
  assert.equal(config.user, undefined);
});

test('the base path is normalised to a leading slash and no trailing one', () => {
  assert.equal(loadConfig({ WEB_BASE_PATH: 'rtorrent/' }).basePath, '/rtorrent');
  assert.equal(loadConfig({ WEB_BASE_PATH: '/ui' }).basePath, '/ui');
  assert.equal(loadConfig({ WEB_BASE_PATH: '/' }).basePath, '/');
});

test('delete roots collect the download, completed and extra directories, resolved', () => {
  const config = loadConfig({
    RT_DOWNLOAD_DIR: '/data/dl',
    RT_COMPLETED_DIR: '/data/done/',
    CASCADE_DELETE_ROOTS: '/mnt/a::relative/../b',
  });
  assert.deepEqual(config.deleteRoots, ['/data/dl', '/data/done', '/mnt/a', path.resolve('b')]);
});

test('CASCADE_SCGI overrides the socket and understands host:port', () => {
  assert.deepEqual(loadConfig({ CASCADE_SCGI: 'rt.internal:5000' }).scgi, {
    kind: 'tcp',
    host: 'rt.internal',
    port: 5000,
  });
  assert.deepEqual(loadConfig({ RT_SCGI_SOCKET: '/tmp/x.sock' }).scgi, { kind: 'unix', path: '/tmp/x.sock' });
});

test('booleans read the usual spellings; an empty value means unset', () => {
  assert.equal(loadConfig({ CASCADE_GAMIFY: '0' }).gamify, false);
  assert.equal(loadConfig({ CASCADE_GAMIFY: 'no' }).gamify, false);
  assert.equal(loadConfig({ CASCADE_GAMIFY: 'YES' }).gamify, true);
  assert.equal(loadConfig({ CASCADE_GAMIFY: '' }).gamify, true);
  assert.equal(loadConfig({ WEB_PORT: 'eighty' }).port, 8080); // junk falls back
});
