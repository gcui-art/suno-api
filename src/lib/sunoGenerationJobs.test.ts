import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import test, { type TestContext } from 'node:test';
import type { NextRequest } from 'next/server';
import ts from 'typescript';
import {
  getCurrentSunoGenerationJob,
  markSunoGenerationAccepted,
  markSunoGenerationRejected,
  markSunoGenerationSubmitted,
  prefersAsyncGeneration,
  SunoGenerationJobStore
} from './sunoGenerationJobs';

function fixture(t: TestContext, options: Partial<ConstructorParameters<typeof SunoGenerationJobStore>[0]> = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'suno-jobs-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SunoGenerationJobStore({ directory, responseWaitMs: 100, operationTimeoutMs: 1_000, ...options });
  return { store, directory };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function request(key: string | null = 'request-key', body: Record<string, unknown> = { prompt: 'original music' }) {
  return { namespace: 'generate', idempotencyKey: key, body, respondAsync: true, selectAccount: async () => 'account-1' };
}

test('only an explicit respond-async preference enables pending POST responses', () => {
  for (const header of [null, '', 'wait=85', 'respond-async-later', 'wait=85; respond-async', 'respond-async=false']) {
    assert.equal(prefersAsyncGeneration(header), false, String(header));
  }
  for (const header of ['respond-async', 'wait=85, respond-async', ' RESPOND-ASYNC ; handling=strict ']) {
    assert.equal(prefersAsyncGeneration(header), true, header);
  }
});

test('legacy callers wait past the async response window while opted-in callers query the same job', async (t) => {
  const { store } = fixture(t, { responseWaitMs: 5, operationTimeoutMs: 5_000 });
  for (const asyncFirst of [false, true]) {
    const generation = deferred<string[]>();
    const input = {
      namespace: 'generate', idempotencyKey: `preference-${asyncFirst}`,
      body: { prompt: 'original music' }, selectAccount: async () => 'account-1'
    };
    const initial = store.run({ ...input, respondAsync: asyncFirst || undefined }, () => generation.promise);
    const legacy = asyncFirst ? store.run(input, async () => assert.fail('duplicate generation')) : initial;
    const asynchronous = asyncFirst ? initial : store.run({ ...input, respondAsync: true }, async () => assert.fail('duplicate generation'));
    let legacyFinished = false;
    void legacy.then(() => { legacyFinished = true; });
    const pending = await asynchronous;
    assert.equal(pending.status, 'pending');
    assert.equal(legacyFinished, false);
    assert.deepEqual(store.get(pending.request_id), pending);
    generation.resolve(['original-clip']);
    assert.deepEqual(await legacy, { status: 'succeeded', request_id: pending.request_id, result: ['original-clip'] });
  }
});

test('concurrent and completed retries keep one account, transaction and result across reload', async (t) => {
  const { store, directory } = fixture(t);
  const generation = deferred<string[]>();
  let selected = 0;
  let submitted = 0;
  const input = { ...request(), selectAccount: async () => `account-${++selected}` };
  const operation = async (job: Parameters<Parameters<typeof store.run>[1]>[0]) => {
    submitted++;
    assert.equal(job.accountId, 'account-1');
    assert.equal(getCurrentSunoGenerationJob(), job);
    assert.equal(JSON.parse(readFileSync(path.join(directory, `${job.id}.json`), 'utf8')).transactionUuid, job.transactionUuid);
    return generation.promise;
  };
  const first = store.run(input, operation);
  const concurrent = store.run(input, operation);
  await Promise.resolve();
  generation.resolve(['clip-1']);
  const result = await first;
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(await concurrent, result);
  const restarted = new SunoGenerationJobStore({ directory });
  assert.deepEqual(await restarted.run(input, operation), result);
  assert.equal(selected, 1);
  assert.equal(submitted, 1);
  assert.equal(getCurrentSunoGenerationJob(), undefined);
});

test('bounded response returns a queryable pending ID and later exposes only the result', async (t) => {
  const { store, directory } = fixture(t, { responseWaitMs: 5 });
  const generation = deferred<string[]>();
  const input = request('private-client-key', { prompt: 'private lyrics', metadata: { lyrics_model: 'default' } });
  const pending = await store.run(input, () => generation.promise);
  assert.equal(pending.status, 'pending');
  if (pending.status !== 'pending') assert.fail();
  assert.equal(pending.status_url, `/api/generation-requests/${pending.request_id}`);
  assert.equal(pending.retry_after_seconds, 3);
  assert.deepEqual(store.get(pending.request_id), pending);
  assert.equal(JSON.stringify(pending).includes('private'), false);
  const filename = path.join(directory, `${pending.request_id}.json`);
  const contents = readFileSync(filename, 'utf8');
  assert.deepEqual(JSON.parse(contents).body, input.body);
  assert.equal(contents.includes('private-client-key'), false);
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  generation.resolve(['original-clip']);
  const completed = await store.run(input, async () => assert.fail('duplicate submission'));
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(store.get(pending.request_id), completed);
});

test('stored failures preserve HTTP details and keys instead of replaying after reload', async (t) => {
  const { store, directory } = fixture(t);
  let submissions = 0;
  const operation = async () => {
    submissions++;
    markSunoGenerationSubmitted();
    throw {
      message: 'rate limited',
      code: 'ERR_BAD_REQUEST',
      response: { status: 429, data: { detail: 'Try later' }, headers: { 'retry-after': '9' } },
      config: { headers: { authorization: 'must-not-persist' } }
    };
  };
  const failed = await store.run(request(), operation);
  assert.equal(failed.status, 'failed');
  if (failed.status !== 'failed') assert.fail();
  assert.equal(failed.error.statusCode, 429);
  assert.equal(failed.error.retryAfterSeconds, 9);
  assert.equal(failed.error.response?.data.detail, 'Try later');
  assert.equal(readFileSync(path.join(directory, `${failed.request_id}.json`), 'utf8').includes('must-not-persist'), false);
  const restarted = new SunoGenerationJobStore({ directory });
  assert.deepEqual(await restarted.run(request(), operation), failed);
  assert.equal(submissions, 1);
});

test('canonical fingerprints ignore object ordering, reject changed arrays and isolate endpoints', async (t) => {
  const { store } = fixture(t);
  let submissions = 0;
  const submit = async () => ++submissions;
  const first = await store.run(request('key', { nested: { b: 2, a: 1 }, items: [1, 2] }), submit);
  assert.deepEqual(await store.run(request('key', { items: [1, 2], nested: { a: 1, b: 2 } }), submit), first);
  await assert.rejects(store.run(request('key', { nested: { a: 1, b: 2 }, items: [2, 1] }), submit), {
    statusCode: 409, code: 'SUNO_IDEMPOTENCY_KEY_CONFLICT'
  });
  const custom = await store.run({ ...request('key'), namespace: 'custom_generate' }, submit);
  assert.equal(custom.status, 'succeeded');
  assert.notEqual(custom.request_id, first.request_id);
  assert.equal(submissions, 2);
});

test('requests without keys are independent and explicit transaction UUIDs stay unchanged', async (t) => {
  const { store } = fixture(t);
  const transactionUuids: string[] = [];
  const operation = async (job: Parameters<Parameters<typeof store.run>[1]>[0]) => {
    transactionUuids.push(job.transactionUuid);
    return [];
  };
  const first = await store.run(request(null), operation);
  const second = await store.run(request(null), operation);
  await store.run(request(null, { transaction_uuid: 'original-transaction' }), operation);
  assert.notEqual(first.request_id, second.request_id);
  assert.notEqual(transactionUuids[0], transactionUuids[1]);
  assert.equal(transactionUuids[2], 'original-transaction');
});

test('process interruption retains payload and distinguishes submission uncertainty without replay', async (t) => {
  for (const submitted of [false, true]) {
    const { directory } = fixture(t);
    const modulePath = path.join(process.cwd(), 'src/lib/sunoGenerationJobs.ts');
    const script = `
      const { SunoGenerationJobStore, markSunoGenerationSubmitted } = require(${JSON.stringify(modulePath)});
      const store = new SunoGenerationJobStore({ directory: ${JSON.stringify(directory)} });
      store.run({ namespace: 'generate', idempotencyKey: 'crashed-request',
        body: { prompt: 'original body', transaction_uuid: 'original-transaction' },
        selectAccount: async () => 'fixed-account' }, async () => {
          if (${submitted}) markSunoGenerationSubmitted();
          process.exit(0);
        });
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--eval', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000
    });
    assert.equal(child.status, 0, child.stderr);
    const restarted = new SunoGenerationJobStore({ directory });
    const filename = readdirSync(directory).find((name) => name.endsWith('.json'))!;
    const disk = JSON.parse(readFileSync(path.join(directory, filename), 'utf8'));
    assert.equal(disk.accountId, 'fixed-account');
    assert.equal(disk.body.prompt, 'original body');
    assert.equal(disk.transactionUuid, 'original-transaction');
    const result = await restarted.run(request('crashed-request', disk.body), async () => assert.fail('interrupted work replayed'));
    assert.equal(result.status, 'interrupted');
    if (result.status !== 'interrupted') assert.fail();
    assert.equal(result.error.code, submitted ? 'SUNO_GENERATION_RESULT_UNKNOWN' : 'SUNO_GENERATION_INTERRUPTED');
  }
});

test('deadline abort prevents a delayed operation from submitting and retains its failed key', async (t) => {
  const { store } = fixture(t, { operationTimeoutMs: 15 });
  const resume = deferred<void>();
  let signal: AbortSignal | undefined;
  let submitted = 0;
  const result = await store.run(request(), async (job) => {
    signal = job.signal;
    await resume.promise;
    markSunoGenerationSubmitted();
    submitted++;
    return ['late-clip'];
  });
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') assert.fail();
  assert.equal(result.error.code, 'SUNO_GENERATION_TIMEOUT');
  assert.equal(signal?.aborted, true);
  resume.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitted, 0);
  assert.deepEqual(await store.run(request(), async () => assert.fail('timed-out work replayed')), result);
});

test('explicit rejection clears uncertainty, while accepted clip IDs survive later polling errors', async (t) => {
  const { store, directory } = fixture(t);
  const result = await store.run(request(), async (job) => {
    markSunoGenerationSubmitted();
    markSunoGenerationRejected();
    assert.equal(JSON.parse(readFileSync(path.join(directory, `${job.id}.json`), 'utf8')).submissionState, 'not_submitted');
    markSunoGenerationSubmitted();
    markSunoGenerationAccepted(['original-clip']);
    throw new Error('status polling failed');
  });
  assert.equal(result.status, 'failed');
  const saved = JSON.parse(readFileSync(path.join(directory, `${result.request_id}.json`), 'utf8'));
  assert.equal(saved.submissionState, 'accepted');
  assert.deepEqual(saved.clipIds, ['original-clip']);
});

test('capacity preserves pending and recent results, then expires completed records', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { store, directory } = fixture(t, { maxJobs: 1, ttlMs: 50, responseWaitMs: 1 });
  const generation = deferred<string>();
  const pending = await store.run(request(), () => generation.promise);
  now += 100;
  await assert.rejects(store.run(request('other'), async () => assert.fail()), { code: 'SUNO_GENERATION_JOB_CAPACITY', retryAfterSeconds: 30 });
  assert.deepEqual(store.get(pending.request_id), pending);
  generation.resolve('result');
  const done = await store.run(request(), async () => assert.fail());
  assert.equal(done.status, 'succeeded');
  await assert.rejects(store.run(request('other'), async () => assert.fail()), { code: 'SUNO_GENERATION_JOB_CAPACITY' });
  now += 51;
  assert.equal(store.get(pending.request_id), undefined);
  assert.equal(readdirSync(directory).filter((name) => name.endsWith('.json')).length, 0);
  assert.equal((await store.run(request('other'), async () => 'new-result')).status, 'succeeded');
});

test('unknown and malformed request IDs do not escape the job directory', (t) => {
  const { store } = fixture(t);
  assert.equal(store.get('../../accounts'), undefined);
  assert.equal(store.get('00000000-0000-4000-8000-000000000000'), undefined);
});

test('status endpoint returns pending metadata, the original result array and stored errors', async (t) => {
  const { store } = fixture(t, { responseWaitMs: 5 });
  const state = globalThis as typeof globalThis & { __sunoGenerationJobStore?: SunoGenerationJobStore };
  const previous = state.__sunoGenerationJobStore;
  state.__sunoGenerationJobStore = store;
  t.after(() => { state.__sunoGenerationJobStore = previous; });
  const { GET } = await import('../app/api/generation-requests/[id]/route');
  const generation = deferred<Array<{ id: string }>>();
  const pending = await store.run(request(), () => generation.promise);
  const get = () => GET({} as NextRequest, { params: { id: pending.request_id } });
  const pendingResponse = await get();
  assert.equal(pendingResponse.status, 202);
  assert.equal(pendingResponse.headers.get('Retry-After'), '3');
  assert.equal(pendingResponse.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await pendingResponse.json(), pending);
  generation.resolve([{ id: 'original-clip' }]);
  await store.run(request(), async () => assert.fail());
  const succeeded = await get();
  assert.equal(succeeded.status, 200);
  assert.deepEqual(await succeeded.json(), [{ id: 'original-clip' }]);
  const failed = await store.run(request('failed'), async () => {
    throw { message: 'manual recovery required', statusCode: 409, code: 'SUNO_CAPTCHA_MANUAL_INTERVENTION', retryAfterSeconds: 30 };
  });
  const failedResponse = await GET({} as NextRequest, { params: { id: failed.request_id } });
  assert.equal(failedResponse.status, 409);
  assert.equal(failedResponse.headers.get('Retry-After'), '30');
  assert.deepEqual(await failedResponse.json(), {
    error: 'manual recovery required', code: 'SUNO_CAPTCHA_MANUAL_INTERVENTION', retry_after_seconds: 30
  });
  assert.equal((await GET({} as NextRequest, { params: { id: 'invalid' } })).status, 404);
});

test('independently compiled route modules share the pending store and submission context', async (t) => {
  const { store, directory } = fixture(t, { responseWaitMs: 5 });
  const state = globalThis as typeof globalThis & { __sunoGenerationJobStore?: SunoGenerationJobStore };
  const previous = state.__sunoGenerationJobStore;
  state.__sunoGenerationJobStore = store;
  t.after(() => { state.__sunoGenerationJobStore = previous; });
  const filename = path.join(process.cwd(), 'src/lib/sunoGenerationJobs.ts');
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  const loadBundle = () => {
    const compiledModule = { exports: {} };
    const execute = runInThisContext(`(function(require, module, exports) { ${compiled}\n })`);
    execute(createRequire(filename), compiledModule, compiledModule.exports);
    return compiledModule.exports as typeof import('./sunoGenerationJobs');
  };
  const firstBundle = loadBundle();
  const secondBundle = loadBundle();
  const generation = deferred<string[]>();
  let submissions = 0;
  const pending = await firstBundle.runSunoGenerationJob(request(), async (job) => {
    submissions++;
    assert.equal(secondBundle.getCurrentSunoGenerationJob()?.id, job.id);
    secondBundle.markSunoGenerationSubmitted();
    return generation.promise;
  });
  assert.deepEqual(secondBundle.getSunoGenerationJob(pending.request_id), pending);
  assert.equal(JSON.parse(readFileSync(path.join(directory, `${pending.request_id}.json`), 'utf8')).submissionState, 'unknown');
  const retry = secondBundle.runSunoGenerationJob(request(), async () => assert.fail('another bundle repeated generation'));
  generation.resolve(['original-clip']);
  assert.equal((await retry).status, 'succeeded');
  assert.equal(submissions, 1);
});
