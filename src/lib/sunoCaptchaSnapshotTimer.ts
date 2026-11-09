const CAPTCHA_SNAPSHOT_DELAY_MS = 20_000;

export async function saveCaptchaSnapshotAfterDelay(
  signal: AbortSignal,
  onElapsed: () => Promise<unknown>
): Promise<void> {
  const elapsed = await waitForDelay(CAPTCHA_SNAPSHOT_DELAY_MS, signal);
  if (elapsed) await onElapsed();
}

export function waitForDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish(true), delayMs);
    const onAbort = () => finish(false);
    const finish = (elapsed: boolean) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve(elapsed);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
