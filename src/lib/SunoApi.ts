import axios, { AxiosInstance } from 'axios';
import UserAgent from 'user-agents';
import pino from 'pino';
import yn from 'yn';
import { isPage, sleep, waitForRequests, AsyncMutex, AsyncSemaphore } from '@/lib/utils';
import * as cookie from 'cookie';
import { randomUUID } from 'node:crypto';
import { Solver } from '@2captcha/captcha-solver';
import { paramsCoordinates } from '@2captcha/captcha-solver/dist/structs/2captcha';
import { BrowserContext, Page, Locator, chromium, firefox } from 'rebrowser-playwright-core';
import { createCursor, Cursor } from 'ghost-cursor-playwright';
import { promises as fs } from 'fs';
import path from 'node:path';

// sunoApi instance caching
const globalForSunoApi = global as unknown as { sunoApiCache?: Map<string, SunoApi> };
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;

const logger = pino();
export const DEFAULT_MODEL = 'chirp-v3-5';

export interface AudioInfo {
  id: string; // Unique identifier for the audio
  title?: string; // Title of the audio
  image_url?: string; // URL of the image associated with the audio
  lyric?: string; // Lyrics of the audio
  audio_url?: string; // URL of the audio file
  video_url?: string; // URL of the video associated with the audio
  created_at: string; // Date and time when the audio was created
  model_name: string; // Name of the model used for audio generation
  gpt_description_prompt?: string; // Prompt for GPT description
  prompt?: string; // Prompt for audio generation
  status: string; // Status
  type?: string;
  tags?: string; // Genre of music.
  negative_tags?: string; // Negative tags of music.
  duration?: string; // Duration of the audio
  error_message?: string; // Error message if any
}

interface PersonaResponse {
  persona: {
    id: string;
    name: string;
    description: string;
    image_s3_id: string;
    root_clip_id: string;
    clip: any; // You can define a more specific type if needed
    user_display_name: string;
    user_handle: string;
    user_image_url: string;
    persona_clips: Array<{
      clip: any; // You can define a more specific type if needed
    }>;
    is_suno_persona: boolean;
    is_trashed: boolean;
    is_owned: boolean;
    is_public: boolean;
    is_public_approved: boolean;
    is_loved: boolean;
    upvote_count: number;
    clip_count: number;
  };
  total_results: number;
  current_page: number;
  is_following: boolean;
}

class SunoApi {
  private static BASE_URL: string = 'https://studio-api.prod.suno.com';
  private static CLERK_BASE_URL: string = 'https://clerk.suno.com';
  private static CLERK_VERSION = '5.15.0';

  private readonly client: AxiosInstance;
  private sid?: string;
  private currentToken?: string;
  private deviceId?: string;
  private userAgent?: string;
  private cookies: Record<string, string | undefined>;
  private solver = new Solver(process.env.TWOCAPTCHA_KEY + '');
  private ghostCursorEnabled = yn(process.env.BROWSER_GHOST_CURSOR, { default: false });
  private cursor?: Cursor;

  // Concurrency control
  private keepAliveMutex = new AsyncMutex();
  private captchaMutex = new AsyncMutex();
  private requestSemaphore = new AsyncSemaphore(
    parseInt(process.env.CONCURRENT_LIMIT || '3', 10)
  );
  private lastKeepAliveTime = 0;
  private static readonly KEEPALIVE_COOLDOWN_MS = 30_000; // skip refresh if < 30s ago
  private requestCounter = 0;

  constructor(cookies: string) {
    this.userAgent = new UserAgent(/Macintosh/).random().toString(); // Usually Mac systems get less amount of CAPTCHAs
    this.cookies = cookie.parse(cookies);
    this.deviceId = this.cookies.ajs_anonymous_id || randomUUID();
    this.client = axios.create({
      withCredentials: true,
      headers: {
        'Affiliate-Id': 'undefined',
        'Device-Id': `"${this.deviceId}"`,
        'x-suno-client': 'Android prerelease-4nt180t 1.0.42',
        'X-Requested-With': 'com.suno.android',
        'sec-ch-ua': '"Chromium";v="130", "Android WebView";v="130", "Not?A_Brand";v="99"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'User-Agent': this.userAgent
      }
    });
    this.client.interceptors.request.use(config => {
      if (this.currentToken && !config.headers.Authorization)
        config.headers.Authorization = `Bearer ${this.currentToken}`;
      const cookiesArray = Object.entries(this.cookies).map(([key, value]) => 
        cookie.serialize(key, value as string)
      );
      config.headers.Cookie = cookiesArray.join('; ');
      return config;
    });
    this.client.interceptors.response.use(resp => {
      const setCookieHeader = resp.headers['set-cookie'];
      if (Array.isArray(setCookieHeader)) {
        const newCookies = cookie.parse(setCookieHeader.join('; '));
        for (const [key, value] of Object.entries(newCookies)) {
          this.cookies[key] = value;
        }
      }
      return resp;
    })
  }

