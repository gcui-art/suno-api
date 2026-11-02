import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { SunoCaptchaManualInterventionError } from './sunoCaptchaErrors';
import {
  clearCaptchaCooldown,
  markCaptchaRequired,
  runAccountGeneration
} from './sunoGenerationGuard';

test('serializes generation attempts for one account', async () => {
  const accountId = `serialize-${Date.now()}`;
  const previousInterval = process.env.SUNO_GENERATION_MIN_INTERVAL_MS;
  process.env.SUNO_GENERATION_MIN_INTERVAL_MS = '1';
  let active = 0;
  let maximumActive = 0;
  try {
    await Promise.all([1, 2, 3].map(() => runAccountGeneration(accountId, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    })));
    assert.equal(maximumActive, 1);
  } finally {
    if (previousInterval === undefined) delete process.env.SUNO_GENERATION_MIN_INTERVAL_MS;
    else process.env.SUNO_GENERATION_MIN_INTERVAL_MS = previousInterval;
  }
});

test('blocks attempts during captcha cooldown and clears after cookie update', async () => {
  const accountId = `captcha-${Date.now()}`;
  markCaptchaRequired(accountId);
  await assert.rejects(
    runAccountGeneration(accountId, async () => 'unexpected'),
    SunoCaptchaManualInterventionError
  );
  clearCaptchaCooldown(accountId);
  assert.equal(await runAccountGeneration(accountId, async () => 'ok'), 'ok');
});

test('queued requests retain spacing after a browser recovery clears cooldown', async () => {
  const accountId = `recovered-${Date.now()}`;
  const previousInterval = process.env.SUNO_GENERATION_MIN_INTERVAL_MS;
  process.env.SUNO_GENERATION_MIN_INTERVAL_MS = '25';
  let finishedAt = 0;
  try {
    const first = runAccountGeneration(accountId, async () => {
      clearCaptchaCooldown(accountId);
      await new Promise((resolve) => setTimeout(resolve, 30));
      finishedAt = Date.now();
    });
    const second = runAccountGeneration(accountId, async () => {
      assert.ok(Date.now() - finishedAt >= 24);
    });
    await Promise.all([first, second]);
  } finally {
    if (previousInterval === undefined) delete process.env.SUNO_GENERATION_MIN_INTERVAL_MS;
    else process.env.SUNO_GENERATION_MIN_INTERVAL_MS = previousInterval;
  }
});

test('cancelled queued requests settle promptly without passing the active generation or delaying live work',
  { timeout: 2_000 }, async (t) => {
    const accountId = randomUUID();
    const previousInterval = process.env.SUNO_GENERATION_MIN_INTERVAL_MS;
    process.env.SUNO_GENERATION_MIN_INTERVAL_MS = '80';
    t.after(() => {
      if (previousInterval === undefined) delete process.env.SUNO_GENERATION_MIN_INTERVAL_MS;
      else process.env.SUNO_GENERATION_MIN_INTERVAL_MS = previousInterval;
    });
    let finishFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const first = runAccountGeneration(accountId, async () => {
      markFirstStarted();
      await new Promise<void>((resolve) => { finishFirst = resolve; });
    });
    await firstStarted;
    const reason = new Error('job deadline expired');
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    let cancelledOperations = 0;
    const cancelled = controllers.map((controller) => assert.rejects(
      runAccountGeneration(accountId, async () => { cancelledOperations++; }, controller.signal),
      (error: unknown) => error === reason
    ));
    let liveStarted = false;
    const live = runAccountGeneration(accountId, async () => { liveStarted = true; });
    controllers.forEach((controller) => controller.abort(reason));
    await Promise.all(cancelled);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(liveStarted, false, 'cancellation must not release the active predecessor');
    finishFirst();
    await first;
    let timeout!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([live, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('expired queue entries delayed live work')), 400);
      })]);
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(liveStarted, true);
    assert.equal(cancelledOperations, 0);
  });

test('cancelling the spacing wait preserves the original next allowed time',
  { timeout: 2_000 }, async (t) => {
    const accountId = randomUUID();
    const previousInterval = process.env.SUNO_GENERATION_MIN_INTERVAL_MS;
    process.env.SUNO_GENERATION_MIN_INTERVAL_MS = '15000';
    t.after(() => {
      if (previousInterval === undefined) delete process.env.SUNO_GENERATION_MIN_INTERVAL_MS;
      else process.env.SUNO_GENERATION_MIN_INTERVAL_MS = previousInterval;
    });
    let now = 100_000;
    t.mock.method(Date, 'now', () => now);
    await runAccountGeneration(accountId, async () => 'first');
    now += 5_000;
    const controller = new AbortController();
    const reason = new Error('cancelled during spacing');
    const cancelled = assert.rejects(
      runAccountGeneration(accountId, async () => assert.fail('cancelled work must not start'), controller.signal),
      (error: unknown) => error === reason
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(reason);
    await cancelled;
    // The first operation's interval has now elapsed. Cancellation at +5s must
    // not have moved the next allowed time to +20s.
    now += 10_000;
    assert.equal(await runAccountGeneration(accountId, async () => 'live'), 'live');
  });
