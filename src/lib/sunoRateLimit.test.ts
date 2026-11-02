import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRetryableSunoRequest,
  retryAfterSeconds,
  runSunoStatusRequest,
  suno429DelayMs
} from './sunoRateLimit';

test('retries only read, captcha check, and idempotent generation requests', () => {
  assert.equal(isRetryableSunoRequest({ method: 'GET', url: '/api/feed/v3' }), true);
  assert.equal(isRetryableSunoRequest({ method: 'POST', url: '/api/c/check' }), true);
  assert.equal(isRetryableSunoRequest({ method: 'POST', url: '/api/feed/v3' }), true);
  assert.equal(isRetryableSunoRequest({
    method: 'POST',
    url: '/api/generate/v2-web/',
    data: JSON.stringify({ transaction_uuid: 'transaction-1' })
  }), true);
  assert.equal(isRetryableSunoRequest({
    method: 'POST',
    url: '/api/generate/v2-web/',
    data: { prompt: 'missing transaction UUID' }
  }), false);
  assert.equal(isRetryableSunoRequest({ method: 'POST', url: '/api/uploads/audio' }), false);
});

test('serializes and spaces status polling for one account', async () => {
  const previousInterval = process.env.SUNO_STATUS_MIN_INTERVAL_MS;
  process.env.SUNO_STATUS_MIN_INTERVAL_MS = '15';
  const accountId = `status-${Date.now()}`;
  const startedAt: number[] = [];
  let active = 0;
  let maximumActive = 0;
  try {
    await Promise.all([1, 2, 3].map(() => runSunoStatusRequest(accountId, async () => {
      startedAt.push(Date.now());
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    })));
    assert.equal(maximumActive, 1);
    assert.ok(startedAt[1] - startedAt[0] >= 10);
    assert.ok(startedAt[2] - startedAt[1] >= 10);
  } finally {
    if (previousInterval === undefined) delete process.env.SUNO_STATUS_MIN_INTERVAL_MS;
    else process.env.SUNO_STATUS_MIN_INTERVAL_MS = previousInterval;
  }
});

test('parses numeric and HTTP-date Retry-After values', () => {
  const now = Date.UTC(2026, 8, 8, 2, 0, 0);
  assert.equal(retryAfterSeconds({ 'retry-after': '7' }, now), 7);
  assert.equal(retryAfterSeconds({ 'Retry-After': 'Tue, 08 Sep 2026 02:00:09 GMT' }, now), 9);
  assert.equal(retryAfterSeconds({ 'retry-after': 'invalid' }, now), undefined);
});

test('backs off exponentially and respects the configured delay cap', () => {
  const previousBase = process.env.SUNO_429_BASE_DELAY_MS;
  const previousMax = process.env.SUNO_429_MAX_DELAY_MS;
  process.env.SUNO_429_BASE_DELAY_MS = '1000';
  process.env.SUNO_429_MAX_DELAY_MS = '5000';
  try {
    assert.equal(suno429DelayMs(1, undefined, () => 0), 1000);
    assert.equal(suno429DelayMs(3, undefined, () => 0), 4000);
    assert.equal(suno429DelayMs(1, { 'retry-after': '30' }, () => 0), 5000);
  } finally {
    if (previousBase === undefined) delete process.env.SUNO_429_BASE_DELAY_MS;
    else process.env.SUNO_429_BASE_DELAY_MS = previousBase;
    if (previousMax === undefined) delete process.env.SUNO_429_MAX_DELAY_MS;
    else process.env.SUNO_429_MAX_DELAY_MS = previousMax;
  }
});