  public async init(): Promise<SunoApi> {
    //await this.getClerkLatestVersion();
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  /**
   * Get the clerk package latest version id.
   * This method is commented because we are now using a hard-coded Clerk version, hence this method is not needed.
   
  private async getClerkLatestVersion() {
    // URL to get clerk version ID
    const getClerkVersionUrl = `${SunoApi.JSDELIVR_BASE_URL}/v1/package/npm/@clerk/clerk-js`;
    // Get clerk version ID
    const versionListResponse = await this.client.get(getClerkVersionUrl);
    if (!versionListResponse?.data?.['tags']['latest']) {
      throw new Error(
        'Failed to get clerk version info, Please try again later'
      );
    }
    // Save clerk version ID for auth
    SunoApi.clerkVersion = versionListResponse?.data?.['tags']['latest'];
  }
  */

  /**
   * Get the session ID and save it for later use.
   */
  private async getAuthToken() {
    logger.info('Getting the session ID');
    // URL to get session ID
    const getSessionUrl = `${SunoApi.CLERK_BASE_URL}/v1/client?_is_native=true&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Get session ID
    const sessionResponse = await this.client.get(getSessionUrl, {
      headers: { Authorization: this.cookies.__client }
    });
    if (!sessionResponse?.data?.response?.last_active_session_id) {
      throw new Error(
        'Failed to get session id, you may need to update the SUNO_COOKIE'
      );
    }
    // Save session ID for later use
    this.sid = sessionResponse.data.response.last_active_session_id;
  }

  /**
   * Keep the session alive.
   * Uses a mutex to prevent concurrent token refreshes, and a cooldown
   * so rapid back-to-back calls skip redundant refreshes.
   * @param isWait Indicates if the method should wait for the session to be fully renewed before returning.
   */
  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }

    // Fast path: skip if recently refreshed (avoids mutex contention)
    const now = Date.now();
    if (this.currentToken && now - this.lastKeepAliveTime < SunoApi.KEEPALIVE_COOLDOWN_MS) {
      return;
    }

    const release = await this.keepAliveMutex.acquire();
    try {
      // Double-check after acquiring lock (another caller may have refreshed while we waited)
      if (this.currentToken && Date.now() - this.lastKeepAliveTime < SunoApi.KEEPALIVE_COOLDOWN_MS) {
        return;
      }

      // URL to renew session token
      const renewUrl = `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?_is_native=true&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
      // Renew session token
      logger.info('KeepAlive...\n');
      const renewResponse = await this.client.post(renewUrl, {}, {
        headers: { Authorization: this.cookies.__client }
      });
      if (isWait) {
        await sleep(1, 2);
      }
      const newToken = renewResponse.data.jwt;
      // Update Authorization field in request header with the new JWT token
      this.currentToken = newToken;
      this.lastKeepAliveTime = Date.now();
    } finally {
      release();
    }
  }

