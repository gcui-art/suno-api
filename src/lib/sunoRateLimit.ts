interface RetryableRequestConfig {
  method?: string;
  url?: string;
  data?: unknown;
}

interface StatusRequestState {
  tail: Promise<void>;
  nextAllowedAt: number;
}

const globalRateLimit = global as unknown as {
  sunoStatusRequestStates?: Map<string, StatusRequestState>;
};
const statusRequestStates = globalRateLimit.sunoStatusRequestStates ?? new Map<string, StatusRequestState>();
globalRateLimit.sunoStatusRequestStates = statusRequestStates;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function suno429MaxRetries(): number {
  return positiveInteger(process.env.SUNO_429_MAX_RETRIES, 3);
}

export function sunoStatusMinIntervalMs(): number {
  return positiveInteger(process.env.SUNO_STATUS_MIN_INTERVAL_MS, 2_500);
}

/** Serialize feed polling per account so many clients cannot create a burst. */
export async function runSunoStatusRequest<T>(
  accountId: string,
  operation: () => Promise<T>
): Promise<T> {
  let state = statusRequestStates.get(accountId);
  if (!state) {
    state = { tail: Promise.resolve(), nextAllowedAt: 0 };
    statusRequestStates.set(accountId, state);
  }

  const previous = state.tail.catch(() => undefined);
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  state.tail = previous.then(() => current);

  await previous;
  try {
    const delayMs = Math.max(0, state.nextAllowedAt - Date.now());
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    state.nextAllowedAt = Date.now() + sunoStatusMinIntervalMs();
    return await operation();
  } finally {
    release();
  }
}

function requestPayload(data: unknown): Record<string, unknown> | undefined {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  if (typeof data !== 'string') return undefined;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Generation retries are safe only when Suno can deduplicate the request by
 * transaction UUID. Captcha pre-checks and reads do not create user content.
 */
export function isRetryableSunoRequest(config: RetryableRequestConfig): boolean {
  const method = (config.method ?? '').toLowerCase();
  if (method === 'get' || method === 'head' || method === 'options') return true;
  if (method !== 'post') return false;

  let pathname = '';
  try {
    pathname = new URL(config.url ?? '', 'https://studio-api-prod.suno.com').pathname;
  } catch {
    return false;
  }
  if (pathname === '/api/c/check') return true;
  if (pathname === '/api/feed/v3') return true;
  if (pathname !== '/api/generate/v2-web/') return false;
  const transactionUuid = requestPayload(config.data)?.transaction_uuid;
  return typeof transactionUuid === 'string' && transactionUuid.length > 0;
}

export function retryAfterSeconds(headers: unknown, now = Date.now()): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const values = headers as Record<string, unknown>;
  const raw = values['retry-after'] ?? values['Retry-After'];
  if (raw === undefined || raw === null) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const timestamp = Date.parse(String(raw));
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, Math.ceil((timestamp - now) / 1_000));
}

export function suno429DelayMs(
  retryNumber: number,
  headers?: unknown,
  random = Math.random
): number {
  const baseMs = positiveInteger(process.env.SUNO_429_BASE_DELAY_MS, 2_000);
  const maxMs = positiveInteger(process.env.SUNO_429_MAX_DELAY_MS, 20_000);
  const retryAfterMs = retryAfterSeconds(headers);
  const exponentialMs = baseMs * Math.pow(2, Math.max(0, retryNumber - 1));
  const requestedMs = retryAfterMs === undefined ? exponentialMs : retryAfterMs * 1_000;
  return Math.min(maxMs, requestedMs) + Math.floor(random() * Math.min(1_000, baseMs));
}
