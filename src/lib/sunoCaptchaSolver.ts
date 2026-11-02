import pino from 'pino';
import { Browser, BrowserContext, chromium, Locator, Page } from 'playwright';
import path from 'node:path';
import { createMatchingChromiumUserAgent } from '@/lib/browserFingerprint';
import { applySunoSessionToken } from '@/lib/sunoAuthCookies';
import { collectSunoApiCookies } from '@/lib/sunoBrowserRecovery';
import {
  startCaptchaRequestLoggingAfterClick
} from '@/lib/sunoCaptchaNetworkLogging';
import { SunoCaptchaDebugSession } from '@/lib/sunoCaptchaDebugSession';
import { closeKnownPopups, describePointerBlocker, waitForPointerTarget } from '@/lib/sunoPopupHandler';
import {
  CREATE_SONG_BUTTON_SELECTOR,
  PROMPT_TEXTAREA_SELECTORS,
  waitForPromptTextarea
} from '@/lib/sunoCreateSelectors';
import {
  CaptchaGenerateCapture,
  CaptchaGenerationResult,
  installCaptchaGenerateCapture,
  SUNO_GENERATE_URL_PART,
  SunoGeneratePayload
} from '@/lib/sunoCaptchaGenerateCapture';
import { saveCaptchaSnapshotAfterDelay } from '@/lib/sunoCaptchaSnapshotTimer';
import { installTurnstileChallengeHook, TURNSTILE_HOOK_KEY } from '@/lib/sunoTurnstileChallenge';
import { SunoCaptchaManualInterventionError } from '@/lib/sunoCaptchaErrors';