  /**
   * Get the session token (not to be confused with session ID) and save it for later use.
   */
  private async getSessionToken() {
    const tokenResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/user/create_session_id/`,
      {
        session_properties: JSON.stringify({ deviceId: this.deviceId }),
        session_type: 1
      }
    );
    return tokenResponse.data.session_id;
  }

  private async captchaRequired(): Promise<boolean> {
    const resp = await this.client.post(`${SunoApi.BASE_URL}/api/c/check`, {
      ctype: 'generation'
    });
    logger.info(resp.data);
    return resp.data.required;
  }

  /**
   * Clicks on a locator or XY vector. This method is made because of the difference between ghost-cursor-playwright and Playwright methods
   */
  private async click(target: Locator|Page, position?: { x: number, y: number }): Promise<void> {
    if (this.ghostCursorEnabled) {
      let pos: any = isPage(target) ? { x: 0, y: 0 } : await target.boundingBox();
      if (position) 
        pos = {
          ...pos,
          x: pos.x + position.x,
          y: pos.y + position.y,
          width: null,
          height: null,
        };
      return this.cursor?.actions.click({
        target: pos
      });
    } else {
      if (isPage(target))
        return target.mouse.click(position?.x ?? 0, position?.y ?? 0);
      else
        return target.click({ force: true, position });
    }
  }

  /**
   * Get the BrowserType from the `BROWSER` environment variable.
   * @returns {BrowserType} chromium, firefox or webkit. Default is chromium
   */
  private getBrowserType() {
    const browser = process.env.BROWSER?.toLowerCase();
    switch (browser) {
      case 'firefox':
        return firefox;
      /*case 'webkit': ** doesn't work with rebrowser-patches
      case 'safari':
        return webkit;*/
      default:
        return chromium;
    }
  }

  /**
   * Launches a browser with the necessary cookies
   * @returns {BrowserContext}
   */
  private async launchBrowser(): Promise<BrowserContext> {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=site-per-process',
      '--disable-features=IsolateOrigins',
      '--disable-extensions',
      '--disable-infobars'
    ];
    // Check for GPU acceleration, as it is recommended to turn it off for Docker
    if (yn(process.env.BROWSER_DISABLE_GPU, { default: false }))
      args.push('--enable-unsafe-swiftshader',
        '--disable-gpu',
        '--disable-setuid-sandbox');
    const browser = await this.getBrowserType().launch({
      args,
      headless: yn(process.env.BROWSER_HEADLESS, { default: true })
    });
    const context = await browser.newContext({ userAgent: this.userAgent, locale: process.env.BROWSER_LOCALE, viewport: null });
    const cookies = [];
    const lax: 'Lax' | 'Strict' | 'None' = 'Lax';
    cookies.push({
      name: '__session',
      value: this.currentToken+'',
      domain: '.suno.com',
      path: '/',
      sameSite: lax
    });
    for (const key in this.cookies) {
      cookies.push({
        name: key,
        value: this.cookies[key]+'',
        domain: '.suno.com',
        path: '/',
        sameSite: lax
      })
    }
    await context.addCookies(cookies);
    return context;
  }

  /**
   * Returns the first visible locator from a list of selectors.
   * Uses a raw delay to avoid log spam from the sleep() helper.
   */
  private async waitForAnyVisibleLocator(page: Page, selectors: string[], timeout = 30000): Promise<Locator | null> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        const visible = await locator.isVisible().catch(() => false);
        if (visible)
          return locator;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  /**
   * Saves full-page HTML, screenshot, and request log into the debug/ folder.
   */
  private async saveDebugSnapshot(page: Page, label: string, requestLog?: string[]): Promise<void> {
    const debugDir = path.join(process.cwd(), 'debug');
    try {
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(path.join(debugDir, `${label}.html`), await page.content());
      await page.screenshot({ path: path.join(debugDir, `${label}.png`), fullPage: true });
      if (requestLog) {
        await fs.writeFile(path.join(debugDir, `${label}-requests.log`), requestLog.join('\n'));
      }
      // List all frames
      const frameUrls = page.frames().map(f => f.url());
      await fs.writeFile(path.join(debugDir, `${label}-frames.log`), frameUrls.join('\n'));
      logger.info(`Debug snapshot saved: debug/${label}.*`);
    } catch (e: any) {
      logger.warn(`Failed to save debug snapshot "${label}": ${e.message}`);
    }
  }

  /**
   * Wait for any CAPTCHA iframe to appear on the page.
   * Detects hCaptcha, reCAPTCHA, Cloudflare Turnstile, Arkose/FunCaptcha.
   * @returns The detected captcha type or null if none found.
   */
  private async waitForCaptchaFrame(page: Page, timeout = 30000): Promise<'hcaptcha' | 'recaptcha' | 'turnstile' | 'arkose' | null> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const frames = page.frames();
      for (const frame of frames) {
        const url = frame.url().toLowerCase();
        if (url.includes('hcaptcha.com')) return 'hcaptcha';
        if (url.includes('google.com/recaptcha') || url.includes('recaptcha')) return 'recaptcha';
        if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) return 'turnstile';
        if (url.includes('arkoselabs.com') || url.includes('funcaptcha')) return 'arkose';
      }
      // Also check for captcha iframes by title attribute
      for (const selector of [
        'iframe[title*="hCaptcha" i]',
        'iframe[title*="recaptcha" i]',
        'iframe[title*="Cloudflare" i]',
        'iframe[title*="challenge" i]',
        'iframe[src*="hcaptcha" i]',
        'iframe[src*="recaptcha" i]',
        'iframe[src*="turnstile" i]',
        'iframe[src*="arkoselabs" i]',
      ]) {
        const exists = await page.locator(selector).first().isVisible().catch(() => false);
        if (exists) {
          if (selector.includes('hCaptcha') || selector.includes('hcaptcha')) return 'hcaptcha';
          if (selector.includes('recaptcha')) return 'recaptcha';
          if (selector.includes('Cloudflare') || selector.includes('turnstile')) return 'turnstile';
          if (selector.includes('arkoselabs')) return 'arkose';
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  /**
   * Checks for CAPTCHA verification and solves the CAPTCHA if needed.
   * v2: Saves debug snapshots (HTML, screenshots, request & frame logs) into debug/ folder
   * at every important step so you can inspect the actual page state.
   * Serialized via captchaMutex so only one browser session runs at a time.
   * @returns {string|null} hCaptcha token. If no verification is required, returns null
   */
  public async getCaptcha(): Promise<string|null> {
    if (!await this.captchaRequired())
      return null;

    // Serialize CAPTCHA solving — only one browser session at a time
    const releaseCaptcha = await this.captchaMutex.acquire();
    if (this.captchaMutex.queueLength > 0)
      logger.info(`CAPTCHA mutex: ${this.captchaMutex.queueLength} request(s) waiting`);

    try {
      // Re-check after acquiring the lock — a previous caller may have solved it
      if (!await this.captchaRequired())
        return null;

      return await this._solveCaptcha();
    } finally {
      releaseCaptcha();
    }
  }

  /**
   * Internal CAPTCHA-solving logic (called under captchaMutex).
   */
  private async _solveCaptcha(): Promise<string|null> {

    logger.info('CAPTCHA required. Launching browser...');
    const browser = await this.launchBrowser();
    const page = await browser.newPage();

    // Collect ALL network requests for debugging
    const requestLog: string[] = [];
    page.on('request', (req: any) => {
      const url: string = req.url();
      if (!url.startsWith('data:') && !url.endsWith('.woff2') && !url.endsWith('.woff'))
        requestLog.push(`[${new Date().toISOString()}] ${req.method()} ${url}`);
    });

    await page.goto('https://suno.com/create', {
      referer: 'https://www.google.com/',
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    logger.info('Waiting for Suno interface to load');
    // Wait for the page to actually settle
    try {
      await page.waitForLoadState('networkidle', { timeout: 30000 });
    } catch {
      logger.warn('Network did not reach idle state within 30s; continuing');
    }

    // --- Debug snapshot: page loaded ---
    await this.saveDebugSnapshot(page, '01-page-loaded', requestLog);

    if (this.ghostCursorEnabled)
      this.cursor = await createCursor(page);

    // Close any popups / modals / banners
    for (const closeSelector of [
      'button[aria-label="Close"]',
      '[aria-label="close"]',
      '[aria-label="Dismiss"]',
      'button:has-text("Got it")',
      'button:has-text("Accept")',
      'button:has-text("OK")',
    ]) {
      try {
        const closeBtn = page.locator(closeSelector).first();
        if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          await closeBtn.click({ timeout: 1000 });
          logger.info(`Closed popup via ${closeSelector}`);
        }
      } catch {}
    }

    // --- Discover the actual page structure ---
    // Log all interactive elements on the page for debugging
    try {
      const interactiveElements = await page.evaluate(() => {
        const elements: string[] = [];
        document.querySelectorAll('button, textarea, input, [contenteditable], [role="textbox"], [role="button"]').forEach((el) => {
          const tag = el.tagName.toLowerCase();
          const attrs = Array.from(el.attributes).map(a => `${a.name}="${a.value}"`).join(' ');
          const text = (el as HTMLElement).innerText?.slice(0, 50) || '';
          elements.push(`<${tag} ${attrs}> ${text}`);
        });
        return elements;
      });
      const debugDir = path.join(process.cwd(), 'debug');
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(path.join(debugDir, '02-interactive-elements.log'), interactiveElements.join('\n'));
      logger.info(`Found ${interactiveElements.length} interactive elements (see debug/02-interactive-elements.log)`);
    } catch (e: any) {
      logger.warn(`Failed to enumerate interactive elements: ${e.message}`);
    }

    // --- Step 1: Find and fill prompt input ---
    logger.info('Looking for prompt input');
    const promptSelectors = [
      '.custom-textarea',
      'textarea[placeholder*="lyrics" i]',
      'textarea[placeholder*="describe" i]',
      'textarea[placeholder*="song" i]',
      'textarea[placeholder*="prompt" i]',
      'textarea',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'div[role="textbox"]',
      'input[type="text"]',
    ];
    const promptInput = await this.waitForAnyVisibleLocator(page, promptSelectors, 15000);
    if (promptInput) {
      const desc = await promptInput.evaluate((el: Element) =>
        `${el.tagName}.${el.className} placeholder="${el.getAttribute('placeholder') || ''}"`
      ).catch(() => 'unknown');
      logger.info(`Found prompt input: ${desc}`);
      await this.click(promptInput);
      await new Promise(r => setTimeout(r, 300));
      await promptInput.pressSequentially('Lorem ipsum dolor sit amet', { delay: 60 });
    } else {
      logger.warn('No prompt input found anywhere on page');
      await this.saveDebugSnapshot(page, '03-no-prompt-input', requestLog);
    }

    // --- Step 2: Find and click the Create / Generate button ---
    logger.info('Looking for Create/Generate button');
    const buttonSelectors = [
      'button[aria-label="Create"]',
      'button:has-text("Create")',
      '[role="button"]:has-text("Create")',
      'button[type="submit"]',
      'button:has-text("Generate")',
      '[role="button"]:has-text("Generate")',
      'button:has-text("Make a song")',
      'button:has-text("Submit")',
    ];
    const button = await this.waitForAnyVisibleLocator(page, buttonSelectors, 15000);
    if (!button) {
      logger.error('Could not find any Create/Generate button');
      await this.saveDebugSnapshot(page, '04-no-create-button', requestLog);
      await browser.browser()?.close();
      throw new Error(
        'Could not find a Create/Generate button on the page. '
        + 'The Suno UI may have changed. Check the debug/ folder for HTML snapshots and screenshots.'
      );
    }

    const buttonInfo = await button.evaluate((el: Element) =>
      `<${el.tagName} class="${el.className}" aria-label="${el.getAttribute('aria-label') || ''}">${(el as HTMLElement).innerText?.slice(0, 40)}`
    ).catch(() => 'unknown');
    logger.info(`Found button: ${buttonInfo}`);

    // Set up route interception BEFORE clicking Create so we don't miss the generate call
    const controller = new AbortController();
    let rejectOuter: (err: any) => void = () => {};
    let resolveOuter: (token: string | null) => void = () => {};

    const tokenPromise = new Promise<string | null>((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;

      // Intercept the generate API call to extract the captcha token
      page.route('**/api/generate/v2/**', async (route: any) => {
        try {
          logger.info('Generate API call intercepted! Extracting token and closing browser');
          const request = route.request();
          this.currentToken = request.headers().authorization?.split('Bearer ').pop();
          const postData = request.postDataJSON();
          route.abort();
          controller.abort();
          browser.browser()?.close();
          resolve(postData?.token || null);
        } catch (err) {
          reject(err);
        }
      });
    });

    // Click the button to trigger generation (and hopefully a CAPTCHA)
    logger.info('Clicking Create button');
    await this.click(button);
    await new Promise(r => setTimeout(r, 3000)); // wait for CAPTCHA to appear

    // --- Debug snapshot: after Create click ---
    await this.saveDebugSnapshot(page, '05-after-create-click', requestLog);

    // --- Step 3: Detect what CAPTCHA appeared ---
    logger.info('Waiting for CAPTCHA challenge to appear...');
    let captchaType = await this.waitForCaptchaFrame(page, 15000);

    if (!captchaType) {
      // Try clicking the button again — sometimes the first click is swallowed
      logger.warn('No CAPTCHA detected after first click. Retrying...');
      await this.click(button);
      await new Promise(r => setTimeout(r, 5000));
      await this.saveDebugSnapshot(page, '06-after-second-click', requestLog);
      captchaType = await this.waitForCaptchaFrame(page, 20000);
    }

    if (!captchaType) {
      // Check if the generate API was called without a CAPTCHA (maybe CAPTCHA wasn't needed after all)
      logger.warn('No CAPTCHA iframe found. Checking if generation proceeded without CAPTCHA...');
      // Give the tokenPromise a chance to resolve
      const raceResult = await Promise.race([
        tokenPromise.then(t => ({ type: 'token' as const, value: t })),
        new Promise<{ type: 'timeout' }>(r => setTimeout(() => r({ type: 'timeout' }), 10000)),
      ]);
      if (raceResult.type === 'token') {
        logger.info('Generation proceeded without visible CAPTCHA');
        return raceResult.value;
      }

      // Truly no CAPTCHA and no generation
      await this.saveDebugSnapshot(page, '07-no-captcha-final', requestLog);
      await browser.browser()?.close();
      throw new Error(
        'No CAPTCHA appeared and generation did not proceed. '
        + 'The Suno UI may have changed significantly. '
        + 'Check the debug/ folder for HTML, screenshots, interactive elements, and request logs.'
      );
    }

    logger.info(`Detected CAPTCHA type: ${captchaType}`);

    if (captchaType !== 'hcaptcha') {
      // We only support hCaptcha via 2Captcha right now
      await this.saveDebugSnapshot(page, '08-unsupported-captcha', requestLog);
      await browser.browser()?.close();
      throw new Error(
        `Detected CAPTCHA type "${captchaType}" which is not currently supported. `
        + 'Only hCaptcha is supported via 2Captcha. Check debug/ folder for details.'
      );
    }

    // --- Step 4: Solve hCaptcha challenges in a loop ---
    logger.info('Starting hCaptcha solving loop');
    const captchaSolverPromise = new Promise<void>(async (resolve, reject) => {
      const frame = page.frameLocator('iframe[title*="hCaptcha"]');
      const challenge = frame.locator('.challenge-container');
      try {
        // First iteration: challenge is already loaded (images already fetched), skip waitForRequests.
        // Subsequent iterations: wait for the new challenge images to load after each submission.
        let wait = false;
        while (true) {
          if (wait)
            await waitForRequests(page, controller.signal);
          // Wait for the challenge container to be fully rendered before interacting
          await challenge.waitFor({ state: 'visible', timeout: 60000 });
          const promptText = await challenge.locator('.prompt-text').first().innerText({ timeout: 15000 }).catch(() => '');
          const drag = promptText.toLowerCase().includes('drag');
          let captcha: any;
          for (let j = 0; j < 3; j++) {
            try {
              logger.info('Sending the CAPTCHA to 2Captcha');
              const payload: paramsCoordinates = {
                body: (await challenge.screenshot({ timeout: 5000 })).toString('base64'),
                lang: process.env.BROWSER_LOCALE
              };
              if (drag) {
                payload.textinstructions = 'CLICK on the shapes at their edge or center as shown above—please be precise!';
                payload.imginstructions = (await fs.readFile(path.join(process.cwd(), 'public', 'drag-instructions.jpg'))).toString('base64');
              }
              captcha = await this.solver.coordinates(payload);
              break;
            } catch (err: any) {
              logger.info(err.message);
              if (j !== 2)
                logger.info('Retrying...');
              else
                throw err;
            }
          }
          if (drag) {
            const challengeBox = await challenge.boundingBox();
            if (challengeBox == null)
              throw new Error('.challenge-container boundingBox is null!');
            if (captcha.data.length % 2) {
              logger.info('Solution does not have even amount of points required for dragging. Requesting new solution...');
              this.solver.badReport(captcha.id);
              wait = false;
              continue;
            }
            for (let i = 0; i < captcha.data.length; i += 2) {
              const data1 = captcha.data[i];
              const data2 = captcha.data[i + 1];
              logger.info(JSON.stringify(data1) + JSON.stringify(data2));
              await page.mouse.move(challengeBox.x + +data1.x, challengeBox.y + +data1.y);
              await page.mouse.down();
              await sleep(1.1);
              await page.mouse.move(challengeBox.x + +data2.x, challengeBox.y + +data2.y, { steps: 30 });
              await page.mouse.up();
            }
            wait = true;
          } else {
            for (const data of captcha.data) {
              logger.info(data);
              await this.click(challenge, { x: +data.x, y: +data.y });
            }
            wait = true; // Wait for new challenge images after submit
          }
          this.click(frame.locator('.button-submit')).catch(e => {
            if (e.message.includes('viewport'))
              this.click(button);
            else
              throw e;
          });
        }
      } catch (e: any) {
        if (e.message.includes('been closed') || e.message === 'AbortError')
          resolve();
        else
          reject(e);
      }
    });

    // Wire captcha solver errors into the token promise
    captchaSolverPromise.catch(e => {
      browser.browser()?.close();
      rejectOuter(e);
    });

    // Prevent unhandled rejection on the solver promise
    captchaSolverPromise.catch(() => {});

    return tokenPromise;
  }

  /**
   * Imitates Cloudflare Turnstile loading error. Unused right now, left for future
   */
  private async getTurnstile() {
    return this.client.post(
      `https://clerk.suno.com/v1/client?__clerk_api_version=2021-02-05&_clerk_js_version=${SunoApi.CLERK_VERSION}&_method=PATCH`,
      { captcha_error: '300030,300030,300030' },
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }

