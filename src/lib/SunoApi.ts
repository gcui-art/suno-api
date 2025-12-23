import axios, { AxiosInstance } from 'axios';
import UserAgent from 'user-agents';
import pino from 'pino';
import yn from 'yn';
import { isPage, sleep, waitForRequests } from '@/lib/utils';
import * as cookie from 'cookie';
import { randomUUID } from 'node:crypto';
import { Solver } from '@2captcha/captcha-solver';
import { paramsCoordinates } from '@2captcha/captcha-solver/dist/structs/2captcha';
import { BrowserContext, Page, Locator, chromium, firefox } from 'rebrowser-playwright-core';
import { createCursor, Cursor } from 'ghost-cursor-playwright';
import { promises as fs } from 'fs';
import path from 'node:path';
// Remove: import { expect } from '@playwright/test';

// sunoApi instance caching
const globalForSunoApi = global as unknown as { sunoApiCache?: Map<string, SunoApi> };
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;

// For persistent Playwright context reuse via CDP
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare global { var __cdpContext: any; }

const logger = pino();

// Model versions
export const MODEL_V5 = 'chirp-crow';   // v5 - uses /api/generate/v2-web/
export const MODEL_V4_5 = 'chirp-auk';  // v4.5 - uses /api/generate/v2/
export const DEFAULT_MODEL = MODEL_V5;  // Default to v5

// Helper to determine if a model uses the v2-web endpoint
function isV5Model(model: string): boolean {
  return model === MODEL_V5 || model === 'chirp-crows'; // Accept both spellings
}

// Helper function to parse moderation error messages and extract problematic words
function parseModerationError(errorMessage: string): { field: 'tags' | 'gpt_description_prompt', word: string } | null {
  if (!errorMessage) return null;
  
  // Pattern: "Tags contained <type>: <word>" or "Song Description contained <type>: <word>"
  const tagsMatch = errorMessage.match(/Tags contained (?:artist name|producer tag|song title|band name): (.+)/i);
  const descriptionMatch = errorMessage.match(/Song Description contained (?:artist name|producer tag|song title|band name): (.+)/i);
  
  // Additional patterns to catch more moderation errors
  const tagsContainedMatch = errorMessage.match(/Tags.*contained.*: (.+)/i);
  const descriptionContainedMatch = errorMessage.match(/(?:Song Description|Description).*contained.*: (.+)/i);
  
  if (tagsMatch) {
    return { field: 'tags', word: tagsMatch[1].trim() };
  } else if (descriptionMatch) {
    return { field: 'gpt_description_prompt', word: descriptionMatch[1].trim() };
  } else if (tagsContainedMatch) {
    return { field: 'tags', word: tagsContainedMatch[1].trim() };
  } else if (descriptionContainedMatch) {
    return { field: 'gpt_description_prompt', word: descriptionContainedMatch[1].trim() };
  }
  
  // Log unrecognized patterns for debugging
  if (errorMessage.toLowerCase().includes('contained')) {
    logger.warn(`Unrecognized moderation error pattern: ${errorMessage}`);
  }
  
  return null;
}

