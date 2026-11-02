import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  authenticateLocalSunoRecovery,
  handleLocalSunoRecoveryRequest,
  SunoLocalRecoveryProtocolError,
  SunoLocalRecoveryRequiredError,
  SunoLocalRecoveryStore,
} from './sunoLocalRecovery';

function fixture(options: { eventTimeoutMs?: number; leaseTimeoutMs?: number; now?: () => number } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'suno-local-recovery-test-'));
  const store = new SunoLocalRecoveryStore({ directory, browserHandle: 'test-browser', ...options });
  return { directory, store, close: () => { store.dispose(); rmSync(directory, { recursive: true, force: true }); } };
}

function hasStatus(status: number) {
  return (error: unknown) => error instanceof SunoLocalRecoveryProtocolError && error.statusCode === status;
}

test('concurrent requests on one account share one persisted event and promise', async () => {
  const f = fixture();
  try {
    const first = f.store.wait('account-1', { requestId: 'request-1' });
    const second = f.store.wait('account-1', { requestId: 'request-1' });
    const other = f.store.wait('account-2');
    assert.equal(first, second);
    assert.notEqual(first, other);
    const events = f.store.list();
    assert.equal(events.length, 2);
    const event = events.find((item) => item.accountId === 'account-1')!;
    assert.equal(event.requestId, 'request-1');
    assert.equal(Date.parse(event.expiresAt) - Date.parse(event.createdAt), 8 * 60_000);
    const claimed = f.store.claim(event.id, 'local-worker');
    const clipIds = [randomUUID()];
    let resolutions = 0;
    void first.then(() => { resolutions++; });
    assert.equal(f.store.complete(event.id, claimed.leaseToken, clipIds).status, 'completed');
    assert.deepEqual(await first, { clipIds, eventId: event.id });
    assert.equal(f.store.complete(event.id, claimed.leaseToken, clipIds).status, 'completed');
    assert.equal(resolutions, 1);
    assert.equal(f.store.list().length, 1);
    assert.equal(f.store.list(true).length, 2);
    const persisted = JSON.parse(readFileSync(path.join(f.directory, `${event.id}.json`), 'utf8'));
    assert.equal(persisted.status, 'completed');
    assert.equal(persisted.leaseToken, claimed.leaseToken);
    assert.equal(JSON.stringify(f.store.list(true)).includes(claimed.leaseToken), false);
    f.store.dispose();
    await assert.rejects(other, SunoLocalRecoveryRequiredError);
  } finally { f.close(); }
});

test('claim is exclusive and same-owner retries preserve the token and lease deadline', async () => {
  let now = Date.now();
  const f = fixture({ now: () => now });
  try {
    const waiting = f.store.wait('account');
    const event = f.store.list()[0];
    const claim = f.store.claim(event.id, 'worker-1');
    assert.equal(Date.parse(claim.leaseExpiresAt!) - now, 5 * 60_000);
    now += 30_000;
    assert.deepEqual(f.store.claim(event.id, 'worker-1'), claim);
    assert.throws(() => f.store.claim(event.id, 'worker-2'), hasStatus(409));
    assert.throws(() => f.store.complete(event.id, 'wrong-token', [randomUUID()]), hasStatus(403));
    assert.throws(() => f.store.complete(event.id, claim.leaseToken, []), hasStatus(400));
    assert.throws(() => f.store.complete(event.id, claim.leaseToken, ['not-a-clip']), hasStatus(400));
    f.store.fail(event.id, claim.leaseToken, 'generation_failed');
    await assert.rejects(waiting, (error: unknown) => error instanceof SunoLocalRecoveryRequiredError &&
      error.code === 'SUNO_LOCAL_RECOVERY_REQUIRED' && error.statusCode === 409 && error.reason === 'generation_failed');
    assert.equal(f.store.fail(event.id, claim.leaseToken).status, 'failed');
    assert.throws(() => f.store.complete(event.id, claim.leaseToken, [randomUUID()]), hasStatus(410));
  } finally { f.close(); }
});

test('an expired lease cannot be reclaimed or completed and clears the waiting account', async () => {
  let now = Date.now();
  const f = fixture({ now: () => now });
  try {
    const waiting = f.store.wait('account');
    const event = f.store.list()[0];
    const claim = f.store.claim(event.id, 'worker');
    now += 5 * 60_000;
    assert.throws(() => f.store.complete(event.id, claim.leaseToken, [randomUUID()]), hasStatus(410));
    await assert.rejects(waiting, /lease_expired/);
    assert.throws(() => f.store.claim(event.id, 'worker'), hasStatus(410));
    assert.equal(f.store.list().length, 0);
    const next = f.store.wait('account');
    assert.notEqual(f.store.list()[0].id, event.id);
    f.store.dispose();
    await assert.rejects(next, /interrupted/);
  } finally { f.close(); }
});

test('event deadline expires without polling and rejects late completion', async () => {
  const f = fixture({ eventTimeoutMs: 20 });
  try {
    const waiting = f.store.wait('account');
    const event = f.store.list()[0];
    const claim = f.store.claim(event.id, 'worker');
    assert.equal(claim.leaseExpiresAt, event.expiresAt);
    await assert.rejects(waiting, /expired/);
    assert.throws(() => f.store.complete(event.id, claim.leaseToken, [randomUUID()]), hasStatus(410));
    assert.equal(f.store.list().length, 0);
  } finally { f.close(); }
});

