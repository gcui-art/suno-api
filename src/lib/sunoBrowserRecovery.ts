import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Cookie, type Page, type Route } from 'playwright';
import { createMatchingChromiumUserAgent } from './browserFingerprint';
import { applySunoSessionToken } from './sunoAuthCookies';
import { sunoEgressBrowserProxy } from './sunoEgress';
import { SunoCaptchaManualInterventionError } from './sunoCaptchaErrors';
import {
  type CaptchaBrowserIdentity,
  type SunoGenerateClip,
  readSunoGenerateClips,
} from './sunoCaptchaGenerateCapture';
import { CREATE_SONG_BUTTON_SELECTOR, PROMPT_TEXTAREA_SELECTOR } from './sunoCreateSelectors';
import { closeKnownPopups } from './sunoPopupHandler';

const SUNO_GENERATE_URL = 'https://studio-api-prod.suno.com/api/generate/v2-web/';
const INVALID_COOKIE_RE = /[\x00-\x1f\x7f;,\"]/;
const DEFAULT_TIMEOUT_MS = 65_000;
const CLOSE_TIMEOUT_MS = 5_000;
const RECOVERY_PROMPT = 'A short peaceful instrumental piano melody';
const processState = globalThis as typeof globalThis & {
  __sunoBrowserRecovery?: { active: number };
};
const browserState = processState.__sunoBrowserRecovery ??= { active: 0 };

export interface SunoBrowserRecoveryOptions {
  cookies: Record<string, string | undefined>;
  currentToken?: string;
}

export interface SunoBrowserRecoveryResult {
  clips: SunoGenerateClip[];
  cookies: Record<string, string>;
  authorizationToken?: string;
  browserIdentity: CaptchaBrowserIdentity;
}

type BrowserGenerateResult = Omit<SunoBrowserRecoveryResult, 'cookies'>;

export class SunoBrowserRecoveryTimeoutError extends Error {
  public readonly code = 'SUNO_BROWSER_RECOVERY_TIMEOUT';

  constructor() {
    super('Suno browser recovery timed out; the browser was stopped');
    this.name = 'SunoBrowserRecoveryTimeoutError';
  }
}

export class SunoBrowserRecoveryCapacityError extends Error {
  public readonly statusCode = 503;
  public readonly code = 'SUNO_BROWSER_RECOVERY_CAPACITY';
  public readonly retryAfterSeconds = 30;

  constructor() {
    super('Suno browser recovery capacity reached; retry later');
    this.name = 'SunoBrowserRecoveryCapacityError';
  }
}

export function isSunoBrowserGenerateRequest(url: string, method: string): boolean {
  try {
    const parsed = new URL(url);
    const expected = new URL(SUNO_GENERATE_URL);
    return method === 'POST' && parsed.origin === expected.origin &&
      /^\/api\/(?:generate\/v2-web|custom_generate)\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function prepareSunoBrowserCookies(options: SunoBrowserRecoveryOptions): Cookie[] {
  const cookies = { ...options.cookies };
  if (options.currentToken) applySunoSessionToken(cookies, options.currentToken);
  return Object.entries(cookies)
    .filter(([name, value]) => Boolean(name && value) &&
      !INVALID_COOKIE_RE.test(name) && !INVALID_COOKIE_RE.test(value!))
    .map(([name, value]) => ({
      name,
      value: value!,
      domain: '.suno.com',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'None',
    }));
}

export function collectSunoApiCookies(cookies: Cookie[]): Record<string, string> {
  const result: Record<string, string> = {};
  const apiHost = new URL(SUNO_GENERATE_URL).hostname;
  for (const item of cookies) {
    const domain = item.domain.replace(/^\./, '');
    if (!(domain === 'suno.com' || domain.endsWith('.suno.com'))) continue;
    if (apiHost !== domain && !(item.domain.startsWith('.') && apiHost.endsWith(`.${domain}`))) continue;
    if (item.expires > 0 && item.expires * 1000 <= Date.now()) continue;
    if (!item.name || !item.value || INVALID_COOKIE_RE.test(item.name) || INVALID_COOKIE_RE.test(item.value)) continue;
    result[item.name] = item.value;
  }
  return result;
}

/** Observe the website's own POST; never replace its body or reuse challenge tokens. */
export async function installSunoBrowserGenerateCapture(page: Page, signal: AbortSignal, onSubmitted?: () => void) {
  let armed = false;
  let submitted = false;
  let settled = false;
  let resolve!: (value: BrowserGenerateResult) => void;
  let reject!: (error: unknown) => void;
  const pending = new Set<Promise<void>>();
  const result = new Promise<BrowserGenerateResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  void result.catch(() => undefined);
  const finish = (error?: unknown, value?: BrowserGenerateResult) => {
    if (settled) return;
    settled = true;
    if (value) resolve(value);
    else reject(error);
  };
  const onAbort = () => finish(signal.reason ?? new SunoBrowserRecoveryTimeoutError());
  signal.addEventListener('abort', onAbort, { once: true });
  const matcher = (url: URL) => isSunoBrowserGenerateRequest(url.toString(), 'POST');
  const handleRoute = async (route: Route) => {
    const request = route.request();
    try {
      if (request.method() !== 'POST') {
        await route.continue();
        return;
      }
      if (!armed || submitted || settled || signal.aborted) {
        await route.abort();
        return;
      }
      submitted = true;
      onSubmitted?.();
      const headers = await request.allHeaders();
      signal.throwIfAborted();
      await route.continue();
      const response = await request.response();
      console.info('[SunoBrowserCapture] response', response?.status());
      if (!response) throw new Error('Suno browser generation completed without a response');
      const clips = await readSunoGenerateClips(response);
      if (!headers['user-agent']) throw new Error('Suno browser generation is missing its user agent');
      const authorizationToken = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      finish(undefined, {
        clips,
        authorizationToken,
        browserIdentity: {
          userAgent: headers['user-agent'],
          secChUa: headers['sec-ch-ua'],
          secChUaMobile: headers['sec-ch-ua-mobile'],
          secChUaPlatform: headers['sec-ch-ua-platform'],
        },
      });
    } catch (error) {
      await route.abort().catch(() => undefined);
      finish(error);
    }
  };
  const handler = (route: Route) => {
    const task = handleRoute(route);
    pending.add(task);
    void task.then(() => pending.delete(task));
    return task;
  };
  try {
    await page.route(matcher, handler);
    if (signal.aborted) onAbort();
  } catch (error) {
    signal.removeEventListener('abort', onAbort);
    finish(error);
    throw error;
  }
  return {
    result,
    arm: () => { armed = true; },
    dispose: async () => {
      armed = false;
      signal.removeEventListener('abort', onAbort);
      finish(new Error('Suno browser generation capture stopped'));
      await page.unroute(matcher, handler).catch(() => undefined);
      await Promise.all(pending);
    },
  };
}

function positiveSetting(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), maximum) : fallback;
}

function headedMode(): boolean {
  if (process.env.BROWSER_HEADLESS === 'true') return false;
  if (process.env.BROWSER_HEADLESS === 'false') {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new Error('BROWSER_HEADLESS=false requires DISPLAY or WAYLAND_DISPLAY');
    }
    return true;
  }
  return false;
}

