import { Page, Request, Response } from 'playwright';

export const SUNO_GENERATE_URL_PART = '/api/generate/v2-web/';
const DEFAULT_CAPTURE_TIMEOUT_MS = 180_000;

export type SunoGeneratePayload = Record<string, unknown>;

export interface SunoGenerateClip extends Record<string, unknown> {
  id: string;
}

export interface CaptchaBrowserIdentity {
  userAgent: string;
  secChUa?: string;
  secChUaMobile?: string;
  secChUaPlatform?: string;
}

export interface CaptchaGenerationResult {
  clips: SunoGenerateClip[];
  authorizationToken?: string;
  browserIdentity: CaptchaBrowserIdentity;
}

interface PreparedCaptchaGenerateRequest {
  postData: string;
  authorizationToken?: string;
  browserIdentity: CaptchaBrowserIdentity;
}

interface CaptureLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface CaptchaGenerateCapture {
  result: Promise<CaptchaGenerationResult>;
  cancel(): void;
}

export class MissingCaptchaTokenError extends Error {
  constructor() {
    super('Suno generate request did not contain a captcha token');
    this.name = 'MissingCaptchaTokenError';
  }
}

export class InvalidCaptchaGenerateRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCaptchaGenerateRequestError';
  }
}

export class InvalidSunoGenerateResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSunoGenerateResponseError';
  }
}

export async function installCaptchaGenerateCapture(
  page: Page,
  actualPayload: SunoGeneratePayload,
  logger: CaptureLogger,
  timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS
): Promise<CaptchaGenerateCapture> {
  let resolveResult!: (result: CaptchaGenerationResult) => void;
  let rejectResult!: (error: unknown) => void;
  let settled = false;
  let generateSent = false;
  const result = new Promise<CaptchaGenerationResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    callback();
  };
  const timeout = setTimeout(() => {
    finish(() => rejectResult(new Error(
      'Timed out waiting for Suno browser generate response'
    )));
  }, timeoutMs);

  try {
    await page.route(`**${SUNO_GENERATE_URL_PART}**`, async (route) => {
      if (settled || generateSent) {
        await route.abort();
        return;
      }

      let prepared: PreparedCaptchaGenerateRequest;
      try {
        prepared = prepareCaptchaGenerateRequest(route.request(), actualPayload);
      } catch (error) {
        await route.abort();
        if (error instanceof MissingCaptchaTokenError) {
          logger.warn(`SunoCaptchaSolver: ${error.message}`);
          return;
        }
        finish(() => rejectResult(error));
        return;
      }

      generateSent = true;
      logger.info('SunoCaptchaSolver: sending tokenized Generate request in browser');
      try {
        await route.continue({ postData: prepared.postData });
        const response = await route.request().response();
        if (!response) {
          throw new InvalidSunoGenerateResponseError(
            'Suno browser Generate request completed without a response'
          );
        }
        const clips = await readSunoGenerateClips(response);
        logger.info(
          `SunoCaptchaSolver: browser Generate succeeded with status ` +
          `${response.status()} and ${clips.length} clips`
        );
        finish(() => resolveResult({
          clips,
          authorizationToken: prepared.authorizationToken,
          browserIdentity: prepared.browserIdentity
        }));
      } catch (error) {
        finish(() => rejectResult(error));
      }
    });
  } catch (error) {
    finish(() => undefined);
    throw error;
  }

  return {
    result,
    cancel: () => finish(() => undefined)
  };
}

export function prepareCaptchaGenerateRequest(
  request: Request,
  actualPayload: SunoGeneratePayload
): PreparedCaptchaGenerateRequest {
  const capturedPayload = request.postDataJSON() as unknown;
  if (!isRecord(capturedPayload) || !isNonEmptyString(capturedPayload.token)) {
    throw new MissingCaptchaTokenError();
  }
  if (!Object.hasOwn(capturedPayload, 'token_provider')) {
    throw new InvalidCaptchaGenerateRequestError(
      'Suno generate request did not contain token_provider'
    );
  }
  const tokenProvider = capturedPayload.token_provider;
  if (tokenProvider !== null && typeof tokenProvider !== 'number') {
    throw new InvalidCaptchaGenerateRequestError(
      'Suno generate request contained an invalid token_provider'
    );
  }

  const headers = request.headers();
  if (!isNonEmptyString(headers['browser-token'])) {
    throw new InvalidCaptchaGenerateRequestError(
      'Suno generate request did not contain browser-token'
    );
  }
  if (!isNonEmptyString(headers['user-agent'])) {
    throw new InvalidCaptchaGenerateRequestError(
      'Suno generate request did not contain a browser user-agent'
    );
  }

  const authorization = headers.authorization;
  return {
    postData: JSON.stringify({
      ...actualPayload,
      token: capturedPayload.token,
      token_provider: tokenProvider
    }),
    authorizationToken: authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined,
    browserIdentity: {
      userAgent: headers['user-agent'],
      secChUa: headers['sec-ch-ua'],
      secChUaMobile: headers['sec-ch-ua-mobile'],
      secChUaPlatform: headers['sec-ch-ua-platform']
    }
  };
}

export async function readSunoGenerateClips(
  response: Response
): Promise<SunoGenerateClip[]> {
  const status = response.status();
  const body = await response.json().catch(() => undefined) as unknown;
  return validateSunoGenerateClips(
    body,
    status,
    response.ok(),
    'Suno browser Generate request'
  );
}

export function validateSunoGenerateClips(
  body: unknown,
  status: number,
  ok: boolean,
  source: string
): SunoGenerateClip[] {
  if (!ok) {
    const detail = readErrorDetail(body);
    throw new InvalidSunoGenerateResponseError(
      `${source} failed with status ${status}` +
      (detail ? `: ${detail}` : '')
    );
  }
  if (!isRecord(body) || !Array.isArray(body.clips) || body.clips.length === 0) {
    throw new InvalidSunoGenerateResponseError(
      `${source} response ${status} did not contain clips`
    );
  }
  if (!body.clips.every((clip) => isRecord(clip) && isNonEmptyString(clip.id))) {
    throw new InvalidSunoGenerateResponseError(
      `${source} response ${status} contained an invalid clip`
    );
  }
  return body.clips as SunoGenerateClip[];
}

function readErrorDetail(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (isNonEmptyString(body.detail)) return body.detail;
  if (isNonEmptyString(body.detail_fallback)) return body.detail_fallback;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
