import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import { retryAfterSeconds } from './sunoRateLimit';

const RESULT_TTL_MS = 24 * 60 * 60 * 1_000;
const OPERATION_TIMEOUT_MS = 10 * 60 * 1_000;
const RESPONSE_WAIT_MS = 85_000;
const MAX_JOBS = 1_000;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface StoredGenerationError {
  message: string;
  statusCode: number;
  code?: string;
  retryAfterSeconds?: number;
  response?: { data: { detail: unknown } };
}

type SubmissionState = 'not_submitted' | 'unknown' | 'accepted';
type JobStatus = 'pending' | 'succeeded' | 'failed' | 'interrupted';

interface GenerationJobRecord {
  version: 1;
  id: string;
  namespace: string;
  keyHash?: string;
  fingerprint: string;
  body: Record<string, unknown>;
  accountId?: string;
  transactionUuid: string;
  createdAt: number;
  deadline: number;
  finishedAt?: number;
  status: JobStatus;
  submissionState: SubmissionState;
  clipIds?: string[];
  result?: unknown;
  error?: StoredGenerationError;
}

export interface SunoGenerationJob {
  id: string;
  accountId: string;
  body: Record<string, unknown>;
  transactionUuid: string;
  deadline: number;
  signal: AbortSignal;
}

interface GenerationJobContext extends SunoGenerationJob {
  checkpoint(state: SubmissionState, clipIds?: string[]): void;
}

export type SunoGenerationJobOutcome = {
  status: 'pending';
  request_id: string;
  status_url: string;
  retry_after_seconds: number;
} | {
  status: 'succeeded';
  request_id: string;
  result: unknown;
} | {
  status: 'failed' | 'interrupted';
  request_id: string;
  error: StoredGenerationError;
};

interface StartGenerationJob {
  namespace: string;
  idempotencyKey: string | null;
  body: Record<string, unknown>;
  respondAsync?: boolean;
  selectAccount(): Promise<string>;
}

interface GenerationJobStoreOptions {
  directory: string;
  maxJobs?: number;
  ttlMs?: number;
  operationTimeoutMs?: number;
  responseWaitMs?: number;
}

const processState = globalThis as typeof globalThis & {
  __sunoGenerationJobContext?: AsyncLocalStorage<GenerationJobContext>;
  __sunoGenerationJobStore?: SunoGenerationJobStore;
};
const context = processState.__sunoGenerationJobContext ??= new AsyncLocalStorage<GenerationJobContext>();

export function prefersAsyncGeneration(prefer: string | null): boolean {
  return Boolean(prefer?.split(',').some((preference) =>
    preference.split(';', 1)[0].trim().toLowerCase() === 'respond-async'
  ));
}

export function getCurrentSunoGenerationJob(): SunoGenerationJob | undefined {
  return context.getStore();
}

/** Persist uncertainty before the upstream POST, never after sending it. */
export function markSunoGenerationSubmitted(): void {
  context.getStore()?.checkpoint('unknown');
}

/** Use only when the upstream explicitly rejected the generation. */
export function markSunoGenerationRejected(): void {
  context.getStore()?.checkpoint('not_submitted');
}

export function markSunoGenerationAccepted(clipIds: string[]): void {
  context.getStore()?.checkpoint('accepted', clipIds);
}

function errorWithCode(message: string, statusCode: number, code: string, retryAfter?: number): StoredGenerationError {
  return { message, statusCode, code, ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }) };
}

function serializeError(error: unknown): StoredGenerationError {
  const value = error as {
    message?: unknown;
    statusCode?: number;
    code?: unknown;
    retryAfterSeconds?: number;
    response?: { status?: number; data?: { detail?: unknown }; headers?: unknown };
  } | null;
  const status = value?.statusCode || value?.response?.status || 500;
  const detail = value?.response?.data?.detail;
  const retryAfter = value?.retryAfterSeconds ?? (status === 429 ? retryAfterSeconds(value?.response?.headers) : undefined);
  return {
    message: String(value?.message || error),
    statusCode: status,
    ...(typeof value?.code === 'string' ? { code: value.code } : {}),
    ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    ...(detail === undefined ? {} : { response: { data: { detail: JSON.parse(JSON.stringify(detail)) } } })
  };
}

