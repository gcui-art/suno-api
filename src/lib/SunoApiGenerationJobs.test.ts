import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { AxiosError, AxiosHeaders, type AxiosAdapter, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { SunoApi } from './SunoApi';
import { SunoGenerationJobStore } from './sunoGenerationJobs';
import { SunoLocalRecoveryStore } from './sunoLocalRecovery';

async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function fixture(t: TestContext, operationTimeoutMs = 5_000) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'suno-api-jobs-test-'));
  const accountId = randomUUID();
  const api = new SunoApi('', accountId);
  t.mock.method(api, 'keepAlive', async () => undefined);
  t.mock.method(api, 'refreshAuth', async () => undefined);
  const internal = api as unknown as {
    client: AxiosInstance;
    submitGenerateRequest(payload: Record<string, unknown>): Promise<Array<{ id: string }>>;
  };
  const jobs = new SunoGenerationJobStore({ directory, operationTimeoutMs, responseWaitMs: 0 });
  const recovery = new SunoLocalRecoveryStore({ directory: path.join(directory, 'recovery'), browserHandle: 'test-account' });
  const state = globalThis as typeof globalThis & { __sunoLocalRecoveryStores?: Map<string, SunoLocalRecoveryStore> };
  const previousStores = state.__sunoLocalRecoveryStores;
  state.__sunoLocalRecoveryStores = new Map([[path.resolve(process.cwd(), 'data', 'captcha-recoveries'), recovery]]);
  const previousInterval = process.env.SUNO_GENERATION_MIN_INTERVAL_MS;
  process.env.SUNO_GENERATION_MIN_INTERVAL_MS = '1';
  t.after(() => {
    recovery.dispose();
    state.__sunoLocalRecoveryStores = previousStores;
    if (previousInterval === undefined) delete process.env.SUNO_GENERATION_MIN_INTERVAL_MS;
    else process.env.SUNO_GENERATION_MIN_INTERVAL_MS = previousInterval;
    rmSync(directory, { recursive: true, force: true });
  });
  const body = { prompt: 'original lyrics', metadata: { control_sliders: { style_weight: 0.7 } } };
  const input = { namespace: 'generate', idempotencyKey: 'original-key', body, respondAsync: true, selectAccount: async () => accountId };
  const run = async () => {
    const outcome = await jobs.run(input, (job) => internal.submitGenerateRequest({ ...job.body, transaction_uuid: job.transactionUuid }));
    if (outcome.status !== 'pending') return outcome;
    return waitFor(() => {
      const current = jobs.get(outcome.request_id);
      return current?.status === 'pending' ? undefined : current;
    }, `generation task ${outcome.request_id} to finish`);
  };
  return { jobs, recovery, internal, directory, run };
}

function reply(config: InternalAxiosRequestConfig, data: unknown) {
  return { config, data, status: 200, statusText: 'OK', headers: new AxiosHeaders() };
}

function reject(config: InternalAxiosRequestConfig, status: number, detail: string): never {
  throw new AxiosError(detail, 'ERR_BAD_REQUEST', config, undefined, {
    config, status, statusText: 'Rejected', data: { detail }, headers: new AxiosHeaders({ 'retry-after': '1' })
  });
}

test('actual Axios generation 429 is returned once and its job key cannot trigger another POST', async (t) => {
  const { internal, run } = fixture(t);
  let generations = 0;
  const adapter: AxiosAdapter = async (config) => {
    if (config.url?.endsWith('/api/c/check')) return reply(config, { required: false });
    generations++;
    assert.equal((config as unknown as { skipSuno429Retry: boolean }).skipSuno429Retry, true);
    return reject(config, 429, 'Too many requests');
  };
  internal.client.defaults.adapter = adapter;
  const outcome = await run();
  assert.equal(outcome.status, 'failed');
  if (outcome.status !== 'failed') assert.fail();
  assert.equal(outcome.error.statusCode, 429);
  assert.deepEqual(await run(), outcome);
  assert.equal(generations, 1);
});

test('actual captcha rejection resumes once with original body and transaction after a local event', async (t) => {
  const { internal, recovery, directory, run } = fixture(t);
  const payloads: Array<Record<string, unknown>> = [];
  internal.client.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/api/c/check')) return reply(config, { required: false });
    payloads.push(JSON.parse(config.data));
    if (payloads.length === 1) return reject(config, 403, 'Captcha verification required');
    return reply(config, { clips: [{ id: 'original-clip' }] });
  };
  const waiting = run();
  const event = await waitFor(() => recovery.list()[0], 'local recovery event');
  const claimed = recovery.claim(event.id, 'local-test-worker');
  recovery.complete(event.id, claimed.leaseToken, [randomUUID()]);
  const result = await waiting;
  assert.equal(result.status, 'succeeded');
  if (result.status !== 'succeeded') assert.fail();
  assert.deepEqual(result.result, [{ id: 'original-clip' }]);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0], payloads[1]);
  assert.equal(payloads[1].prompt, 'original lyrics');
  const record = JSON.parse(readFileSync(path.join(directory, `${result.request_id}.json`), 'utf8'));
  assert.equal(payloads[1].transaction_uuid, record.transactionUuid);
  assert.equal(record.submissionState, 'accepted');
  assert.deepEqual(record.clipIds, ['original-clip']);
});

test('job deadline expires a claimed local event and a late completion cannot submit', async (t) => {
  const { internal, recovery, run } = fixture(t, 1_000);
  let generations = 0;
  internal.client.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/api/c/check')) return reply(config, { required: true });
    generations++;
    return reply(config, { clips: [{ id: 'unexpected' }] });
  };
  const waiting = run();
  const event = await waitFor(() => recovery.list()[0], 'local recovery event');
  const claimed = recovery.claim(event.id, 'local-test-worker');
  const result = await waiting;
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') assert.fail();
  assert.equal(result.error.code, 'SUNO_GENERATION_TIMEOUT');
  assert.throws(() => recovery.complete(claimed.id, claimed.leaseToken, [randomUUID()]), { statusCode: 410 });
  assert.equal(generations, 0);
  assert.deepEqual(await run(), result);
});

test('precheck finishing after the task deadline cannot start a generation POST', async (t) => {
  const { internal, run } = fixture(t, 1_000);
  let finishPrecheck!: () => void;
  let generations = 0;
  internal.client.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/api/c/check')) {
      await new Promise<void>((resolve) => { finishPrecheck = resolve; });
      return reply(config, { required: false });
    }
    generations++;
    return reply(config, { clips: [{ id: 'unexpected' }] });
  };
  const result = await run();
  assert.equal(result.status, 'failed');
  finishPrecheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(generations, 0);
});