const logger = pino();
const SUNO_CREATE_URL = 'https://suno.com/create';
const CAPTCHA_DEBUG_SAVE = process.env.CAPTCHA_DEBUG_SAVE === 'true';
const CAPTCHA_DETECTION_INTERVAL_MS = 500;
const CAPTCHA_CAPTURE_TIMEOUT_MS = 60_000;
const RECORD_VIDEO_DIR = path.join(process.cwd(), 'logs', 'captcha-videos');
const INVALID_COOKIE_RE = /[\x00-\x1f\x7f;,"]/;
const configuredMaxConcurrent = Number.parseInt(
  process.env.SUNO_CAPTCHA_MAX_CONCURRENT ?? '2',
  10
);
const MAX_CONCURRENT_CAPTCHA_SOLVES = Number.isFinite(configuredMaxConcurrent) && configuredMaxConcurrent > 0
  ? configuredMaxConcurrent
  : 2;
let activeCaptchaSolves = 0;

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

interface SunoCaptchaSolverOptions {
  cookies: Record<string, string | undefined>;
  currentToken?: string;
}

export class SunoCaptchaCapacityError extends Error {
  public readonly statusCode = 503;

  constructor(limit: number) {
    super(`Suno captcha capacity reached (${limit} active); retry later`);
    this.name = 'SunoCaptchaCapacityError';
  }
}

export interface SunoCaptchaGenerationResult extends CaptchaGenerationResult {
  cookies: Record<string, string>;
}

export class SunoCaptchaSolver {
  private generationSucceeded = false;

  constructor(private readonly options: SunoCaptchaSolverOptions) {}

  public async generate(payload: SunoGeneratePayload): Promise<SunoCaptchaGenerationResult> {
    if (process.env.SUNO_SERVER_BROWSER_SOLVER !== 'true') {
      throw new SunoCaptchaManualInterventionError();
    }
    if (activeCaptchaSolves >= MAX_CONCURRENT_CAPTCHA_SOLVES) {
      throw new SunoCaptchaCapacityError(MAX_CONCURRENT_CAPTCHA_SOLVES);
    }
    activeCaptchaSolves += 1;
    logger.info(`SunoCaptchaSolver: acquired browser slot (${activeCaptchaSolves}/${MAX_CONCURRENT_CAPTCHA_SOLVES})`);
    try {
      return await this.generateWithBrowser(payload);
    } finally {
      activeCaptchaSolves -= 1;
      logger.info(`SunoCaptchaSolver: released browser slot (${activeCaptchaSolves}/${MAX_CONCURRENT_CAPTCHA_SOLVES})`);
    }
  }

  private async generateWithBrowser(payload: SunoGeneratePayload): Promise<SunoCaptchaGenerationResult> {
    logger.info('SunoCaptchaSolver: launching browser');
    const browser = await this.launchBrowser();
    const browserUserAgent = createMatchingChromiumUserAgent(browser.version());
    const context = await this.createContext(browser, browserUserAgent);
    const page = await context.newPage();
    await installTurnstileChallengeHook(page);
    const debugSession = new SunoCaptchaDebugSession(browserUserAgent, logger);
    debugSession.attach(context, page, SUNO_GENERATE_URL_PART);
    const abortController = new AbortController();
    let generateCapture: CaptchaGenerateCapture | undefined;
    let delayedSnapshot: Promise<void> | undefined;
    let failure: unknown;

    try {
      generateCapture = await installCaptchaGenerateCapture(
        page,
        payload,
        logger,
        CAPTCHA_CAPTURE_TIMEOUT_MS
      );
      logger.info(`SunoCaptchaSolver: navigating to ${SUNO_CREATE_URL}`);
      await page.goto(SUNO_CREATE_URL, {
        referer: 'https://www.google.com/',
        waitUntil: 'domcontentloaded',
        timeout: 60_000
      });
      await this.waitForSunoReady(page);
      await this.triggerCaptcha(page);
      if (CAPTCHA_DEBUG_SAVE) {
        delayedSnapshot = saveCaptchaSnapshotAfterDelay(abortController.signal,
          () => debugSession.save(page, undefined, 'captcha-after-20s'));
      }
      await Promise.race([
        this.waitForManualCaptcha(page, abortController.signal),
        generateCapture.result
      ]);
      logger.info('SunoCaptchaSolver: waiting for browser Generate response');
      const result = await generateCapture.result;
      // 把浏览器里最新的登录态带回去，调用方会写回账号记录。
      const cookies = collectSunoApiCookies(await context.cookies());
      if (result.authorizationToken) applySunoSessionToken(cookies, result.authorizationToken);
      this.generationSucceeded = true;
      return { ...result, cookies };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const diagnosticName = failure
        ? 'captcha-generate-failure'
        : 'captcha-generate-success';
      const files = CAPTCHA_DEBUG_SAVE
        ? await debugSession.save(page, failure, diagnosticName)
        : undefined;
      abortController.abort();
      generateCapture?.cancel();
      await delayedSnapshot;
      const videoPath = CAPTCHA_DEBUG_SAVE
        ? await debugSession.closeBrowserWithVideoLog(page, browser)
        : undefined;
      if (!CAPTCHA_DEBUG_SAVE) await browser.close();
      if (!this.generationSucceeded) await debugSession.notifyFailure(files, failure, videoPath);
      logger.info('SunoCaptchaSolver: browser closed');
    }
  }

  private async launchBrowser(): Promise<Browser> {
    return chromium.launch({
      headless: !headedMode(),
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-infobars'
      ]
    });
  }

  private async createContext(browser: Browser, userAgent: string): Promise<BrowserContext> {
    return browser.newContext({
      userAgent,
      locale: process.env.BROWSER_LOCALE,
      viewport: { width: 1280, height: 800 },
      recordVideo: CAPTCHA_DEBUG_SAVE
        ? { dir: RECORD_VIDEO_DIR, size: { width: 1280, height: 800 } }
        : undefined,
      storageState: {
        cookies: this.toPlaywrightCookies(),
        origins: []
      }
    });
  }

  private toPlaywrightCookies() {
    const entries = Object.entries(this.options.cookies).filter(([name, value]) => {
      if (!value) return false;
      return !INVALID_COOKIE_RE.test(name) && !INVALID_COOKIE_RE.test(value);
    });

    const cookies = entries.map(([name, value]) => ({
      name,
      value: value as string,
      domain: '.suno.com',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'None' as const
    }));

    if (this.options.currentToken) {
      cookies.push({
        name: '__session',
        value: this.options.currentToken,
        domain: '.suno.com',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'None' as const
      });
    }
    return cookies;
  }

  private async waitForSunoReady(page: Page): Promise<void> {
    try {
      await page.waitForResponse((resp) => resp.url().includes('/api/project/'), { timeout: 60_000 });
      logger.info('SunoCaptchaSolver: Suno project list loaded');
    } catch {
      logger.warn('Timed out waiting for Suno project list; continuing to trigger captcha');
    }
  }

  private async triggerCaptcha(page: Page): Promise<void> {
    logger.info('SunoCaptchaSolver: triggering captcha from create page');
    await closeKnownPopups(page);
    logger.info('SunoCaptchaSolver: waiting for prompt textarea');
    const handle = await waitForPromptTextarea(page, 60_000);
    if (!handle) {
      throw new Error(
        `Suno create page never exposed a prompt textarea (url=${page.url()}); `
          + `tried ${PROMPT_TEXTAREA_SELECTORS.join(' | ')}`
      );
    }
    const { locator: textarea, selector: textareaSelector } = handle;
    logger.info(`SunoCaptchaSolver: prompt textarea matched by ${textareaSelector}`);

    await Promise.race([
      page.waitForResponse((resp) => resp.url().includes('checksiteconfig'), { timeout: 8_000 })
        .then(() => logger.info('SunoCaptchaSolver: hCaptcha checksiteconfig observed'))
        .catch(() => logger.warn('SunoCaptchaSolver: hCaptcha checksiteconfig not observed within 8s')),
      page.waitForTimeout(8_000),
    ]);

    logger.info('SunoCaptchaSolver: filling prompt textarea');
    await this.focusPromptTextarea(page, textarea, textareaSelector);
    await textarea.fill('');
    await page.waitForTimeout(500);
    await textarea.type('Lorem ipsum', { delay: 40 });

    const createButton = page.locator(CREATE_SONG_BUTTON_SELECTOR);
    logger.info('SunoCaptchaSolver: waiting for Create song button');
    await createButton.waitFor({ state: 'visible', timeout: 60_000 });
    await page.waitForFunction(
      (selector) => {
        const button = document.querySelector<HTMLButtonElement>(selector);
        return Boolean(button && !button.disabled);
      },
      CREATE_SONG_BUTTON_SELECTOR,
      { timeout: 60_000 }
    );
    logger.info('SunoCaptchaSolver: Create song button enabled; waiting 5s before click');
    await page.waitForTimeout(5_000);
    if (!(await waitForPointerTarget(page, CREATE_SONG_BUTTON_SELECTOR))) {
      logger.warn(
        `SunoCaptchaSolver: Create song button is covered by `
          + `${await describePointerBlocker(page, CREATE_SONG_BUTTON_SELECTOR)}`
      );
    }
    await this.logCreateButtonDiagnostics(createButton);
    logger.info('SunoCaptchaSolver: clicking Create song button');
    await startCaptchaRequestLoggingAfterClick(
      page,
      SUNO_GENERATE_URL_PART,
      logger,
      () => createButton.click()
    );
  }

  /**
   * Suno 会不定时弹出营销弹窗（"You've unlocked 20% off Premier annual."），它是
   * base-ui 渲染的全屏 portal，会拦截 textarea 的点击并一路重试到超时。
   * 这里先清掉遮挡，实在清不掉就退回 DOM focus，至少让流程能继续。
   */
  private async focusPromptTextarea(page: Page, textarea: Locator, selector: string): Promise<void> {
    if (await waitForPointerTarget(page, selector)) {
      await textarea.click({ timeout: 15_000 });
      return;
    }

    logger.warn(
      `SunoCaptchaSolver: prompt textarea is still covered by `
        + `${await describePointerBlocker(page, selector)}; focusing via DOM`
    );
    await textarea.evaluate((element) => (element as HTMLTextAreaElement).focus());
  }

  private async logCreateButtonDiagnostics(createButton: Locator): Promise<void> {
    const diagnostics = await createButton.evaluate((button) => ({
      text: button.textContent,
      disabled: (button as HTMLButtonElement).disabled,
      ariaDisabled: button.getAttribute('aria-disabled'),
      dataTriggerDisabled: button.getAttribute('data-trigger-disabled'),
      id: button.id,
      className: button.className,
      rect: button.getBoundingClientRect().toJSON(),
      centerElement: (() => {
        const rect = button.getBoundingClientRect();
        const element = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        );
        return element && {
          tagName: element.tagName,
          text: element.textContent,
          id: element.id,
          className: element.className
        };
      })()
    }));
    logger.info(`SunoCaptchaSolver: Create song button diagnostics ${JSON.stringify(diagnostics)}`);
  }

  private async waitForManualCaptcha(page: Page, signal: AbortSignal): Promise<never> {
    while (!signal.aborted) {
      if (await this.hasVisibleCaptcha(page)) {
        logger.warn('SunoCaptchaSolver: captcha detected; stopping for manual browser login');
        throw new SunoCaptchaManualInterventionError();
      }
      await page.waitForTimeout(CAPTCHA_DETECTION_INTERVAL_MS);
    }
    throw new Error('Captcha detection aborted');
  }

  private async hasVisibleCaptcha(page: Page): Promise<boolean> {
    try {
      const hcaptchaChallenge = page
        .frameLocator('iframe[title*="hCaptcha"]')
        .locator('.challenge-container');
      if (await hcaptchaChallenge.isVisible({ timeout: 200 })) return true;

      const turnstileFrame = page.locator('#generation-turnstile-container iframe');
      if (await turnstileFrame.isVisible({ timeout: 200 })) return true;

      return await page.evaluate((hookKey) => {
        const state = (window as unknown as Record<string, any>)[hookKey];
        return Array.isArray(state?.challenges) && state.challenges.some(
          (challenge: any) => challenge.status === 'pending' || challenge.status === 'solving'
        );
      }, TURNSTILE_HOOK_KEY);
    } catch {
      return false;
    }
  }

}
