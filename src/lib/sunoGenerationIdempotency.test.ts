import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  runIdempotentGeneration,
  SunoIdempotencyCapacityError,
  SunoIdempotencyConflictError
} from './sunoGenerationIdempotency';

const TEN_MINUTES = 10 * 60 * 1_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('concurrent retries share one submission and its successful result', async () => {
  const key = randomUUID();
  const generation = deferred<string[]>();
  let submissions = 0;
  const submit = () => {
    submissions += 1;
    return generation.promise;
  };
  const first = runIdempotentGeneration('generate', key, { prompt: 'music' }, submit);
  const retry = runIdempotentGeneration('generate', key, { prompt: 'music' }, submit);
  assert.equal(first, retry);
  await Promise.resolve();
  assert.equal(submissions, 1);
  generation.resolve(['clip-1']);
  assert.deepEqual(await first, ['clip-1']);
  assert.deepEqual(await retry, ['clip-1']);
  assert.deepEqual(await runIdempotentGeneration('generate', key, { prompt: 'music' }, submit), ['clip-1']);
  assert.equal(submissions, 1);
});

test('fingerprints ignore nested object order while retaining array order', async () => {
  const key = randomUUID();
  let submissions = 0;
  const submit = async () => ++submissions;
  const body = { prompt: 'music', options: { model: 'v5', controls: [{ a: 1, b: 2 }, 3] } };
  assert.equal(await runIdempotentGeneration('generate', key, body, submit), 1);
  assert.equal(await runIdempotentGeneration('generate', key, {
    options: { controls: [{ b: 2, a: 1 }, 3], model: 'v5' }, prompt: 'music'
  }, submit), 1);
  await assert.rejects(runIdempotentGeneration('generate', key, {
    ...body, options: { model: 'v5', controls: [3, { a: 1, b: 2 }] }
  }, submit), SunoIdempotencyConflictError);
  assert.equal(submissions, 1);
});

test('conflicting bodies return 409 without submitting while the original is pending', async () => {
  const key = randomUUID();
  const generation = deferred<string>();
  const first = runIdempotentGeneration('generate', key, { prompt: 'first' }, () => generation.promise);
  await assert.rejects(
    runIdempotentGeneration('generate', key, { prompt: 'changed' }, async () => 'unexpected'),
    { statusCode: 409, code: 'SUNO_IDEMPOTENCY_KEY_CONFLICT' }
  );
  generation.resolve('clip-1');
  assert.equal(await first, 'clip-1');
});

test('settled failures reach all callers and permit a subsequent explicit retry', async () => {
  const key = randomUUID();
  const generation = deferred<string>();
  let submissions = 0;
  const submit = () => {
    submissions += 1;
    return generation.promise;
  };
  const first = runIdempotentGeneration('generate', key, {}, submit);
  const retry = runIdempotentGeneration('generate', key, {}, submit);
  const failure = new Error('captcha recovery failed');
  const checked = Promise.all([
    assert.rejects(first, (error) => error === failure),
    assert.rejects(retry, (error) => error === failure)
  ]);
  generation.reject(failure);
  await checked;
  assert.equal(submissions, 1);
  assert.equal(await runIdempotentGeneration('generate', key, {}, async () => {
    submissions += 1;
    return 'clip-2';
  }), 'clip-2');
  assert.equal(submissions, 2);
});

test('synchronous failures also release the request key', async () => {
  const key = randomUUID();
  await assert.rejects(runIdempotentGeneration('generate', key, {}, () => {
    throw new Error('invalid request');
  }), /invalid request/);
  assert.equal(await runIdempotentGeneration('generate', key, {}, async () => 'ok'), 'ok');
});

test('requests without a key keep independent submissions', async () => {
  let submissions = 0;
  const submit = async () => ++submissions;
  assert.deepEqual(await Promise.all([
    runIdempotentGeneration('generate', null, {}, submit),
    runIdempotentGeneration('generate', null, {}, submit)
  ]), [1, 2]);
});

test('the same key remains independent across generation endpoints', async () => {
  const key = randomUUID();
  assert.deepEqual(await Promise.all([
    runIdempotentGeneration('generate', key, {}, async () => 'simple'),
    runIdempotentGeneration('custom_generate', key, {}, async () => 'custom')
  ]), ['simple', 'custom']);
});

test('success expires ten minutes after completion and pending work never expires', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const key = randomUUID();
  const generation = deferred<string>();
  const first = runIdempotentGeneration('generate', key, {}, () => generation.promise);
  now += TEN_MINUTES * 2;
  const pendingRetry = runIdempotentGeneration('generate', key, {}, async () => 'unexpected');
  assert.equal(first, pendingRetry);
  generation.resolve('original');
  await first;
  now += TEN_MINUTES - 1;
  assert.equal(await runIdempotentGeneration('generate', key, {}, async () => 'unexpected'), 'original');
  now += 1;
  assert.equal(await runIdempotentGeneration('generate', key, {}, async () => 'new'), 'new');
});

test('capacity refuses new work without evicting pending or unexpired requests', async (t) => {
  let now = Date.now() + TEN_MINUTES * 10;
  t.mock.method(Date, 'now', () => now);
  const generation = deferred<string>();
  const firstKey = randomUUID();
  let submissions = 0;
  const submit = () => {
    submissions += 1;
    return generation.promise;
  };
  const pending = [runIdempotentGeneration('generate', firstKey, {}, submit)];
  for (let index = 1; index < 1_000; index += 1) {
    pending.push(runIdempotentGeneration('generate', randomUUID(), {}, submit));
  }
  const overflowKey = randomUUID();
  const assertFull = () => assert.rejects(
    runIdempotentGeneration('generate', overflowKey, {}, submit),
    (error: unknown) => error instanceof SunoIdempotencyCapacityError
      && error.statusCode === 503 && error.retryAfterSeconds > 0
  );
  await assertFull();
  assert.equal(submissions, 1_000);
  now += TEN_MINUTES * 2;
  assert.equal(runIdempotentGeneration('generate', firstKey, {}, submit), pending[0]);
  await assertFull();
  generation.resolve('clip-1');
  await Promise.all(pending);
  assert.equal(await runIdempotentGeneration('generate', firstKey, {}, submit), 'clip-1');
  await assertFull();
  now += TEN_MINUTES;
  assert.equal(await runIdempotentGeneration('generate', overflowKey, {}, async () => 'clip-2'), 'clip-2');
});
