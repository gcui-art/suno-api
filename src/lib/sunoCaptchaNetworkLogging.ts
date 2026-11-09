import { BrowserContext, Page, Request, Response } from 'playwright';
import { sanitizeDiagnosticUrl } from './captchaDiagnosticSanitizer';

interface CaptchaNetworkLogger {
  info(message: string): void;
  warn(message: string): void;
}

const CAPTCHA_URL_PARTS = [
  'challenges.cloudflare.com',
  'hcaptcha.com',
  'hcaptcha-endpoint-prod.suno.com',
  'hcaptcha-assets-prod.suno.com',
  'hcaptcha-imgs-prod.suno.com',
  'hcaptcha-reportapi-prod.suno.com',
  'checksiteconfig',
  '/getcaptcha/',
  '/checkcaptcha/',
  '/siteverify'
];

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com/';
const TURNSTILE_BODY_RESOURCE_TYPES = new Set(['fetch', 'xhr']);

export interface CaptchaNetworkEvent {
  timestamp: string;
  type: 'request' | 'response' | 'requestfailed' | 'frame-navigated';
  url: string;
  method?: string;
  resourceType?: string;
  status?: number;
  failure?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  parentUrl?: string;
}

export function isGenerateRequestUrl(url: string, generateUrlPart: string): boolean {
  return url.includes(generateUrlPart);
}

function isHcaptchaRequestUrl(url: string): boolean {
  return CAPTCHA_URL_PARTS.some((part) => url.includes(part));
}

function isCaptchaDiagnosticUrl(url: string, generateUrlPart: string): boolean {
  return isGenerateRequestUrl(url, generateUrlPart) || isHcaptchaRequestUrl(url);
}

export function attachCaptchaNetworkLogging(
  context: BrowserContext,
  generateUrlPart: string,
  logger: CaptchaNetworkLogger,
  events: CaptchaNetworkEvent[] = []
): void {
  context.on('request', (request) => {
    if (!isCaptchaDiagnosticUrl(request.url(), generateUrlPart)) {
      return;
    }
    events.push(createRequestEvent(request));
    logger.info(`SunoCaptchaSolver request: ${formatRequest(request)}`);
  });

  context.on('response', (response) => {
    if (!isCaptchaDiagnosticUrl(response.url(), generateUrlPart)) {
      return;
    }
    const event = createResponseEvent(response);
    events.push(event);
    logger.info(
      `SunoCaptchaSolver response: ${response.status()} ${response.request().resourceType()} ` +
      sanitizeDiagnosticUrl(response.url())
    );
    if (isTurnstileResponseBody(response)) {
      void captureTurnstileResponseDetails(response, event, logger);
    }
  });

  context.on('requestfailed', (request) => {
    if (!isCaptchaDiagnosticUrl(request.url(), generateUrlPart)) {
      return;
    }
    events.push(createRequestFailedEvent(request));
    logger.warn(`SunoCaptchaSolver request failed: ${formatRequestFailure(request)}`);
  });

  const attachFrameLogging = (page: Page) => {
    page.on('framenavigated', (frame) => {
      if (!isTurnstileUrl(frame.url())) return;
      const parentFrame = frame.parentFrame();
      const event: CaptchaNetworkEvent = {
        timestamp: new Date().toISOString(),
        type: 'frame-navigated',
        url: sanitizeDiagnosticUrl(frame.url()),
        parentUrl: parentFrame
          ? sanitizeDiagnosticUrl(parentFrame.url())
          : undefined
      };
      events.push(event);
      logger.info(`SunoCaptchaSolver Turnstile frame navigated: ${event.url}`);
    });
  };
  context.pages().forEach(attachFrameLogging);
  context.on('page', attachFrameLogging);
}

export async function startCaptchaRequestLoggingAfterClick(
  page: Page,
  generateUrlPart: string,
  logger: CaptchaNetworkLogger,
  click: () => Promise<void>
): Promise<void> {
  const onRequest = (request: Request) => {
    if (!isCaptchaDiagnosticUrl(request.url(), generateUrlPart)) {
      return;
    }
    logger.info(`SunoCaptchaSolver after-click request: ${formatRequest(request)}`);
  };
  const onResponse = (response: import('playwright').Response) => {
    if (!isCaptchaDiagnosticUrl(response.url(), generateUrlPart)) {
      return;
    }
    logger.info(
      `SunoCaptchaSolver after-click response: ${response.status()} ${response.request().resourceType()} ` +
      sanitizeDiagnosticUrl(response.url())
    );
  };
  const onRequestFailed = (request: Request) => {
    if (!isCaptchaDiagnosticUrl(request.url(), generateUrlPart)) {
      return;
    }
    logger.warn(`SunoCaptchaSolver after-click request failed: ${formatRequestFailure(request)}`);
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  await click();
  page.waitForTimeout(15_000).finally(() => {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
  });
}

function formatRequest(request: Request): string {
  return `${request.method()} ${request.resourceType()} ${sanitizeDiagnosticUrl(request.url())}`;
}

function formatRequestFailure(request: Request): string {
  return `${formatRequest(request)} ${request.failure()?.errorText ?? ''}`;
}

function createRequestEvent(request: Request): CaptchaNetworkEvent {
  return {
    timestamp: new Date().toISOString(),
    type: 'request',
    method: request.method(),
    resourceType: request.resourceType(),
    url: sanitizeDiagnosticUrl(request.url())
  };
}

function createResponseEvent(response: Response): CaptchaNetworkEvent {
  return {
    timestamp: new Date().toISOString(),
    type: 'response',
    status: response.status(),
    resourceType: response.request().resourceType(),
    url: sanitizeDiagnosticUrl(response.url())
  };
}

function createRequestFailedEvent(request: Request): CaptchaNetworkEvent {
  return {
    ...createRequestEvent(request),
    type: 'requestfailed',
    failure: request.failure()?.errorText
  };
}

function isTurnstileUrl(url: string): boolean {
  return url.startsWith(TURNSTILE_ORIGIN);
}

function isTurnstileResponseBody(response: Response): boolean {
  return isTurnstileUrl(response.url()) &&
    TURNSTILE_BODY_RESOURCE_TYPES.has(response.request().resourceType());
}

async function captureTurnstileResponseDetails(
  response: Response,
  event: CaptchaNetworkEvent,
  logger: CaptchaNetworkLogger
): Promise<void> {
  try {
    const headers = await response.allHeaders();
    event.responseHeaders = selectDiagnosticHeaders(headers);
    event.responseBody = await response.text();
  } catch (error) {
    logger.warn(
      `SunoCaptchaSolver failed to read Turnstile response body: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function selectDiagnosticHeaders(headers: Record<string, string>): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of ['content-type', 'content-length', 'cf-ray', 'server']) {
    if (headers[name] !== undefined) selected[name] = headers[name];
  }
  return selected;
}
