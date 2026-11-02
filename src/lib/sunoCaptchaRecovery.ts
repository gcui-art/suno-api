import { SunoCaptchaManualInterventionError } from './sunoCaptchaErrors';

interface CaptchaRecoveryOperations<T> {
  precheck(): Promise<string | null | undefined>;
  submit(token: string | null): Promise<T>;
  recover(): Promise<void>;
  manualRequired(cause?: unknown): Promise<SunoCaptchaManualInterventionError>;
  /** Optional same-account fallback when an explicit captcha rejection occurs. */
  fallback?(cause?: unknown): Promise<T>;
  enabled?: boolean;
}

/** Only explicit captcha rejections prove that replaying a generation is safe. */
export function isSunoCaptchaRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const response = (error as { response?: { status?: number; data?: unknown } }).response;
  if (!response || ![400, 403, 422].includes(response.status ?? 0)) return false;
  const body = response.data;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const fields = body as Record<string, unknown>;
  return [fields.code, fields.error, fields.detail, fields.detail_fallback, fields.message]
    .some((value) => typeof value === 'string' && /\b(?:hcaptcha|captcha|turnstile)\b/i.test(value.replace(/_/g, ' ')));
}

export async function submitWithCaptchaRecovery<T>(
  operations: CaptchaRecoveryOperations<T>
): Promise<T> {
  let recovered = false;
  while (true) {
    let captchaCause: unknown;
    try {
      const token = await operations.precheck();
      if (token !== undefined) return await operations.submit(token);
    } catch (error) {
      if (!isSunoCaptchaRejection(error)) throw error;
      captchaCause = error;
    }

    let fallbackFailure: unknown;
    let replaySafe = true;
    if (operations.fallback) {
      try { return await operations.fallback(captchaCause); }
      catch (error) {
        if (['SUNO_GENERATION_TIMEOUT', 'SUNO_BROWSER_RECOVERY_CAPACITY'].includes(String((error as any)?.code)) ||
          (error as any)?.name === 'AbortError') throw error;
        fallbackFailure = error;
        replaySafe = (error as { browserReplaySafe?: boolean })?.browserReplaySafe === true || isSunoCaptchaRejection(error);
      }
    }
    if (recovered || operations.enabled === false) {
      throw await operations.manualRequired(fallbackFailure ?? captchaCause);
    }
    recovered = true;
    try {
      await operations.recover();
    } catch (error) {
      if (error && typeof error === 'object' &&
        ['SUNO_BROWSER_RECOVERY_CAPACITY', 'SUNO_LOCAL_RECOVERY_REQUIRED', 'SUNO_GENERATION_TIMEOUT']
          .includes(String((error as { code?: unknown }).code))) throw error;
      throw await operations.manualRequired(error);
    }
    // A local warmup cannot prove that an earlier browser POST failed.
    if (!replaySafe) throw fallbackFailure;
  }
}
