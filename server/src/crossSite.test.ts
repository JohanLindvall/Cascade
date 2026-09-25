/**
 * The cross-site rule has to refuse exactly the requests a hostile page can
 * make the browser send — and nothing that scripts, the *arr apps or browser
 * extensions send, which carry no Sec-Fetch-Site, no Origin, or an origin no
 * page can forge.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCrossSiteRequest } from './crossSite';

const post = (facts: { origin?: string; fetchSite?: string; host?: string }) =>
  isCrossSiteRequest({ method: 'POST', host: 'cascade.lan:8080', ...facts });

test('reads are never refused, whoever asks', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
    assert.equal(isCrossSiteRequest({ method, fetchSite: 'cross-site', origin: 'https://evil.example' }), false);
  }
});

test('Sec-Fetch-Site decides when a browser sends it', () => {
  assert.equal(post({ fetchSite: 'same-origin' }), false);
  assert.equal(post({ fetchSite: 'none' }), false); // the user's own navigation or drop
  assert.equal(post({ fetchSite: 'cross-site' }), true);
  assert.equal(post({ fetchSite: 'same-site' }), true); // a sibling subdomain is still another app
  // Behind a proxy the header still says same-origin, whatever Host became.
  assert.equal(post({ fetchSite: 'same-origin', origin: 'https://torrents.example', host: 'cascade:8080' }), false);
});

test('an older browser is judged by Origin against the host it addressed', () => {
  assert.equal(post({ origin: 'http://cascade.lan:8080' }), false);
  assert.equal(post({ origin: 'https://evil.example' }), true);
  assert.equal(post({ origin: 'http://cascade.lan:9999' }), true); // another port is another origin
  assert.equal(post({ origin: 'null' }), true); // a sandboxed frame or a file:// page
});

test('non-browser clients carry no markers and pass', () => {
  assert.equal(post({}), false);
  assert.equal(isCrossSiteRequest({ method: 'DELETE' }), false);
});

test('browser extensions pass on their unforgeable origin', () => {
  for (const origin of ['chrome-extension://abcdef', 'moz-extension://1234-5678', 'safari-web-extension://x']) {
    assert.equal(post({ origin, fetchSite: 'cross-site' }), false, origin);
  }
});
