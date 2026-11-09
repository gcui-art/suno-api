import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForDelay } from './sunoCaptchaSnapshotTimer';

test('reports when the diagnostic delay elapses', async () => {
  const controller = new AbortController();
  assert.equal(await waitForDelay(10, controller.signal), true);
});

test('stops waiting when captcha solving finishes', async () => {
  const controller = new AbortController();
  const waiting = waitForDelay(20_000, controller.signal);
  controller.abort();
  assert.equal(await waiting, false);
});