// Helper function to remove a word from text, handling hyphenation and case variations
function removeProblematicWord(text: string, word: string): string {
  if (!text || !word) return text;

  const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalizedWord = word.toLowerCase().replace(/[-\s]+/g, "");

  let result = text;

  // Try multiple removal strategies
  
  // 1. Direct whole-word match (handles simple cases)
  const directRegex = new RegExp(`\\b${escapeRegex(word)}\\b`, "gi");
  result = result.replace(directRegex, "");

  // 2. Case-insensitive match
  const caseInsensitiveRegex = new RegExp(`\\b${escapeRegex(word)}\\b`, "gi");
  result = result.replace(caseInsensitiveRegex, "");

  // 3. Handle hyphenated versions (e.g., "the-hatters" -> "the hatters")
  const hyphenatedWord = word.replace(/\s+/g, "-");
  const hyphenRegex = new RegExp(`\\b${escapeRegex(hyphenatedWord)}\\b`, "gi");
  result = result.replace(hyphenRegex, "");

  // 4. Handle spaced versions (e.g., "the hatters" -> "the-hatters")
  const spacedWord = word.replace(/-+/g, " ");
  const spaceRegex = new RegExp(`\\b${escapeRegex(spacedWord)}\\b`, "gi");
  result = result.replace(spaceRegex, "");

  // 5. Flexible pattern matching for complex cases
  if (normalizedWord.length > 2) {
    const charsPattern = normalizedWord.split("").map(ch => escapeRegex(ch)).join("[\\s-]*");
    const flexibleRegex = new RegExp(charsPattern, "gi");
    result = result.replace(flexibleRegex, "");
  }

  // 6. Remove partial matches at word boundaries
  const partialRegex = new RegExp(`\\b[^\\s]*${escapeRegex(word)}[^\\s]*\\b`, "gi");
  result = result.replace(partialRegex, "");

  // Clean up the result
  result = result
    .replace(/\s+/g, " ")           // Collapse multiple spaces
    .replace(/-\s*-+/g, "-")        // Fix multiple hyphens
    .replace(/,\s*,/g, ",")         // Fix multiple commas
    .replace(/\s+,/g, ",")          // Fix spaces before commas
    .replace(/,\s*$/g, "")          // Remove trailing commas
    .replace(/^\s*,/g, "")          // Remove leading commas
    .replace(/\s*\.\s*\./g, ".")    // Fix multiple periods
    .replace(/\s+\./g, ".")         // Fix spaces before periods
    .trim();

  return result;
}