export async function recoverSunoBrowserSession(
  options: SunoBrowserRecoveryOptions,
): Promise<SunoBrowserRecoveryResult> {
  const limit = positiveSetting('SUNO_CAPTCHA_MAX_CONCURRENT', 2, 8);
  if (browserState.active >= limit) throw new SunoBrowserRecoveryCapacityError();
  browserState.active += 1;
  const timeoutMs = positiveSetting('SUNO_BROWSER_RECOVERY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    controller.signal.throwIfAborted();
    return Math.max(1, deadline - Date.now());
  };
  let context: BrowserContext | undefined;
  let capture: Awaited<ReturnType<typeof installSunoBrowserGenerateCapture>> | undefined;
  let monitor: Promise<never> | undefined;
  let rejectTimeout!: (error: unknown) => void;
  const timeoutResult = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timeout = setTimeout(() => {
    const error = new SunoBrowserRecoveryTimeoutError();
    controller.abort(error);
    rejectTimeout(error);
  }, timeoutMs);

  const work = (async () => {
    const profileRoot = process.env.SUNO_BROWSER_PROFILE_ROOT || '/var/lib/suno-browser/profiles';
    const profileKey = createHash('sha256')
      .update(String(options.currentToken || 'default'))
      .digest('hex')
      .slice(0, 24);
    const profileDir = join(profileRoot, profileKey);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    // Keep one durable browser identity per Suno account. This preserves
    // localStorage, service-worker state and accepted challenge cookies across
    // recoveries, matching the long-lived session model used by MJ.
    context = await chromium.launchPersistentContext(profileDir, {
      headless: !headedMode(),
      timeout: Math.min(20_000, remaining()),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions'],
      userAgent: createMatchingChromiumUserAgent('persistent'),
      viewport: { width: 1280, height: 800 },
      locale: process.env.BROWSER_LOCALE,
      serviceWorkers: 'block',
      proxy: sunoEgressBrowserProxy(),
    });
    await context.addCookies(prepareSunoBrowserCookies(options));
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(15_000, remaining()));
    capture = await installSunoBrowserGenerateCapture(page, controller.signal);
    await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded', timeout: remaining() });
    controller.signal.throwIfAborted();
    await closeKnownPopups(page);
    const simple = page.getByRole('tab', { name: /^Simple$/i })
      .or(page.getByRole('button', { name: /^Simple$/i }));
    if (await simple.first().isVisible()) await simple.first().click({ timeout: remaining() });
    const prompt = page.locator([
      `${PROMPT_TEXTAREA_SELECTOR}:visible`,
      'textarea[placeholder*="song" i]:visible',
      'textarea[placeholder*="describe" i]:visible',
      'textarea[placeholder*="music" i]:visible',
    ].join(', ')).first();
    await prompt.fill(RECOVERY_PROMPT, { timeout: remaining() });
    const button = page.locator(`${CREATE_SONG_BUTTON_SELECTOR}:visible`)
      .or(page.getByRole('button', { name: /^Create(?: song)?$/i })).first();
    monitor = waitForInteractiveChallenge(page, controller.signal);
    void monitor.catch(() => undefined);
    capture.arm();
    const generation = Promise.race([capture.result, monitor]);
    void generation.catch(() => undefined);
    await button.click({ timeout: remaining() });
    const generated = await generation;
    controller.signal.throwIfAborted();
    const cookies = collectSunoApiCookies(await context.cookies(SUNO_GENERATE_URL));
    if (generated.authorizationToken) applySunoSessionToken(cookies, generated.authorizationToken);
    return { ...generated, cookies };
  })();

  try {
    return await Promise.race([work, timeoutResult]);
  } finally {
    clearTimeout(timeout);
    controller.abort(new Error('Suno browser recovery finished'));
    // Closing the persistent context cancels navigation and challenge polling
    // while leaving the profile on disk for the next recovery.
    let forcedClose: Promise<void> | undefined;
    const killTimer = setTimeout(() => {
      forcedClose = context?.close().catch(() => undefined);
    }, CLOSE_TIMEOUT_MS);
    try {
      await context?.close().catch(() => undefined);
      await work.catch(() => undefined);
      await monitor?.catch(() => undefined);
      await capture?.dispose();
      await forcedClose;
    } finally {
      clearTimeout(killTimer);
      browserState.active -= 1;
    }
  }
}

export async function waitForInteractiveChallenge(page: Page, signal: AbortSignal): Promise<never> {
  while (!signal.aborted) {
    for (const frame of page.frames()) {
      let host: string;
      try { host = new URL(frame.url()).hostname; } catch { continue; }
      const hcaptcha = host === 'hcaptcha.com' || host.endsWith('.hcaptcha.com');
      const turnstile = host === 'challenges.cloudflare.com';
      if (!hcaptcha && !turnstile) continue;
      const interactive = frame.locator(hcaptcha
        ? '.challenge-container, .challenge-view'
        : 'input[type="checkbox"], [role="checkbox"]');
      if (await interactive.first().isVisible().catch(() => false)) {
        throw new SunoCaptchaManualInterventionError();
      }
    }
    await page.waitForTimeout(250);
  }
  throw signal.reason ?? new Error('Suno browser recovery stopped');
}
