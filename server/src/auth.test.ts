/**
 * Basic auth is the only thing between the internet and rtorrent's execute
 * command when the UI is exposed, so its edges are pinned: enabled only when
 * both halves are set, a colon inside the password survives, and the challenge
 * header is right.
 */
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { test } from 'node:test';
import { basicAuth } from './auth';
import { testConfig } from './testing/fakes';

function attempt(config: Parameters<typeof basicAuth>[0], authorization?: string) {
  let passed = false;
  let status = 0;
  const headers: Record<string, string> = {};
  const req = { headers: authorization ? { authorization } : {} } as Request;
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    status: (code: number) => {
      status = code;
      return res;
    },
    type: () => res,
    send: () => res,
  } as unknown as Response;
  const next: NextFunction = () => {
    passed = true;
  };
  basicAuth(config)(req, res, next);
  return { passed, status, headers };
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

test('auth is off unless both user and password are set', () => {
  assert.equal(attempt(testConfig()).passed, true);
  assert.equal(attempt(testConfig({ user: 'admin' })).passed, true);
  assert.equal(attempt(testConfig({ password: 'x' })).passed, true);
  assert.equal(attempt(testConfig({ user: 'admin', password: 'x' })).passed, false);
});

test('the right credentials pass, anything else gets a challenge', () => {
  const config = testConfig({ user: 'admin', password: 'p:ss:word' });
  assert.equal(attempt(config, basic('admin', 'p:ss:word')).passed, true);
  for (const header of [undefined, 'Bearer nope', basic('admin', 'wrong'), basic('root', 'p:ss:word'), 'Basic !!!']) {
    const result = attempt(config, header);
    assert.equal(result.passed, false, String(header));
    assert.equal(result.status, 401);
    assert.match(result.headers['WWW-Authenticate'], /^Basic realm="Cascade"/);
  }
});
