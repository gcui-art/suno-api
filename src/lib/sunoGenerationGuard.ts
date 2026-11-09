import { setTimeout as delay } from 'node:timers/promises';

interface AccountGenerationState {
  tail: Promise<void>;
  nextAllowedAt: number;
}

const globalState = global as unknown as {
  sunoGenerationStates?: Map<string, AccountGenerationState>;
};
const states = globalState.sunoGenerationStates ?? new Map<string, AccountGenerationState>();
globalState.sunoGenerationStates = states;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function generationMinIntervalMs(): number {
  return positiveInteger(process.env.SUNO_GENERATION_MIN_INTERVAL_MS, 15_000);
}

function stateFor(accountId: string): AccountGenerationState {
  let state = states.get(accountId);
  if (!state) {
    state = { tail: Promise.resolve(), nextAllowedAt: 0 };
    states.set(accountId, state);
  }
  return state;
}

export async function runAccountGeneration<T>(
  accountId: string,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  const state = stateFor(accountId);
  const previous = state.tail.catch(() => undefined);
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  state.tail = previous.then(() => current);

  let started = false;
  try {
    await waitForPreviousGeneration(previous, signal);
    signal?.throwIfAborted();
    const delayMs = Math.max(0, state.nextAllowedAt - Date.now());
    if (delayMs > 0) {
      try {
        await delay(delayMs, undefined, { signal });
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
    }
    signal?.throwIfAborted();
    state.nextAllowedAt = Date.now() + generationMinIntervalMs();
    started = true;
    return await operation();
  } finally {
    if (started) state.nextAllowedAt = Date.now() + generationMinIntervalMs();
    // An aborted queued slot can resolve now: its tail still waits for previous,
    // so later callers cannot pass an operation that is already running.
    release();
  }
}

function waitForPreviousGeneration(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}