function canonicalJson(value: unknown): string {
  function sorted(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sorted);
    if (item !== null && typeof item === 'object') {
      const object = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sorted(object[key])]));
    }
    return item;
  }
  return JSON.stringify(sorted(value));
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class SunoGenerationJobStore {
  private readonly jobs = new Map<string, GenerationJobRecord>();
  private readonly keys = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly maxJobs: number;
  private readonly ttlMs: number;
  private readonly operationTimeoutMs: number;
  private readonly responseWaitMs: number;

  constructor(private readonly options: GenerationJobStoreOptions) {
    this.maxJobs = options.maxJobs ?? MAX_JOBS;
    this.ttlMs = options.ttlMs ?? RESULT_TTL_MS;
    this.operationTimeoutMs = options.operationTimeoutMs ?? OPERATION_TIMEOUT_MS;
    this.responseWaitMs = options.responseWaitMs ?? RESPONSE_WAIT_MS;
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    chmodSync(options.directory, 0o700);
    for (const filename of readdirSync(options.directory)) {
      if (!filename.endsWith('.json')) continue;
      const record = JSON.parse(readFileSync(path.join(options.directory, filename), 'utf8')) as GenerationJobRecord;
      if (record.version !== 1 || !REQUEST_ID_PATTERN.test(record.id) || filename !== `${record.id}.json` ||
        !['pending', 'succeeded', 'failed', 'interrupted'].includes(record.status) || !Number.isFinite(record.createdAt)) {
        throw new Error(`Invalid generation job record: ${filename}`);
      }
      if (record.status === 'pending') {
        record.status = 'interrupted';
        record.finishedAt = Date.now();
        record.error = record.submissionState === 'not_submitted'
          ? errorWithCode('Generation was interrupted before submission; it was not automatically retried', 503, 'SUNO_GENERATION_INTERRUPTED')
          : errorWithCode('Generation was interrupted after submission; the upstream result may exist and was not replayed', 503, 'SUNO_GENERATION_RESULT_UNKNOWN');
        this.persist(record);
      }
      this.jobs.set(record.id, record);
      if (record.keyHash) this.keys.set(record.keyHash, record.id);
    }
    this.cleanup();
  }

  async run(
    request: StartGenerationJob,
    operation: (job: SunoGenerationJob) => Promise<unknown>
  ): Promise<SunoGenerationJobOutcome> {
    this.cleanup();
    const fingerprint = hash(canonicalJson(request.body));
    const keyHash = request.idempotencyKey ? hash(JSON.stringify([request.namespace, request.idempotencyKey])) : undefined;
    const existingId = keyHash ? this.keys.get(keyHash) : undefined;
    if (existingId) {
      const existing = this.jobs.get(existingId)!;
      if (existing.fingerprint !== fingerprint) {
        throw errorWithCode('Idempotency-Key was already used with a different request body', 409, 'SUNO_IDEMPOTENCY_KEY_CONFLICT');
      }
      return this.waitForResponse(existing, request.respondAsync);
    }
    if (this.jobs.size >= this.maxJobs) {
      throw errorWithCode('Generation job capacity reached; retry with the same Idempotency-Key', 503, 'SUNO_GENERATION_JOB_CAPACITY', 30);
    }

    const createdAt = Date.now();
    const requestedUuid = request.body?.transaction_uuid;
    const record: GenerationJobRecord = {
      version: 1,
      id: randomUUID(),
      namespace: request.namespace,
      keyHash,
      fingerprint,
      body: JSON.parse(JSON.stringify(request.body)),
      transactionUuid: typeof requestedUuid === 'string' && requestedUuid ? requestedUuid : randomUUID(),
      createdAt,
      deadline: createdAt + this.operationTimeoutMs,
      status: 'pending',
      submissionState: 'not_submitted'
    };
    this.persist(record);
    this.jobs.set(record.id, record);
    if (keyHash) this.keys.set(keyHash, record.id);
    const running = this.execute(record, request.selectAccount, operation);
    this.inflight.set(record.id, running);
    void running.finally(() => this.inflight.delete(record.id)).catch(() => undefined);
    return this.waitForResponse(record, request.respondAsync);
  }

  get(id: string): SunoGenerationJobOutcome | undefined {
    if (!REQUEST_ID_PATTERN.test(id)) return undefined;
    this.cleanup();
    const record = this.jobs.get(id);
    return record ? this.outcome(record) : undefined;
  }

  private async execute(
    record: GenerationJobRecord,
    selectAccount: () => Promise<string>,
    operation: (job: SunoGenerationJob) => Promise<unknown>
  ): Promise<void> {
    const controller = new AbortController();
    let timeout!: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = errorWithCode('Generation exceeded its deadline and will not be retried automatically', 504, 'SUNO_GENERATION_TIMEOUT');
        controller.abort(error);
        reject(error);
      }, Math.max(0, record.deadline - Date.now()));
    });
    const work = (async () => {
      record.accountId = await selectAccount();
      controller.signal.throwIfAborted();
      if (!record.accountId) throw new Error('No Suno account is available');
      this.persist(record);
      const job: GenerationJobContext = {
        id: record.id,
        accountId: record.accountId,
        body: JSON.parse(JSON.stringify(record.body)),
        transactionUuid: record.transactionUuid,
        deadline: record.deadline,
        signal: controller.signal,
        checkpoint: (state, clipIds) => {
          controller.signal.throwIfAborted();
          if (Date.now() >= record.deadline) throw errorWithCode('Generation deadline has expired', 504, 'SUNO_GENERATION_TIMEOUT');
          record.submissionState = state;
          if (clipIds) record.clipIds = [...clipIds];
          this.persist(record);
        }
      };
      return context.run(job, () => operation(job));
    })();
    try {
      const result = await Promise.race([work, timedOut]);
      record.result = JSON.parse(JSON.stringify(result));
      record.status = 'succeeded';
    } catch (error) {
      record.status = 'failed';
      record.error = serializeError(error);
    } finally {
      clearTimeout(timeout);
      record.finishedAt = Date.now();
      try {
        this.persist(record);
      } catch {
        // Keep the key in memory and the previous on-disk submission checkpoint.
        record.status = 'failed';
        record.error = errorWithCode('Generation result could not be persisted; do not resubmit with a new key', 503, 'SUNO_GENERATION_STORAGE_FAILED');
      }
    }
  }

  private async waitForResponse(record: GenerationJobRecord, respondAsync = false): Promise<SunoGenerationJobOutcome> {
    const running = this.inflight.get(record.id);
    if (record.status === 'pending' && running && !respondAsync) {
      await running;
    } else if (record.status === 'pending' && running && this.responseWaitMs > 0) {
      let timeout!: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([running, new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, this.responseWaitMs);
        })]);
      } finally {
        clearTimeout(timeout);
      }
    }
    return this.outcome(record);
  }

  private outcome(record: GenerationJobRecord): SunoGenerationJobOutcome {
    if (record.status === 'pending') {
      return {
        status: 'pending',
        request_id: record.id,
        status_url: `/api/generation-requests/${record.id}`,
        retry_after_seconds: 3
      };
    }
    if (record.status === 'succeeded') return { status: 'succeeded', request_id: record.id, result: record.result };
    return { status: record.status, request_id: record.id, error: record.error! };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, record] of this.jobs) {
      if (record.status === 'pending' || this.inflight.has(id) || (record.finishedAt ?? record.createdAt) + this.ttlMs > now) continue;
      unlinkSync(path.join(this.options.directory, `${id}.json`));
      this.jobs.delete(id);
      if (record.keyHash) this.keys.delete(record.keyHash);
    }
  }

  private persist(record: GenerationJobRecord): void {
    const filename = path.join(this.options.directory, `${record.id}.json`);
    const temporary = path.join(this.options.directory, `${record.id}.${randomUUID()}.tmp`);
    try {
      const descriptor = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(record));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, filename);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

function defaultStore(): SunoGenerationJobStore {
  return processState.__sunoGenerationJobStore ??= new SunoGenerationJobStore({
    directory: process.env.SUNO_GENERATION_JOBS_DIR || path.join(process.cwd(), 'data', 'generation-jobs')
  });
}

export function runSunoGenerationJob(
  request: StartGenerationJob,
  operation: (job: SunoGenerationJob) => Promise<unknown>
): Promise<SunoGenerationJobOutcome> {
  return defaultStore().run(request, operation);
}

export function getSunoGenerationJob(id: string): SunoGenerationJobOutcome | undefined {
  return defaultStore().get(id);
}
