import assert from 'node:assert/strict';
import test from 'node:test';
import { applySunoSessionToken } from './sunoAuthCookies';

test('updates all Clerk session cookie variants', () => {
  const cookies = {
    __client: 'long-lived-client',
    __session: 'expired-session',
    '__session_instance-a': 'expired-instance-session'
  };
  assert.equal(applySunoSessionToken(cookies, 'fresh-session'), true);
  assert.deepEqual(cookies, {
    __client: 'long-lived-client',
    __session: 'fresh-session',
    '__session_instance-a': 'fresh-session'
  });
  assert.equal(applySunoSessionToken(cookies, 'fresh-session'), false);
});

test('adds a session cookie when only the long-lived client exists', () => {
  const cookies: Record<string, string | undefined> = { __client: 'client' };
  assert.equal(applySunoSessionToken(cookies, 'fresh-session'), true);
  assert.equal(cookies.__session, 'fresh-session');
});
