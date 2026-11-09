import pino from 'pino';
import { Browser, BrowserContext, chromium, Locator, Page, Request } from 'playwright';
import path from 'node:path';
import { YesCaptchaAction, YesCaptchaClient } from '@/lib/yesCaptchaClient';
import { createMatchingChromiumUserAgent } from '@/lib/browserFingerprint';
import { applySunoSessionToken } from '@/lib/sunoAuthCookies';
import { collectSunoApiCookies } from '@/lib/sunoBrowserRecovery';
import { SunoCaptchaManualInterventionError } from '@/lib/sunoCaptchaErrors';
import { sleep } from '@/lib/utils';
import {
  startCaptchaRequestLoggingAfterClick
} from '@/lib/sunoCaptchaNetworkLogging';
import { SunoCaptchaDebugSession } from '@/lib/sunoCaptchaDebugSession';
import { closeKnownPopups, describePointerBlocker, waitForPointerTarget } from '@/lib/sunoPopupHandler';
import { saveCaptchaChallengeSnapshot } from '@/lib/captchaChallengeSnapshot';
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
import { installTurnstileChallengeHook, solveTurnstileChallenges } from '@/lib/sunoTurnstileChallenge';

const logger = pino();
const SUNO_CREATE_URL = 'https://suno.com/create';
const CAPTCHA_DEBUG_SAVE = process.env.CAPTCHA_DEBUG_SAVE === 'true';
const CAPTCHA_CHALLENGE_STABLE_WAIT_MS = 10_000;
const RECORD_VIDEO_DIR = path.join(process.cwd(), 'logs', 'captcha-videos');
const HCAPTCHA_IMAGE_RE = /^https:\/\/(?:img[a-zA-Z0-9]*\.hcaptcha\.com|hcaptcha-imgs-prod\.suno\.com)\/.*$/;
const INVALID_COOKIE_RE = /[\x00-\x1f\x7f;,"]/;
interface SunoCaptchaSolverOptions {
  cookies: Record<string, string | undefined>;
  currentToken?: string;
}

const configuredMaxConcurrent = Number.parseInt(process.env.SUNO_CAPTCHA_MAX_CONCURRENT ?? '', 10);
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
  private readonly yesCaptcha = new YesCaptchaClient(process.env.YESCAPTCHA_KEY ?? '');
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
        logger
      );
      logger.info(`SunoCaptchaSolver: navigating to ${SUNO_CREATE_URL}`);
      await page.goto(SUNO_CREATE_URL, {
        referer: 'https://www.google.com/',
        waitUntil: 'domcontentloaded',
        timeout: 0
      });
      await this.waitForSunoReady(page);
      await this.triggerCaptcha(page);
      if (CAPTCHA_DEBUG_SAVE) {
        delayedSnapshot = saveCaptchaSnapshotAfterDelay(abortController.signal,
          () => debugSession.save(page, undefined, 'captcha-after-20s'));
      }
      await Promise.race([
        this.waitForChallengeHandlers(page, abortController.signal),
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
      if (CAPTCHA_DEBUG_SAVE && !this.generationSucceeded) {
        await debugSession.notifyFailure(files, failure, videoPath);
      }
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
    await this.ensureSimpleMode(page);
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

  private async ensureSimpleMode(page: Page): Promise<void> {
    const simple = page
      .getByRole('tab', { name: /^Simple$/i })
      .or(page.getByRole('button', { name: /^Simple$/i }))
      .first();
    const advanced = page
      .getByRole('tab', { name: /^Advanced$/i })
      .or(page.getByRole('button', { name: /^Advanced$/i }))
      .first();

    await simple.or(advanced).first().waitFor({ state: 'visible', timeout: 15_000 });
    if (!(await simple.isVisible().catch(() => false))) {
      throw new Error('Suno create page did not expose the Simple mode tab');
    }
    if ((await simple.getAttribute('aria-selected').catch(() => null)) === 'true') {
      return;
    }

    logger.info('SunoCaptchaSolver: create page is in Advanced mode; switching to Simple');
    await simple.click({ timeout: 15_000 });
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('[role="tab"]')).some(
        (tab) => tab.textContent?.trim().toLowerCase() === 'simple'
          && tab.getAttribute('aria-selected') === 'true'
      ),
      { timeout: 15_000 }
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

  private async waitForChallengeHandlers(page: Page, signal: AbortSignal): Promise<never> {
    const results = await Promise.allSettled([
      solveTurnstileChallenges(
        page,
        signal,
        (challenge, challengeSignal) =>
          this.yesCaptcha.solveTurnstile(challenge.websiteURL, challenge.websiteKey, challengeSignal),
        () => logger.info('SunoCaptchaSolver: delivered YesCaptcha Turnstile token to page')
      ),
      this.solveChallenges(page, signal)
    ]);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    for (const error of errors) {
      logger.warn(`SunoCaptchaSolver: challenge handler ended: ${this.formatError(error)}`);
    }
    throw new AggregateError(errors, 'All captcha challenge handlers ended before token capture');
  }

  private async solveChallenges(page: Page, signal: AbortSignal): Promise<void> {
    const frame = page.frameLocator('iframe[title*="hCaptcha"]');
    const challenge = frame.locator('.challenge-container');
    while (!signal.aborted) {
      await this.waitForVisibleChallenge(challenge);
      if (CAPTCHA_DEBUG_SAVE) await this.saveChallengeSnapshot(page, challenge);
      await this.waitForHcaptchaImages(page, signal);
      logger.info('SunoCaptchaSolver: waiting 10s for hCaptcha challenge to stabilize');
      await page.waitForTimeout(CAPTCHA_CHALLENGE_STABLE_WAIT_MS);
      const prompt = await this.readChallengePrompt(challenge);
      logger.info(`SunoCaptchaSolver: solving hCaptcha challenge: ${prompt}`);
      if (CAPTCHA_DEBUG_SAVE) await this.saveChallengeSnapshot(page, challenge, prompt);
      const actions = await this.solveVisibleChallenge(challenge, prompt);
      await this.performActions(challenge, actions);
      await this.submitChallenge(frame.locator('.button-submit'));
    }
  }

  private async readChallengePrompt(challenge: Locator): Promise<string> {
    const prompt = await challenge.locator('.prompt-text').first().innerText({ timeout: 10_000 });
    return prompt.trim();
  }

  private async saveChallengeSnapshot(page: Page, challenge: Locator, prompt?: string): Promise<void> {
    try {
      await saveCaptchaChallengeSnapshot({ page, challenge, prompt, logger });
    } catch (error) {
      logger.warn(`SunoCaptchaSolver: failed to save hCaptcha challenge snapshot: ${this.formatError(error)}`);
    }
  }

  private async waitForVisibleChallenge(challenge: Locator): Promise<void> {
    await challenge.waitFor({ state: 'visible', timeout: 60_000 });
  }

  private async solveVisibleChallenge(
    challenge: Locator,
    prompt: string
  ): Promise<YesCaptchaAction[]> {
    const images = await this.readChallengeImages(challenge);
    if (images.length) {
      return this.yesCaptcha.solveHcaptchaByImages(images, prompt);
    }

    logger.info('SunoCaptchaSolver: no task-image tiles found; solving hCaptcha by challenge screenshot');
    const screenshot = await challenge.screenshot({ timeout: 10_000 });
    return this.yesCaptcha.solveHcaptchaByScreenshot(screenshot.toString('base64'), prompt);
  }

  private async readChallengeImages(challenge: Locator): Promise<string[]> {
    const images = challenge.locator('.task-image');
    const count = await images.count();
    const screenshots: string[] = [];
    for (let index = 0; index < count; index++) {
      const image = await images.nth(index).screenshot({ timeout: 10_000 });
      screenshots.push(image.toString('base64'));
    }
    return screenshots;
  }

  private async performActions(challenge: Locator, actions: YesCaptchaAction[]): Promise<void> {
    const box = await challenge.boundingBox();
    if (!box) {
      throw new Error('.challenge-container boundingBox is null');
    }

    for (const action of actions) {
      if (action.type === 'click') {
        await challenge.click({ force: true, position: action.point });
      } else if (action.type === 'clickTile') {
        await this.clickChallengeTile(challenge, action.index);
      } else {
        await challenge.page().mouse.move(box.x + action.start.x, box.y + action.start.y);
        await challenge.page().mouse.down();
        await sleep(1.1);
        await challenge.page().mouse.move(box.x + action.end.x, box.y + action.end.y, { steps: 30 });
        await challenge.page().mouse.up();
      }
      await sleep(0.2);
    }
  }

  private async clickChallengeTile(challenge: Locator, index: number): Promise<void> {
    const challengeBox = await challenge.boundingBox();
    const tileBox = await challenge.locator('.task-image').nth(index).boundingBox();
    if (!challengeBox || !tileBox) {
      throw new Error(`hCaptcha task image ${index} boundingBox is null`);
    }
    await challenge.click({
      force: true,
      position: {
        x: tileBox.x - challengeBox.x + tileBox.width / 2,
        y: tileBox.y - challengeBox.y + tileBox.height / 2
      }
    });
  }

  private async submitChallenge(button: Locator): Promise<void> {
    await button.click({ force: true });
    await sleep(1);
  }

  private async waitForHcaptchaImages(page: Page, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | undefined;
      let activeRequestCount = 0;
      let requestOccurred = false;

      const cleanup = () => {
        page.off('request', onRequest);
        page.off('requestfinished', onRequestFinished);
        page.off('requestfailed', onRequestFinished);
        signal.removeEventListener('abort', onAbort);
        clearTimeout(initialTimeout);
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const resetTimeout = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (activeRequestCount === 0) timeoutHandle = setTimeout(finish, 1_000);
      };
      const onRequest = (request: Request) => {
        if (!HCAPTCHA_IMAGE_RE.test(request.url())) return;
        logger.info(`SunoCaptchaSolver: hCaptcha image request ${request.url()}`);
        requestOccurred = true;
        activeRequestCount++;
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };
      const onRequestFinished = (request: Request) => {
        if (!HCAPTCHA_IMAGE_RE.test(request.url())) return;
        activeRequestCount--;
        resetTimeout();
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('AbortError'));
      };
      const initialTimeout = setTimeout(() => {
        if (!requestOccurred) {
          cleanup();
          logger.warn('SunoCaptchaSolver: no old-style hCaptcha image request observed; continuing');
          resolve();
        } else {
          resetTimeout();
        }
      }, 10_000);

      page.on('request', onRequest);
      page.on('requestfinished', onRequestFinished);
      page.on('requestfailed', onRequestFinished);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