  /**
   * Generate a song based on the prompt.
   * @param prompt The text prompt to generate audio from.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @returns
   */
  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      false,
      undefined,
      undefined,
      make_instrumental,
      model,
      wait_audio
    );
    const costTime = Date.now() - startTime;
    logger.info('Generate Response:\n' + JSON.stringify(audios, null, 2));
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Calls the concatenate endpoint for a clip to generate the whole song.
   * @param clip_id The ID of the audio clip to concatenate.
   * @returns A promise that resolves to an AudioInfo object representing the concatenated audio.
   * @throws Error if the response status is not 200.
   */
  public async concatenate(clip_id: string): Promise<AudioInfo> {
    await this.keepAlive(false);
    const payload: any = { clip_id: clip_id };

    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/concat/v2/`,
      payload,
      {
        timeout: 10000 // 10 seconds timeout
      }
    );
    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }
    return response.data;
  }

  /**
   * Generates custom audio based on provided parameters.
   *
   * @param prompt The text prompt to generate audio from.
   * @param tags Tags to categorize the generated audio.
   * @param title The title for the generated audio.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated audios.
   */
  public async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      true,
      tags,
      title,
      make_instrumental,
      model,
      wait_audio,
      negative_tags
    );
    const costTime = Date.now() - startTime;
    logger.info(
      'Custom Generate Response:\n' + JSON.stringify(audios, null, 2)
    );
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Generates songs based on the provided parameters.
   *
   * @param prompt The text prompt to generate songs from.
   * @param isCustom Indicates if the generation should consider custom parameters like tags and title.
   * @param tags Optional tags to categorize the song, used only if isCustom is true.
   * @param title Optional title for the song, used only if isCustom is true.
   * @param make_instrumental Indicates if the generated song should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @param task Optional indication of what to do. Enter 'extend' if extending an audio, otherwise specify null.
   * @param continue_clip_id 
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated songs.
   */
  private async generateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    make_instrumental?: boolean,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    task?: string,
    continue_clip_id?: string,
    continue_at?: number
  ): Promise<AudioInfo[]> {
    const reqId = ++this.requestCounter;
    const release = await this.requestSemaphore.acquire();
    logger.info(
      `[req-${reqId}] Acquired slot (active: ${this.requestSemaphore.activeCount}, waiting: ${this.requestSemaphore.waitingCount})`
    );

    try {
      await this.keepAlive();
    const payload: any = {
      make_instrumental: make_instrumental,
      mv: model || DEFAULT_MODEL,
      prompt: '',
      generation_type: 'TEXT',
      continue_at: continue_at,
      continue_clip_id: continue_clip_id,
      task: task,
      token: await this.getCaptcha()
    };
    if (isCustom) {
      payload.tags = tags;
      payload.title = title;
      payload.negative_tags = negative_tags;
      payload.prompt = prompt;
    } else {
      payload.gpt_description_prompt = prompt;
    }
    logger.info(
      `[req-${reqId}] generateSongs payload:\n` +
        JSON.stringify(
          {
            prompt: prompt,
            isCustom: isCustom,
            tags: tags,
            title: title,
            make_instrumental: make_instrumental,
            wait_audio: wait_audio,
            negative_tags: negative_tags,
            payload: payload
          },
          null,
          2
        )
    );
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/v2/`,
      payload,
      {
        timeout: 10000 // 10 seconds timeout
      }
    );
    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }
    const songIds = response.data.clips.map((audio: any) => audio.id);
    //Want to wait for music file generation
    if (wait_audio) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(5, 5);
      while (Date.now() - startTime < 100000) {
        const response = await this.get(songIds);
        const allCompleted = response.every(
          (audio) => audio.status === 'streaming' || audio.status === 'complete'
        );
        const allError = response.every((audio) => audio.status === 'error');
        if (allCompleted || allError) {
          return response;
        }
        lastResponse = response;
        await sleep(3, 6);
        await this.keepAlive(true);
      }
      return lastResponse;
    } else {
      return response.data.clips.map((audio: any) => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt,
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: audio.metadata.gpt_description_prompt,
        prompt: audio.metadata.prompt,
        type: audio.metadata.type,
        tags: audio.metadata.tags,
        negative_tags: audio.metadata.negative_tags,
        duration: audio.metadata.duration
      }));
    }
    } finally {
      logger.info(`[req-${reqId}] Released slot`);
      release();
    }
  }

  /**
   * Generates lyrics based on a given prompt.
   * @param prompt The prompt for generating lyrics.
   * @returns The generated lyrics text.
   */
  public async generateLyrics(prompt: string): Promise<string> {
    await this.keepAlive(false);
    // Initiate lyrics generation
    const generateResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/lyrics/`,
      { prompt }
    );
    const generateId = generateResponse.data.id;

    // Poll for lyrics completion
    let lyricsResponse = await this.client.get(
      `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
    );
    while (lyricsResponse?.data?.status !== 'complete') {
      await sleep(2); // Wait for 2 seconds before polling again
      lyricsResponse = await this.client.get(
        `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
      );
    }

    // Return the generated lyrics text
    return lyricsResponse.data;
  }

  /**
   * Extends an existing audio clip by generating additional content based on the provided prompt.
   *
   * @param audioId The ID of the audio clip to extend.
   * @param prompt The prompt for generating additional content.
   * @param continueAt Extend a new clip from a song at mm:ss(e.g. 00:30). Default extends from the end of the song.
   * @param tags Style of Music.
   * @param title Title of the song.
   * @returns A promise that resolves to an AudioInfo object representing the extended audio clip.
   */
  public async extendAudio(
    audioId: string,
    prompt: string = '',
    continueAt: number,
    tags: string = '',
    negative_tags: string = '',
    title: string = '',
    model?: string,
    wait_audio?: boolean
  ): Promise<AudioInfo[]> {
    return this.generateSongs(prompt, true, tags, title, false, model, wait_audio, negative_tags, 'extend', audioId, continueAt);
  }

  /**
   * Generate stems for a song.
   * @param song_id The ID of the song to generate stems for.
   * @returns A promise that resolves to an AudioInfo object representing the generated stems.
   */
  public async generateStems(song_id: string): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/edit/stems/${song_id}`, {}
    );

    console.log('generateStems response:\n', response?.data);
    return response.data.clips.map((clip: any) => ({
      id: clip.id,
      status: clip.status,
      created_at: clip.created_at,
      title: clip.title,
      stem_from_id: clip.metadata.stem_from_id,
      duration: clip.metadata.duration
    }));
  }


  /**
   * Get the lyric alignment for a song.
   * @param song_id The ID of the song to get the lyric alignment for.
   * @returns A promise that resolves to an object containing the lyric alignment.
   */
  public async getLyricAlignment(song_id: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/gen/${song_id}/aligned_lyrics/v2/`);

    console.log(`getLyricAlignment ~ response:`, response.data);
    return response.data?.aligned_words.map((transcribedWord: any) => ({
      word: transcribedWord.word,
      start_s: transcribedWord.start_s,
      end_s: transcribedWord.end_s,
      success: transcribedWord.success,
      p_align: transcribedWord.p_align
    }));
  }

  /**
   * Processes the lyrics (prompt) from the audio metadata into a more readable format.
   * @param prompt The original lyrics text.
   * @returns The processed lyrics text.
   */
  private parseLyrics(prompt: string): string {
    // Assuming the original lyrics are separated by a specific delimiter (e.g., newline), we can convert it into a more readable format.
    // The implementation here can be adjusted according to the actual lyrics format.
    // For example, if the lyrics exist as continuous text, it might be necessary to split them based on specific markers (such as periods, commas, etc.).
    // The following implementation assumes that the lyrics are already separated by newlines.

    // Split the lyrics using newline and ensure to remove empty lines.
    const lines = prompt.split('\n').filter((line) => line.trim() !== '');

    // Reassemble the processed lyrics lines into a single string, separated by newlines between each line.
    // Additional formatting logic can be added here, such as adding specific markers or handling special lines.
    return lines.join('\n');
  }

  /**
   * Retrieves audio information for the given song IDs.
   * @param songIds An optional array of song IDs to retrieve information for.
   * @param page An optional page number to retrieve audio information from.
   * @returns A promise that resolves to an array of AudioInfo objects.
   */
  public async get(
    songIds?: string[],
    page?: string | null
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    let url = new URL(`${SunoApi.BASE_URL}/api/feed/v2`);
    if (songIds) {
      url.searchParams.append('ids', songIds.join(','));
    }
    if (page) {
      url.searchParams.append('page', page);
    }
    logger.info('Get audio status: ' + url.href);
    const response = await this.client.get(url.href, {
      // 10 seconds timeout
      timeout: 10000
    });

    const audios = response.data.clips;

    return audios.map((audio: any) => ({
      id: audio.id,
      title: audio.title,
      image_url: audio.image_url,
      lyric: audio.metadata.prompt
        ? this.parseLyrics(audio.metadata.prompt)
        : '',
      audio_url: audio.audio_url,
      video_url: audio.video_url,
      created_at: audio.created_at,
      model_name: audio.model_name,
      status: audio.status,
      gpt_description_prompt: audio.metadata.gpt_description_prompt,
      prompt: audio.metadata.prompt,
      type: audio.metadata.type,
      tags: audio.metadata.tags,
      duration: audio.metadata.duration,
      error_message: audio.metadata.error_message
    }));
  }

  /**
   * Retrieves information for a specific audio clip.
   * @param clipId The ID of the audio clip to retrieve information for.
   * @returns A promise that resolves to an object containing the audio clip information.
   */
  public async getClip(clipId: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/clip/${clipId}`
    );
    return response.data;
  }

  public async get_credits(): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/billing/info/`
    );
    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage
    };
  }

  public async getPersonaPaginated(personaId: string, page: number = 1): Promise<PersonaResponse> {
    await this.keepAlive(false);
    
    const url = `${SunoApi.BASE_URL}/api/persona/get-persona-paginated/${personaId}/?page=${page}`;
    
    logger.info(`Fetching persona data: ${url}`);
    
    const response = await this.client.get(url, {
      timeout: 10000 // 10 seconds timeout
    });

    if (response.status !== 200) {
      throw new Error('Error response: ' + response.statusText);
    }

    return response.data;
  }
}

export const sunoApi = async (cookie?: string) => {
  const resolvedCookie = cookie && cookie.includes('__client') ? cookie : process.env.SUNO_COOKIE; // Check for bad `Cookie` header (It's too expensive to actually parse the cookies *here*)
  if (!resolvedCookie) {
    logger.info('No cookie provided! Aborting...\nPlease provide a cookie either in the .env file or in the Cookie header of your request.')
    throw new Error('Please provide a cookie either in the .env file or in the Cookie header of your request.');
  }

  // Check if the instance for this cookie already exists in the cache
  const cachedInstance = cache.get(resolvedCookie);
  if (cachedInstance)
    return cachedInstance;

  // If not, create a new instance and initialize it
  const instance = await new SunoApi(resolvedCookie).init();
  // Cache the initialized instance
  cache.set(resolvedCookie, instance);

  return instance;
};