test('request cancellation expires its event and removes the abort listener', async (t) => {
  const f = fixture();
  const controller = new AbortController();
  const removal = t.mock.method(controller.signal, 'removeEventListener');
  try {
    const waiting = f.store.wait('account', { requestId: 'request-1', signal: controller.signal });
    const event = f.store.list()[0];
    const claim = f.store.claim(event.id, 'worker');
    controller.abort();
    await assert.rejects(waiting, /cancelled/);
    assert.equal(removal.mock.callCount(), 1);
    assert.throws(() => f.store.complete(event.id, claim.leaseToken, [randomUUID()]), hasStatus(410));
    const persisted = JSON.parse(readFileSync(path.join(f.directory, `${event.id}.json`), 'utf8'));
    assert.equal(persisted.status, 'expired');
    assert.equal(persisted.reason, 'cancelled');
  } finally { f.close(); }
});

test('completed requests detach cancellation listeners and never resume twice', async (t) => {
  const f = fixture();
  const controller = new AbortController();
  const removal = t.mock.method(controller.signal, 'removeEventListener');
  try {
    const waiting = f.store.wait('account', { signal: controller.signal });
    const event = f.store.list()[0];
    const claim = f.store.claim(event.id, 'worker');
    const clipIds = [randomUUID()];
    f.store.complete(event.id, claim.leaseToken, clipIds);
    await waiting;
    assert.equal(removal.mock.callCount(), 1);
    controller.abort();
    assert.equal(f.store.list(true)[0].status, 'completed');
    assert.throws(() => f.store.complete(event.id, claim.leaseToken, [randomUUID()]), hasStatus(409));
  } finally { f.close(); }
});

test('restart expires persisted unfinished events instead of resurrecting requests', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'suno-recovery-restart-'));
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({
    id, accountId: 'account', requestId: 'old-request', browserHandle: 'browser',
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 8 * 60_000).toISOString(),
    status: 'claimed', owner: 'old-worker', leaseToken: token,
    payload: { lyrics: 'must-not-be-exposed' }, cookies: 'must-not-be-exposed',
  }));
  const store = new SunoLocalRecoveryStore({ directory, browserHandle: 'test-browser' });
  try {
    assert.equal(store.list().length, 0);
    const [event] = store.list(true);
    assert.equal(event.status, 'expired');
    assert.equal(event.reason, 'interrupted');
    assert.equal(event.requestId, 'old-request');
    assert.throws(() => store.complete(id, token, [randomUUID()]), hasStatus(410));
    assert.equal(JSON.stringify(event).includes('must-not-be-exposed'), false);
    assert.equal(readFileSync(path.join(directory, `${id}.json`), 'utf8').includes('must-not-be-exposed'), false);
  } finally { store.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test('authentication requires the configured secret and does not trust Host', () => {
  const f = fixture();
  const secretPath = path.join(f.directory, 'secret');
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretPath, secret, { mode: 0o600 });
  try {
    assert.doesNotThrow(() => authenticateLocalSunoRecovery(new Request('http://untrusted.example/', {
      headers: { Authorization: `Bearer ${secret}`, Host: 'untrusted.example' },
    }), secretPath));
    assert.throws(() => authenticateLocalSunoRecovery(new Request('http://127.0.0.1/', {
      headers: { Host: 'localhost' },
    }), secretPath), hasStatus(401));
    assert.throws(() => authenticateLocalSunoRecovery(new Request('http://127.0.0.1/', {
      headers: { Authorization: `Bearer ${randomBytes(32).toString('hex')}` },
    }), secretPath), hasStatus(401));
    assert.throws(() => authenticateLocalSunoRecovery(new Request('http://127.0.0.1/'), `${secretPath}.missing`), hasStatus(503));
  } finally { f.close(); }
});

test('authenticated protocol exposes lease tokens only from claim and validates action bodies', async () => {
  const f = fixture();
  const secretPath = path.join(f.directory, 'secret');
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  const call = (body?: unknown, suffix = '') => handleLocalSunoRecoveryRequest(new Request(`http://127.0.0.1/api/internal/captcha-recovery${suffix}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${secret}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { store: f.store, secretPath });
  try {
    const waiting = f.store.wait('account', { reason: 'Authorization: secret; lyrics: private' });
    const listed = await (await call()).json();
    assert.equal(listed.events[0].reason, 'captcha_required');
    const id = listed.events[0].id;
    const claim = await (await call({ action: 'claim', id, owner: 'worker' })).json();
    const token = claim.event.leaseToken;
    assert.equal(typeof token, 'string');
    assert.equal((await (await call()).text()).includes(token), false);
    assert.equal((await call({ action: 'complete', id, leaseToken: token, clipIds: ['invalid'] })).status, 400);
    const clipIds = [randomUUID()];
    const completed = await call({ action: 'complete', id, leaseToken: token, clipIds });
    assert.equal(completed.status, 200);
    assert.equal((await completed.text()).includes(token), false);
    assert.deepEqual(await waiting, { clipIds, eventId: id });
    assert.deepEqual((await (await call()).json()).events, []);
    assert.equal((await (await call(undefined, '?include=recent')).json()).events.length, 1);
    assert.equal((await call({ action: 'unknown' })).status, 400);
    assert.equal((await call({ action: 'claim', id, owner: 'x'.repeat(9000) })).status, 413);
  } finally { f.close(); }
});

test('protocol errors remain correctly classified across Next route bundle boundaries', async (t) => {
  const f = fixture();
  const secretPath = path.join(f.directory, 'secret');
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretPath, secret, { mode: 0o600 });
  t.mock.method(f.store, 'list', () => {
    throw { code: 'SUNO_LOCAL_RECOVERY_PROTOCOL', statusCode: 410, message: 'Recovery event has expired' };
  });
  try {
    const response = await handleLocalSunoRecoveryRequest(new Request('http://127.0.0.1/', {
      headers: { authorization: `Bearer ${secret}` },
    }), { store: f.store, secretPath });
    assert.equal(response.status, 410);
  } finally { f.close(); }
});