// Helper that attempts to remove a problematic phrase; if exact removal fails, it tries fallbacks like possessive or individual tokens
function removeProblematicPhrase(text: string, phrase: string): { cleaned: string; changed: boolean } {
  if (!text || !phrase) return { cleaned: text, changed: false };

  const placeholder = '[WORD]';
  let changed = false;
  let cleaned = text;

  const applyMask = (target: string, pattern: RegExp): string => {
    return target.replace(pattern, (match) => {
      changed = true;
      return placeholder;
    });
  };

  const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalized = phrase.trim();

  // Build a flexible pattern similar to removeProblematicWord but capture whole phrase
  const flexiblePatternChars = normalized
    .toLowerCase()
    .replace(/[-\s]+/g, '')
    .split('')
    .map((ch) => escapeRegex(ch))
    .join('[\\s-]*');
  const flexibleRegex = new RegExp(flexiblePatternChars, 'gi');

  // direct whole phrase
  const directRegex = new RegExp(escapeRegex(normalized), 'gi');

  // possessive, plural, leading 'the '
  const variants: string[] = [];
  if (/^the\s+/i.test(normalized)) variants.push(normalized.replace(/^the\s+/i, ''));
  variants.push(normalized.replace(/[’']s$/i, ''));
  variants.push(normalized.replace(/s$/i, ''));

  // Apply masking
  cleaned = applyMask(cleaned, directRegex);
  cleaned = applyMask(cleaned, flexibleRegex);

  for (const v of variants) {
    if (!v) continue;
    const r = new RegExp(escapeRegex(v), 'gi');
    cleaned = applyMask(cleaned, r);
  }

  // Individual token masking (skip stop words)
  const tokens = normalized.split(/[^A-Za-z0-9]+/).filter(tok => tok.length > 2 && tok.toLowerCase() !== 'the');
  for (const tok of tokens) {
    const r = new RegExp(escapeRegex(tok), 'gi');
    cleaned = applyMask(cleaned, r);
  }

  return { cleaned, changed };
}

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
  private static CLERK_BASE_URL: string = 'https://auth.suno.com';
  private static CLERK_VERSION = '5.112.1';
  private static CLERK_API_VERSION = '2025-11-10';

  private readonly client: AxiosInstance;
  private sid?: string;
  private currentToken?: string;
  private deviceId?: string;
  private userAgent?: string;
  private cookies: Record<string, string | undefined>;
  private solver = new Solver(process.env.TWOCAPTCHA_KEY + '');
  private ghostCursorEnabled = yn(process.env.BROWSER_GHOST_CURSOR, { default: false });
  private cursor?: Cursor;

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
    let sessionResponse;
    try {
      sessionResponse = await this.client.get(getSessionUrl, {
        headers: { Authorization: this.cookies.__client }
      });
    } catch (error: any) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        throw new Error(
          'Authentication failed. Your SUNO_COOKIE appears to be invalid or expired. Please get a fresh cookie while logged into suno.com'
        );
      }
      throw error;
    }
    
    if (!sessionResponse?.data?.response?.last_active_session_id) {
      const hasClient = !!this.cookies.__client;
      const sessions = sessionResponse?.data?.response?.sessions || [];
      throw new Error(
        `Failed to get session id. Your cookie ${hasClient ? 'has __client but' : 'is missing __client cookie'}. ` +
        `Active sessions: ${sessions.length}. ` +
        `Please ensure you are LOGGED IN to suno.com when extracting the cookie. ` +
        `Visit https://suno.com/create, log in, then extract a fresh cookie from the Network tab.`
      );
    }
    // Save session ID for later use
    this.sid = sessionResponse.data.response.last_active_session_id;
  }

  /**
   * Keep the session alive.
   * @param isWait Indicates if the method should wait for the session to be fully renewed before returning.
   */
  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }
    // URL to renew session token
    const renewUrl = `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?__clerk_api_version=${SunoApi.CLERK_API_VERSION}&_clerk_js_version=${SunoApi.CLERK_VERSION}&_is_native=true`;
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
    logger.info(`CAPTCHA check response: ${JSON.stringify(resp.data)}`);
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
    // Check if CDP_BROWSER_ENDPOINT is set to connect to existing browser
    const cdpEndpoint = process.env.CDP_BROWSER_ENDPOINT;
    if (cdpEndpoint) {
      // Fix localhost to use IPv4 explicitly
      const fixedEndpoint = cdpEndpoint.replace('localhost', '127.0.0.1');
      console.log('Connecting to persistent browser via CDP:', fixedEndpoint);
      logger.info(`Connecting to persistent browser via CDP: ${fixedEndpoint}`);
      // Use a static variable to cache the context
      if (!(global as any).__cdpContext) {
        const browser = await chromium.connectOverCDP(fixedEndpoint);
        // Use the first context if available, otherwise create a new one
        let context: BrowserContext;
        if (browser.contexts().length > 0) {
          context = browser.contexts()[0];
          console.log('Reusing existing persistent browser context');
        } else {
          context = await browser.newContext({
            userAgent: this.userAgent,
            locale: process.env.BROWSER_LOCALE,
            viewport: null
          });
          console.log('Created new persistent browser context');
        }
        (global as any).__cdpContext = context;
      }
      return (global as any).__cdpContext;
    }

    // Original browser launch code (fallback)
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
   * Checks for CAPTCHA verification and solves the CAPTCHA if needed
   * @returns {string|null} hCaptcha token. If no verification is required, returns null
   */
  public async getCaptcha(): Promise<string|null> {
    // Skip CAPTCHA entirely when using CDP connection with authenticated browser
    // if (process.env.CDP_BROWSER_ENDPOINT) {
    //   logger.info('Using authenticated browser via CDP - skipping CAPTCHA');
    //   return null;
    // }
    console.log("getCaptcha");
    
    if (!await this.captchaRequired())
      return null;

    logger.info('CAPTCHA required. Launching browser...')
    const browser = await this.launchBrowser();
    // Find an existing /create tab if available
    let page = (await browser.pages()).find(p => p.url().includes('/create'));
    if (!page) {
      console.log("No existing /create tab found, creating new page...");
      page = await browser.newPage();
      await page.goto('https://suno.com/create', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });
    } else {
      console.log("Existing /create tab found, bringing to front...");
      await page.bringToFront();
    }

    // Forward browser console logs to the Node.js terminal
    page.on('console', msg => {
      console.log(`[browser console.${msg.type()}]`, msg.text());
    });

    await page.goto('https://suno.com/create', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });

    logger.info('Waiting for Suno interface to load');
    // await page.locator('.react-aria-GridList').waitFor({ timeout: 60000 });
    await page.waitForResponse('**/api/project/**\\?**', { timeout: 60000 }); // wait for song list API call

    if (this.ghostCursorEnabled)
      this.cursor = await createCursor(page);
    
    logger.info('Triggering the CAPTCHA');
    try {
      await page.getByLabel('Close').click({ timeout: 2000 }); // close all popups
      // await this.click(page, { x: 318, y: 13 });
    } catch(e) {}

    console.log("Locating textarea...");
    const textarea = page.locator('.custom-textarea');
    console.log("Filling textarea with 'Test song'...");
    await textarea.fill('Test song');
    console.log("Blurring textarea to trigger React validation...");
    await textarea.blur(); // Triggers React validation if needed

    console.log("Locating create button...");
    const button = page.locator('button[data-testid="create-button"]');
    console.log("Waiting for create button to be visible...");
    await button.waitFor({ state: 'visible', timeout: 10000 });
    // Wait until enabled
    const start = Date.now();
    console.log("Waiting for create button to be enabled...");
    while (!(await button.isEnabled())) {
      if (Date.now() - start > 10000) {
        console.log("Create button not enabled after 10s, throwing error.");
        throw new Error('Create button not enabled after 10s');
      }
      await page.waitForTimeout(200);
    }
    console.log("Clicking create button...");
    await button.click();

    let captchaToken = null;
    try {
      captchaToken = await waitForCaptchaRequest(page, 45000); // Wait for hCaptcha for 45s
    } catch (e) {
      console.log('No hCaptcha request detected within 45s, will signal NO_CAPTCHA');
      return 'NO_CAPTCHA';
    }

    const controller = new AbortController();
    new Promise<void>(async (resolve, reject) => {
      const frame = page.frameLocator('iframe[title*="hCaptcha"]');
      const challenge = frame.locator('.challenge-container');
      try {
        let wait = true;
        while (true) {
          if (wait)
            await waitForRequests(page, controller.signal);
          const drag = (await challenge.locator('.prompt-text').first().innerText()).toLowerCase().includes('drag');
          let captcha: any;
          for (let j = 0; j < 3; j++) { // try several times because sometimes 2Captcha could return an error
            try {
              logger.info('Sending the CAPTCHA to 2Captcha');
              const payload: paramsCoordinates = {
                body: (await challenge.screenshot({ timeout: 5000 })).toString('base64'),
                lang: process.env.BROWSER_LOCALE
              };
              if (drag) {
                // Say to the worker that he needs to click
                payload.textinstructions = 'CLICK on the shapes at their edge or center as shown above—please be precise!';
                payload.imginstructions = (await fs.readFile(path.join(process.cwd(), 'public', 'drag-instructions.jpg'))).toString('base64');
              }
              captcha = await this.solver.coordinates(payload);
              break;
            } catch(err: any) {
              logger.info(err.message);
              if (j != 2)
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
              const data2 = captcha.data[i+1];
              logger.info(JSON.stringify(data1) + JSON.stringify(data2));
              await page.mouse.move(challengeBox.x + +data1.x, challengeBox.y + +data1.y);
              await page.mouse.down();
              await sleep(1.1); // wait for the piece to be 'unlocked'
              await page.mouse.move(challengeBox.x + +data2.x, challengeBox.y + +data2.y, { steps: 30 });
              await page.mouse.up();
            }
            wait = true;
          } else {
            for (const data of captcha.data) {
              logger.info(data);
              await this.click(challenge, { x: +data.x, y: +data.y });
            };
          }
          this.click(frame.locator('.button-submit')).catch(e => {
            if (e.message.includes('viewport')) // when hCaptcha window has been closed due to inactivity,
              this.click(button); // click the Create button again to trigger the CAPTCHA
            else
              throw e;
          });
        }
      } catch(e: any) {
        if (e.message.includes('been closed') // catch error when closing the browser
          || e.message == 'AbortError') // catch error when waitForRequests is aborted
          resolve();
        else
          reject(e);
      }
    }).catch(e => {
      browser.browser()?.close();
      throw e;
    });
    return (new Promise((resolve, reject) => {
      page.route('**/api/generate/v2*/**', async (route: any) => {  // Catches both /v2/ and /v2-web/
        try {
          logger.info('hCaptcha token received. Closing browser');
          route.abort();
          browser.browser()?.close();
          controller.abort();
          const request = route.request();
          this.currentToken = request.headers().authorization.split('Bearer ').pop();
          resolve(request.postDataJSON().token);
        } catch(err) {
          reject(err);
        }
      });
    }));
  }

  /**
   * Imitates Cloudflare Turnstile loading error. Unused right now, left for future
   */
  private async getTurnstile() {
    return this.client.post(
      `${SunoApi.CLERK_BASE_URL}/v1/client?__clerk_api_version=${SunoApi.CLERK_API_VERSION}&_clerk_js_version=${SunoApi.CLERK_VERSION}&_method=PATCH`,
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
   * @param gpt_description_prompt Optional GPT description for auto-generated lyrics.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated audios.
   */
  public async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    gpt_description_prompt?: string
  ): Promise<AudioInfo[]> {
    logger.info(`custom_generate called with gpt_description_prompt: ${gpt_description_prompt}`);
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      true,
      tags,
      title,
      make_instrumental,
      model,
      wait_audio,
      negative_tags,
      undefined, // task
      undefined, // continue_clip_id
      undefined, // continue_at
      gpt_description_prompt
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
    continue_at?: number,
    gpt_description_prompt?: string
  ): Promise<AudioInfo[]> {
    logger.info(`generateSongs called with gpt_description_prompt: ${gpt_description_prompt}, isCustom: ${isCustom}`);
    await this.keepAlive();
    
    // Determine model and endpoint
    const actualModel = model || DEFAULT_MODEL;
    const generateEndpoint = isV5Model(actualModel) 
      ? `${SunoApi.BASE_URL}/api/generate/v2-web/` 
      : `${SunoApi.BASE_URL}/api/generate/v2/`;
    logger.info(`Using model: ${actualModel}, endpoint: ${generateEndpoint}`);
    
    let payload: any = {
      make_instrumental: make_instrumental,
      mv: actualModel,
      prompt: '',
      generation_type: 'TEXT',
      continue_at: continue_at,
      continue_clip_id: continue_clip_id,
      task: task
    };
    let response;
    let captchaToken = await this.getCaptcha();
    if (captchaToken === 'NO_CAPTCHA') {
      // Wait a short delay and retry the song submission once
      await sleep(2, 3);
      try {
        response = await this.client.post(
          generateEndpoint,
          payload,
          {
            timeout: 10000 // 10 seconds timeout
          }
        );
      } catch (retryError) {
        throw new Error('Song submission failed after retry with no hCaptcha.');
      }
    }
    // Only include token if we have one (not using CDP authenticated browser)
    if (captchaToken !== null) {
      payload.token = captchaToken;
    }
    if (isCustom) {
      payload.tags = tags;
      payload.title = title;
      payload.negative_tags = negative_tags;
      payload.override_fields = ["tags"];
      // If gpt_description_prompt is provided, use it for auto-generated lyrics
      if (gpt_description_prompt) {
        payload.gpt_description_prompt = gpt_description_prompt;
        payload.prompt = '';  // Empty prompt for auto-generated lyrics
        logger.info(`Setting gpt_description_prompt in payload: ${gpt_description_prompt}`);
      } else {
        payload.prompt = prompt;  // Use explicit lyrics
      }
    } else {
      payload.gpt_description_prompt = prompt;
    }
    console.log('payload', payload);
    logger.info({
      level: 30,
      msg: "Final payload before sending",
      payload
    });
    try {
      response = await this.client.post(
        generateEndpoint,
        payload,
        {
          timeout: 10000 // 10 seconds timeout
        }
      );
    } catch (error: any) {
      // Only handle 422 with token validation failed
      if (error.response && error.response.status === 422 && error.response.data && error.response.data.detail === 'Token validation failed.') {
        logger.info('422 Token validation failed. Triggering hcaptcha fallback.');
        console.log('generateSongs: 422 fallback triggered');
        // Trigger hcaptcha by sending a 'test' song description via the UI
        this.currentToken = undefined; // Clear any bad token
        // Force hcaptcha by calling getCaptcha with a UI trigger
        await this.solveCaptchaWithTestPrompt();
        // Try again with a new token
        captchaToken = await this.getCaptcha();
        if (captchaToken !== null) {
          payload.token = captchaToken;
        } else {
          delete payload.token;
        }
        response = await this.client.post(
          generateEndpoint,
          payload,
          {
            timeout: 10000 // 10 seconds timeout
          }
        );
      } else {
        throw error;
      }
    }
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
        if (allCompleted) {
          return response;
        }
        if (allError) {
          // Check if all errors are moderation failures
          const moderationFailures = response.filter((audio) => 
            audio.error_message && audio.error_message.includes('contain')
          );
          
          if (moderationFailures.length === response.length && moderationFailures.length > 0) {
            // All failures are moderation failures, try to clean and retry
            logger.info('All songs failed due to moderation. Attempting to clean payload and retry.');
            
            let cleanedPayload = false;
            const originalTags = payload.tags;
            const originalGptPrompt = payload.gpt_description_prompt;
            
            // Process all moderation failures to clean the payload
            for (const audio of moderationFailures) {
              if (audio.error_message) {
                const errorInfo = parseModerationError(audio.error_message);
                if (errorInfo) {
                  logger.info(`Removing problematic word "${errorInfo.word}" from ${errorInfo.field}`);
                  
                  if (errorInfo.field === 'tags' && payload.tags) {
                    const { cleaned: newTags, changed } = removeProblematicPhrase(payload.tags, errorInfo.word);
                    if (changed) {
                      payload.tags = newTags;
                      cleanedPayload = true;
                    }
                  } else if (errorInfo.field === 'gpt_description_prompt' && payload.gpt_description_prompt) {
                    const { cleaned: newPrompt, changed } = removeProblematicPhrase(payload.gpt_description_prompt, errorInfo.word);
                    if (changed) {
                      payload.gpt_description_prompt = newPrompt;
                      cleanedPayload = true;
                    }
                  }
                }
              }
            }
            
            if (cleanedPayload) {
              // Retry with cleaned payload
              logger.info('Retrying with cleaned payload...');
              logger.info(`Original tags: "${originalTags}"`);
              logger.info(`Cleaned tags: "${payload.tags}"`);
              if (originalGptPrompt) {
                logger.info(`Original gpt_description_prompt: "${originalGptPrompt}"`);
                logger.info(`Cleaned gpt_description_prompt: "${payload.gpt_description_prompt}"`);
              }
              
              try {
                // Get new token if needed
                if (captchaToken !== null && captchaToken !== 'NO_CAPTCHA') {
                  captchaToken = await this.getCaptcha();
                  if (captchaToken !== null && captchaToken !== 'NO_CAPTCHA') {
                    payload.token = captchaToken;
                  } else {
                    delete payload.token;
                  }
                }
                
                const retryResponse = await this.client.post(
                  generateEndpoint,
                  payload,
                  { timeout: 10000 }
                );
                
                if (retryResponse.status === 200) {
                  // Update songIds with new response
                  const newSongIds = retryResponse.data.clips.map((audio: any) => audio.id);
                  logger.info(`Moderation retry successful. New song IDs: ${newSongIds.join(', ')}`);
                  // Continue with the new song IDs
                  songIds.length = 0;
                  songIds.push(...newSongIds);
                  await sleep(5, 5);
                  continue; // Continue the wait loop with new songs
                }
              } catch (retryError: any) {
                logger.error('Moderation retry failed:', retryError.message);
                // Continue to return the original error response
              }
            } else {
              logger.warn('Could not clean payload for moderation retry');
            }
          }
          
          // Print the full error response in red and a clear failure message
          console.log('\x1b[31m%s\x1b[0m', 'FAILED RESPONSE: ' + JSON.stringify(response, null, 2));
          console.log('\x1b[31m%s\x1b[0m', 'SONG GENERATION FAILED.');
          return response;
        }
        lastResponse = response;
        await sleep(3, 6);
        await this.keepAlive(true);
      }
      // After timeout, check if all are error
      if (lastResponse.every((audio) => audio.status === 'error')) {
        // Check if all errors are moderation failures (same logic as above)
        const moderationFailures = lastResponse.filter((audio) => 
          audio.error_message && audio.error_message.includes('contain')
        );
        
        if (moderationFailures.length === lastResponse.length && moderationFailures.length > 0) {
          logger.info('All songs failed due to moderation after timeout. Could retry with cleaned payload.');
        }
        
        console.log('\x1b[31m%s\x1b[0m', 'FAILED RESPONSE: ' + JSON.stringify(lastResponse, null, 2));
        console.log('\x1b[31m%s\x1b[0m', 'SONG GENERATION FAILED.');
        return lastResponse;
      }
      // Otherwise, return whatever we got
      return lastResponse;
    } else {
      // For non-wait_audio, we poll a few times to catch and handle chained moderation failures.
      let currentSongIds = response.data.clips.map((a: any) => a.id);
      let finalClips = response.data.clips;
      let currentPayload = { ...payload };

      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(2, 3); // Wait a bit for status to update.

        const pollResp = await this.get(currentSongIds);

        // If any song is not in an error state, assume it's processing or complete. Stop retrying.
        if (!pollResp.every(c => c.status === 'error')) {
          finalClips = pollResp;
          break;
        }

        const moderationFailures = pollResp.filter(a => a.error_message?.includes('contain'));
        
        // If not all errors are moderation-related, stop retrying.
        if (moderationFailures.length !== pollResp.length) {
          finalClips = pollResp;
          break;
        }

        logger.info(`Quick moderation attempt ${attempt + 1}: cleaning payload and retrying...`);
        let cleaned = false;
        
        for (const audio of moderationFailures) {
          const info = parseModerationError(audio.error_message || '');
          if (!info) continue;

          logger.info(`Cleaning "${info.word}" from ${info.field}`);

          if (info.field === 'tags' && currentPayload.tags) {
            const res = removeProblematicPhrase(currentPayload.tags, info.word);
            if (res.changed) {
              currentPayload.tags = res.cleaned;
              cleaned = true;
            }
          } else if (info.field === 'gpt_description_prompt' && currentPayload.gpt_description_prompt) {
            const res = removeProblematicPhrase(currentPayload.gpt_description_prompt, info.word);
            if (res.changed) {
              currentPayload.gpt_description_prompt = res.cleaned;
              cleaned = true;
            }
          }
        }
        
        if (!cleaned) {
          logger.warn('Quick moderation retry: could not clean payload, aborting.');
          finalClips = pollResp; // Return last known failing clips
          break;
        }
        
        logger.info('Retrying with cleaned payload:', currentPayload);

        // Refresh token if needed
        if (captchaToken !== null && captchaToken !== 'NO_CAPTCHA') {
            captchaToken = await this.getCaptcha();
            if (captchaToken !== null && captchaToken !== 'NO_CAPTCHA') {
                currentPayload.token = captchaToken;
            } else {
                delete currentPayload.token;
            }
        }

        try {
          const retryResp = await this.client.post(generateEndpoint, currentPayload, { timeout: 10000 });
          if (retryResp.status === 200) {
            logger.info('Quick moderation retry submission was successful. Continuing polling...');
            currentSongIds = retryResp.data.clips.map((a: any) => a.id);
            finalClips = retryResp.data.clips;
          } else {
            logger.error(`Quick moderation retry submission failed with status ${retryResp.status}.`);
            finalClips = pollResp; // Return last known failing clips
            break;
          }
        } catch (err: any) {
          logger.error('Quick moderation retry submission failed with error:', err.message);
          finalClips = pollResp; // Return last known failing clips
          break;
        }
      }

      return finalClips.map((audio: any) => {
        const metadata = audio.metadata || {};
        const gpt_prompt = metadata.gpt_description_prompt || audio.gpt_description_prompt;
        const prompt = metadata.prompt || audio.prompt || '';
        
        return {
          id: audio.id,
          title: audio.title,
          image_url: audio.image_url,
          lyric: gpt_prompt ? '' : this.parseLyrics(prompt), // Lyrics are in prompt only if not a gpt-description custom generation
          audio_url: audio.audio_url,
          video_url: audio.video_url,
          created_at: audio.created_at,
          model_name: audio.model_name,
          status: audio.status,
          gpt_description_prompt: gpt_prompt,
          prompt: prompt,
          type: metadata.type,
          tags: metadata.tags || audio.tags,
          negative_tags: metadata.negative_tags,
          duration: metadata.duration,
          error_message: metadata.error_message || audio.error_message
        };
      });
    }
  }

  // Helper to trigger hcaptcha by sending a 'test' song description via the UI
  private async solveCaptchaWithTestPrompt(): Promise<void> {
    logger.info('Triggering hcaptcha by sending a test song description via UI');
    console.log('solveCaptchaWithTestPrompt: called');
    // CDP_BROWSER_ENDPOINT check removed to always trigger fallback
    const browser = await this.launchBrowser();
    // Find an existing /create tab if available
    let page = (await browser.pages()).find(p => p.url().includes('/create'));
    if (!page) {
      page = await browser.newPage();
      await page.goto('https://suno.com/create', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });
    } else {
      await page.bringToFront();
    }
    try {
      await page.getByLabel('Close').click({ timeout: 2000 });
    } catch(e) {}
    const textarea = page.locator('.custom-textarea');
    await textarea.fill('Lorem ipsum');
    await textarea.blur(); // Triggers React validation if needed
    const button = page.locator('button[data-testid="create-button"]');
    await button.waitFor({ state: 'visible', timeout: 10000 });
    // Wait until enabled
    const start = Date.now();
    while (!(await button.isEnabled())) {
      if (Date.now() - start > 10000) throw new Error('Create button not enabled after 10s');
      await page.waitForTimeout(200);
    }
    await button.click();
    // Wait for hcaptcha to appear and be solved
    await sleep(5, 7); // Give time for hcaptcha to trigger
    try {
      await waitForCaptchaRequest(page, 45000); // Wait for hCaptcha for 45s
    } catch (e) {
      console.log('No hCaptcha request detected within 45s in solveCaptchaWithTestPrompt, returning');
      return;
    }
    await browser.close();
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
    return this.generateSongs(prompt, true, tags, title, false, model, wait_audio, negative_tags, 'extend', audioId, continueAt, undefined);
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

    // Print response
    // console.log('get response:\n', response.data);
    
    const audios = response.data.clips;

    // Print error metadata in red if any audio has status 'error'
    audios.forEach((audio: any) => {
      if (audio.status === 'error') {
        console.log('\x1b[31m%s\x1b[0m', 'Error metadata: ' + JSON.stringify(audio, null, 2));
      }
    });

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
      negative_tags: audio.metadata.negative_tags,
      duration: audio.metadata.duration,
      error_message: audio.metadata?.error_message
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

// Helper function for waiting for hCaptcha request
async function waitForCaptchaRequest(page: any, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let found = false;
    const onRequest = (req: any) => {
      if (req.url().includes('hcaptcha.com')) {
        found = true;
        page.off('request', onRequest);
        resolve(true);
      }
    };
    page.on('request', onRequest);
    setTimeout(() => {
      if (!found) {
        page.off('request', onRequest);
        reject(new Error('No hCaptcha request occurred within timeout.'));
      }
    }, timeoutMs);
  });
}