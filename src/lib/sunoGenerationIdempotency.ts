import { createHash } from 'node:crypto';

const SUCCESS_TTL_MS = 10 * 60 * 1_000;
const MAX_REQUESTS = 1_000;

interface GenerationRequest {
  fingerprint: string;
  promise: Promise<unknown>;
  expiresAt?: number;
}

const globalState = global as unknown as {
  sunoGenerationRequests?: Map<string, GenerationRequest>;
};
const requests = globalState.sunoGenerationRequests ?? new Map<string, GenerationRequest>();
globalState.sunoGenerationRequests = requests;

export class SunoIdempotencyConflictError extends Error {
  public readonly statusCode = 409;
  public readonly code = 'SUNO_IDEMPOTENCY_KEY_CONFLICT';

  constructor() {
    super('Idempotency-Key was already used with a different request body');
    this.name = 'SunoIdempotencyConflictError';
  }
}

export class SunoIdempotencyCapacityError extends Error {
  public readonly statusCode = 503;
  public readonly code = 'SUNO_IDEMPOTENCY_CAPACITY';
  public readonly retryAfterSeconds = 30;

  constructor() {
    super('Generation request cache is full; retry with the same Idempotency-Key');
    this.name = 'SunoIdempotencyCapacityError';
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sortJson(object[key])]));
  }
  return value;
}

export function runIdempotentGeneration<T>(
  namespace: string,
  idempotencyKey: string | null,
  body: unknown,
  operation: () => Promise<T>
): Promise<T> {
  if (!idempotencyKey) return operation();

  const now = Date.now();
  for (const [key, entry] of requests) {
    if (entry.expiresAt !== undefined && entry.expiresAt <= now) requests.delete(key);
  }

  const key = createHash('sha256').update(JSON.stringify([namespace, idempotencyKey])).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify(sortJson(body))).digest('hex');
  const existing = requests.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) return Promise.reject(new SunoIdempotencyConflictError());
    return existing.promise as Promise<T>;
  }
  if (requests.size >= MAX_REQUESTS) return Promise.reject(new SunoIdempotencyCapacityError());

  // Register before starting work, and keep in-flight requests until they settle.
  const entry: GenerationRequest = {
    fingerprint,
    promise: Promise.resolve().then(operation).then(
      (result) => {
        entry.expiresAt = Date.now() + SUCCESS_TTL_MS;
        return result;
      },
      (error) => {
        requests.delete(key);
        throw error;
      }
    )
  };
  requests.set(key, entry);
  return entry.promise as Promise<T>;
}
