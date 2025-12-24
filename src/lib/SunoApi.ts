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
import OpenAI from 'openai';
// Remove: import { expect } from '@playwright/test';

// sunoApi instance caching
const globalForSunoApi = global as unknown as { sunoApiCache?: Map<string, SunoApi> };
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;

// For persistent Playwright context reuse via CDP
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare global { var __cdpContext: any; }

const logger = pino();

// Helper function for blue terminal output
const blueLog = (message: string) => {
  console.log('\x1b[34m%s\x1b[0m', message); // Blue color
  logger.info(message);
};

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
  private openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
      
      // Check if cached context exists and is still valid
      const cachedContext = (global as any).__cdpContext;
      if (cachedContext) {
        try {
          // Try to access pages() to verify context is still valid
          await cachedContext.pages();
          console.log('Reusing cached browser context');
          return cachedContext;
        } catch (error: any) {
          // Context is invalid (browser closed), clear cache and reconnect
          console.log('Cached browser context is invalid, reconnecting...');
          logger.info('Cached browser context is invalid, reconnecting...');
          (global as any).__cdpContext = null;
        }
      }
      
      // Connect and create/reuse context
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
      return context;
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
      '--disable-infobars',
      // Prevent browser from stealing focus on macOS
      '--noerrdialogs',
      '--no-first-run',
      '--window-position=-2400,-2400', // Move window off-screen
      '--window-size=800,600'
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
    let browser: BrowserContext;
    let page;
    try {
      browser = await this.launchBrowser();
      // Find an existing /create tab if available
      page = (await browser.pages()).find(p => p.url().includes('/create'));
      if (!page) {
        console.log("No existing /create tab found, creating new page...");
        page = await browser.newPage();
        await page.goto('https://suno.com/create', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });
      } else {
        console.log("Existing /create tab found, bringing to front...");
        // await page.bringToFront(); // Commented out to prevent focus stealing
      }
    } catch (error: any) {
      // Browser context was closed, clear cache and retry once
      if (error.message && (error.message.includes('been closed') || error.message.includes('Target page, context or browser'))) {
        console.log('Browser context closed, clearing cache and retrying...');
        logger.info('Browser context closed, clearing cache and retrying...');
        (global as any).__cdpContext = null;
        browser = await this.launchBrowser();
        page = (await browser.pages()).find(p => p.url().includes('/create'));
        if (!page) {
          console.log("No existing /create tab found, creating new page...");
          page = await browser.newPage();
          await page.goto('https://suno.com/create', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });
        } else {
          console.log("Existing /create tab found, bringing to front...");
          // await page.bringToFront(); // Commented out to prevent focus stealing
        }
      } else {
        throw error;
      }
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
    
    logger.info('Checking if CAPTCHA is already solved...');
    try {
      await page.getByLabel('Close').click({ timeout: 2000 }); // close all popups
    } catch(e) {}

    // First, check if CAPTCHA was already solved by checking for hCaptcha response textarea
    // This handles the case where user manually solved CAPTCHA in the browser
    console.log("Checking for existing solved CAPTCHA...");
    try {
      const hcaptchaResponse = await page.locator('textarea[name="h-captcha-response"]').first();
      const responseValue = await hcaptchaResponse.inputValue().catch(() => '');
      if (responseValue && responseValue.length > 50) {
        console.log('Found existing hCaptcha response in textarea, CAPTCHA already solved');
        logger.info('Using existing solved CAPTCHA token');
        // Return the existing token immediately - no need to trigger new CAPTCHA
        return responseValue;
      }
    } catch (e) {
      // No existing response found, continue to trigger new CAPTCHA
      console.log('No existing CAPTCHA response found');
    }

    logger.info('No existing solved CAPTCHA found, triggering new CAPTCHA');
    console.log("Locating textarea...");
    // Try placeholder-based selector first, fallback to any textarea if not found
    let textarea = page.locator('textarea[placeholder*="speedcore"]');
    try {
      await textarea.waitFor({ state: 'visible', timeout: 5000 });
    } catch (e) {
      console.log("Placeholder-based selector not found, trying general textarea selector...");
      textarea = page.locator('textarea').first();
      await textarea.waitFor({ state: 'visible', timeout: 25000 });
    }
    console.log("Filling textarea with 'Test song'...");
    await textarea.fill('Test song');
    console.log("Blurring textarea to trigger React validation...");
    await textarea.blur(); // Triggers React validation if needed

    // Fill title input field
    console.log("Locating title input...");
    const titleInput = page.locator('input[placeholder*="Song Title"]');
    try {
      await titleInput.waitFor({ state: 'visible', timeout: 5000 });
      const timestamp = Date.now();
      const titleValue = `test-${timestamp}`;
      console.log(`Filling title with '${titleValue}'...`);
      await titleInput.fill(titleValue);
      await titleInput.blur();
    } catch (e) {
      console.log("Title input not found or not visible, skipping...");
    }

    console.log("Locating create button...");
    const button = page.locator('button[aria-label="Create song"]');
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
      // Wait for hCaptcha to appear using polling approach
      console.log('Waiting for hCaptcha to appear...');
      const timeout = 45000;
      const startTime = Date.now();
      let captchaDetected = false;
      
      // List of selectors to try for hCaptcha detection
      const iframeSelectors = [
        'iframe[src*="hcaptcha"]',
        'iframe[src*="hCaptcha"]',
        'iframe[title*="hCaptcha"]',
        'iframe[title*="hcaptcha"]',
        'iframe[title*="captcha"]',
        'div[style*="z-index: 2147483647"] iframe', // hCaptcha container uses this z-index
      ];
      
      while (Date.now() - startTime < timeout && !captchaDetected) {
        // Check each selector
        for (const selector of iframeSelectors) {
          try {
            const count = await page.locator(selector).count();
            if (count > 0) {
              console.log(`hCaptcha iframe detected with selector: ${selector}`);
              captchaDetected = true;
              break;
            }
          } catch (e) {
            // Ignore selector errors
          }
        }
        
        if (captchaDetected) break;
        
        // Also check for network request
        try {
          await waitForCaptchaRequest(page, 1000);
          console.log('hCaptcha detected via network request');
          captchaDetected = true;
          break;
        } catch (e) {
          // No network request yet, continue polling
        }
        
        await page.waitForTimeout(500); // Check every 500ms
      }
      
      if (!captchaDetected) {
        console.log('No hCaptcha request or iframe detected within 45s, will signal NO_CAPTCHA');
        return 'NO_CAPTCHA';
      }
      
      // Give the iframe a moment to fully load
      console.log('hCaptcha detected, waiting for it to fully load...');
      await page.waitForTimeout(3000);
      captchaToken = true; // Signal that CAPTCHA was detected
    } catch (e: any) {
      console.log('Error detecting hCaptcha:', e.message);
      return 'NO_CAPTCHA';
    }

    // Skip token-based solving, go directly to coordinates-based solving
    blueLog('═══════════════════════════════════════════════════════════');
    if (process.env.OPENAI_API_KEY) {
      blueLog('Using OpenAI GPT-5.2 for CAPTCHA solving...');
    } else {
      blueLog('⚠️  OPENAI_API_KEY not set - OpenAI CAPTCHA solving unavailable');
      blueLog('Using coordinates-based CAPTCHA solving with 2Captcha...');
    }
    blueLog('═══════════════════════════════════════════════════════════');
    try {
      return await this.solveCaptchaWithCoordinates(page, browser, button);
    } catch (fallbackErr: any) {
      browser.browser()?.close();
      throw new Error('Failed to solve hCaptcha with coordinates method: ' + fallbackErr.message);
    }
    
    // const hcaptchaToken = hcaptchaResult.data;
    // console.log('hCaptcha token received, injecting into page...');
    
    // // Inject the token into the page and trigger the callback
    // try {
    //   if (!page.isClosed()) {
    //     await page.evaluate((token: string) => {
    //     // Set the h-captcha-response textarea
    //     const responseTextarea = document.querySelector('textarea[name="h-captcha-response"]') as HTMLTextAreaElement;
    //     if (responseTextarea) {
    //       responseTextarea.value = token;
    //     }
        
    //     // Also set in any iframe response fields
    //     const iframeResponses = document.querySelectorAll('iframe[src*="hcaptcha"]');
    //     iframeResponses.forEach((iframe: any) => {
    //       try {
    //         const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
    //         if (iframeDoc) {
    //           const iframeTextarea = iframeDoc.querySelector('textarea[name="h-captcha-response"]');
    //           if (iframeTextarea) {
    //             iframeTextarea.value = token;
    //           }
    //         }
    //       } catch (e) {
    //         // Cross-origin iframe, ignore
    //       }
    //     });
        
    //     // Trigger hCaptcha callback if it exists
    //     if ((window as any).hcaptcha) {
    //       try {
    //         // Try to get the widget ID
    //         const widgetId = (window as any).hcaptcha.getWidgetID?.() || 0;
    //         // Manually trigger the callback with our token
    //         const callback = (window as any).hcaptchaCallback || (window as any).onHcaptchaSuccess;
    //         if (callback) {
    //           callback(token);
    //         }
    //       } catch (e) {
    //         console.log('Could not trigger hcaptcha callback:', e);
    //       }
    //     }
        
    //     // Dispatch custom event that some sites listen for
    //     document.dispatchEvent(new CustomEvent('hcaptcha-success', { detail: { token } }));
    //   }, hcaptchaToken);
    //   }
      
    //   // Give the page a moment to process the token
    //   await page.waitForTimeout(1000);
      
    //   // Click the submit button in the hCaptcha iframe if visible
    //   try {
    //     const frame = page.frameLocator('iframe[src*="hcaptcha"]');
    //     await frame.locator('.button-submit').click({ timeout: 3000 });
    //   } catch (e) {
    //     // Button might not be visible or iframe might have closed, that's ok
    //     console.log('hCaptcha submit button click skipped');
    //   }
      
    // } catch (err: any) {
    //   console.log('Token injection attempt completed (some errors expected):', err.message);
    // }
    
    // Wait for manual CAPTCHA solving
    logger.info('Waiting for manual hCaptcha solving...');
    console.log('Please solve the hCaptcha manually in the browser window.');
    console.log('The browser will remain open until you solve it and submit the form.');
    
    // Wait for the API call which indicates CAPTCHA was solved and form was submitted
    return new Promise((resolve, reject) => {
      // Set a longer timeout for manual solving (5 minutes)
      const timeout = setTimeout(() => {
        console.log('Timeout waiting for manual CAPTCHA solving. Closing browser.');
        browser.browser()?.close();
        reject(new Error('Timeout waiting for manual CAPTCHA solving. Please solve the CAPTCHA within 5 minutes.'));
      }, 300000); // 5 minutes
      
      page.route('**/api/generate/v2*/**', async (route: any) => {  // Catches both /v2/ and /v2-web/
        try {
          clearTimeout(timeout);
          logger.info('API request intercepted. CAPTCHA solved manually. Closing browser.');
          const request = route.request();
          const requestData = request.postDataJSON();
          
          // Capture the auth token from the browser's request
          const authHeader = request.headers().authorization;
          if (authHeader) {
            this.currentToken = authHeader.split('Bearer ').pop();
          }
          
          // Extract the hCaptcha token from the request payload
          const hcaptchaToken = requestData?.token;
          if (!hcaptchaToken) {
            route.abort();
            browser.browser()?.close();
            reject(new Error('No hCaptcha token found in request payload'));
            return;
          }
          
          route.abort();
          browser.browser()?.close();
          resolve(hcaptchaToken);
        } catch(err) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  /**
   * Fallback method to solve hCaptcha using coordinates-based approach with 2Captcha
   */
  private async solveCaptchaWithCoordinates(page: any, browser: any, button: any): Promise<string> {
    blueLog('═══════════════════════════════════════════════════════════');
    blueLog('🔵 COORDINATES-BASED CAPTCHA SOLVING STARTED');
    blueLog('═══════════════════════════════════════════════════════════');
    const controller = new AbortController();
    
    new Promise<void>(async (resolve, reject) => {
      // Try multiple iframe selectors to find the hCaptcha
      blueLog('📍 Step 1: Locating hCaptcha iframe...');
      let frame;
      try {
        frame = page.frameLocator('iframe[title*="hCaptcha"]');
        await frame.locator('body').waitFor({ timeout: 5000 });
        blueLog('✅ Found hCaptcha iframe using title selector');
      } catch (e) {
        try {
          frame = page.frameLocator('iframe[src*="hcaptcha"]');
          await frame.locator('body').waitFor({ timeout: 5000 });
          blueLog('✅ Found hCaptcha iframe using src selector');
        } catch (e2) {
          blueLog('⚠️  Could not find hCaptcha iframe, trying to proceed anyway...');
          frame = page.frameLocator('iframe[title*="hCaptcha"], iframe[src*="hcaptcha"]');
        }
      }
      
      const challenge = frame.locator('.challenge-container');
      const MAX_ATTEMPTS = 5;
      
      try {
        let wait = true;
        let attemptCount = 0;
        while (true) {
          attemptCount++;
          
          // Check if we've exceeded max attempts
          if (attemptCount > MAX_ATTEMPTS) {
            blueLog('\n❌ ════════════════════════════════════════════════════════');
            blueLog(`❌ MAX ATTEMPTS (${MAX_ATTEMPTS}) EXCEEDED - OpenAI failed to solve`);
            blueLog('❌ Please solve the hCaptcha manually in the browser window');
            blueLog('❌ The browser will remain open for manual solving...');
            blueLog('❌ ════════════════════════════════════════════════════════\n');
            // Don't reject - let the manual solving route handler take over
            return;
          }
          
          // Log if previous attempt failed
          if (attemptCount > 1) {
            blueLog(`\n⚠️  Previous answer was WRONG - trying again with OpenAI...`);
          }
          
          blueLog(`\n🔄 Attempt #${attemptCount}/${MAX_ATTEMPTS}`);
          blueLog('═══════════════════════════════════════════════════════════');
          
          if (wait) {
            blueLog('⏳ Waiting for hCaptcha requests to complete...');
            try {
              // Add timeout to prevent hanging indefinitely
              await Promise.race([
                waitForRequests(page, controller.signal),
                new Promise((_, reject) => 
                  setTimeout(() => reject(new Error('Timeout waiting for hCaptcha requests')), 3000)
                )
              ]);
              blueLog('✅ hCaptcha requests completed');
            } catch (err: any) {
              if (err.message.includes('Timeout')) {
                blueLog('⚠️  Timeout waiting for requests, proceeding anyway...');
              } else {
                throw err;
              }
            }
          }
          
          blueLog('📝 Reading challenge prompt...');
          const promptText = await challenge.locator('.prompt-text').first().innerText();
          blueLog(`📋 Challenge prompt: "${promptText}"`);
          const drag = promptText.toLowerCase().includes('drag');
          blueLog(`🎯 Challenge type: ${drag ? 'DRAG' : 'CLICK'}`);
          
          let captcha: any;
          for (let j = 0; j < 3; j++) {
            try {
              blueLog(`\n📸 Step 2: Capturing screenshot (attempt ${j + 1}/3)...`);
              const screenshotBuffer = await challenge.screenshot({ timeout: 5000 });
              const screenshotBase64 = screenshotBuffer.toString('base64');
              
              // Save screenshot to file for inspection in a dedicated directory
              const screenshotsDir = path.join(process.cwd(), 'captcha-screenshots');
              try {
                await fs.mkdir(screenshotsDir, { recursive: true });
              } catch (e) {
                // Directory might already exist, that's fine
              }
              
              const timestamp = Date.now();
              const screenshotFilename = `captcha-screenshot-${timestamp}.png`;
              const screenshotPath = path.join(screenshotsDir, screenshotFilename);
              // await fs.writeFile(screenshotPath, screenshotBuffer);
              blueLog(`💾 Screenshot saved locally to: ${screenshotPath}`);
              blueLog(`📁 Full path: ${path.resolve(screenshotPath)}`);
              blueLog(`📊 Screenshot size: ${screenshotBuffer.length} bytes (base64: ${screenshotBase64.length} chars)`);
              
              // Get challenge dimensions for coordinate calculation
              const challengeBox = await challenge.boundingBox();
              if (!challengeBox) throw new Error('Could not get challenge bounding box');
              
              blueLog('\n📤 Step 3: Sending to OpenAI Vision...');
              
              // Use OpenAI to solve the captcha
              const coordinates = await this.solveCaptchaWithOpenAI(
                screenshotBase64,
                promptText,
                challengeBox.width,
                challengeBox.height,
                150 // Approximate header height with prompt text
              );
              
              // Convert to format compatible with existing click logic
              captcha = {
                data: coordinates,
                id: `openai-${Date.now()}`
              };
              
              blueLog(`\n✅ Step 4: GPT-5.2 solved captcha`);
              blueLog('═══════════════════════════════════════════════════════════');
              blueLog(`📦 Response details:`);
              blueLog(`   - Solver: OpenAI GPT-5.2 (Responses API)`);
              blueLog(`   - Click points: ${captcha.data.length}`);
              blueLog(`   - Coordinates: ${JSON.stringify(captcha.data)}`);
              blueLog('═══════════════════════════════════════════════════════════');
              
              // No need for lastCaptchaId with OpenAI (no bad report system)
              
              break;
            } catch(err: any) {
              blueLog(`❌ OpenAI error (attempt ${j + 1}/3): ${err.message}`);
              logger.info(err.message);
              if (j != 2) {
                blueLog('🔄 Retrying...');
                logger.info('Retrying...');
              } else {
                throw err;
              }
            }
          }
          
          if (drag) {
            blueLog('\n⚠️  DRAG challenges are not fully supported with OpenAI solver');
            blueLog('🎯 Step 5: Attempting DRAG challenge with OpenAI coordinates...');
            // For drag challenges, we need pairs of coordinates (from, to)
            // OpenAI returns single click points, so we'll skip or try a different approach
            blueLog('❌ Skipping DRAG challenge - not supported with current OpenAI implementation');
            wait = false;
            continue;
          } else {
            blueLog('\n🖱️  Step 5: Processing CLICK challenge...');
            blueLog(`📍 Executing ${captcha.data.length} click(s)...`);
            for (let i = 0; i < captcha.data.length; i++) {
              const data = captcha.data[i];
              blueLog(`   Click #${i + 1}: (${data.x}, ${data.y})`);
              await this.click(challenge, { x: +data.x, y: +data.y });
              blueLog(`      ✅ Click #${i + 1} completed`);
            }
          }
          
          blueLog('\n📤 Step 6: Submitting challenge...');
          this.click(frame.locator('.button-submit')).catch((e: any) => {
            if (e.message.includes('viewport')) {
              blueLog('⚠️  Submit button not in viewport, clicking main button instead');
              this.click(button);
            } else {
              throw e;
            }
          });
          blueLog('✅ Challenge submitted');
        }
      } catch(e: any) {
        if (e.message.includes('been closed') || e.message == 'AbortError') {
          blueLog('✅ Browser closed or aborted');
          resolve();
        } else {
          blueLog(`❌ Error: ${e.message}`);
          reject(e);
        }
      }
    }).catch(e => {
      blueLog(`❌ Fatal error: ${e.message}`);
      browser.browser()?.close();
      throw e;
    });
    
    return new Promise((resolve, reject) => {
      page.route('**/api/generate/v2*/**', async (route: any) => {
        try {
          blueLog('\n═══════════════════════════════════════════════════════════');
          blueLog('🎉 SUCCESS: hCaptcha token received (coordinates method)');
          blueLog('═══════════════════════════════════════════════════════════');
          route.abort();
          browser.browser()?.close();
          controller.abort();
          const request = route.request();
          const token = request.postDataJSON().token;
          this.currentToken = request.headers().authorization.split('Bearer ').pop();
          blueLog(`🔑 Auth token captured: ${this.currentToken ? 'Yes' : 'No'}`);
          blueLog(`🎫 hCaptcha token: ${token ? token.substring(0, 50) + '...' : 'None'}`);
          blueLog('═══════════════════════════════════════════════════════════\n');
          resolve(token);
        } catch(err) {
          blueLog(`❌ Error extracting token: ${err}`);
          reject(err);
        }
      });
    });
  }

  /**
   * Solve hCaptcha using OpenAI Vision model (GPT-5.2 with Responses API)
   * Maps a 3x3 grid (1-9) to pixel coordinates
   */
  private async solveCaptchaWithOpenAI(
    screenshotBase64: string,
    promptText: string,
    challengeWidth: number,
    challengeHeight: number,
    headerHeight: number = 150 // Height of the prompt text area
  ): Promise<{ x: number; y: number }[]> {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    
    blueLog('\n🤖 ════════════════════════════════════════════════════════');
    blueLog('🤖 OPENAI GPT-5.2 CAPTCHA SOLVING (Responses API)');
    blueLog('🤖 ════════════════════════════════════════════════════════');
    
    const instructionText = `Images are 
1 2 3 
4 5 6 
7 8 9 

${promptText}

Respond in comma separated numbers`;

    blueLog(`📝 Instruction: "${promptText}"`);
    blueLog('⏳ Sending to OpenAI GPT-5.2...');
    
    const startTime = Date.now();
    
    try {
      // Using the exact Responses API format from user's script
      const response = await (this.openai as any).responses.create({
        model: "gpt-5.2",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: instructionText
              },
              {
                type: "input_image",
                image_url: `data:image/png;base64,${screenshotBase64}`
              }
            ]
          }
        ],
        text: {
          format: {
            type: "text"
          },
          verbosity: "low"
        },
        reasoning: {
          effort: "low",
          summary: "auto"
        },
        tools: [],
        store: false, // Disable storing to reduce latency
        include: [] // Remove unnecessary includes to speed up response
      });
      
      const solveTime = Date.now() - startTime;
      
      // Extract the answer from the response output
      let answer = '';
      if (response.output) {
        for (const item of response.output) {
          if (item.type === 'message' && item.content) {
            for (const content of item.content) {
              if (content.type === 'output_text') {
                answer = content.text?.trim() || '';
                break;
              }
            }
          }
        }
      }
      
      blueLog(`\n✅ GPT-5.2 responded (took ${solveTime}ms)`);
      blueLog(`📦 Raw response: "${answer}"`);
      blueLog(`📊 Full response: ${JSON.stringify(response, null, 2).substring(0, 500)}...`);
      
      // Parse the comma-separated numbers
      const numbers = answer
        .split(',')
        .map((s: string) => parseInt(s.trim(), 10))
        .filter((n: number) => n >= 1 && n <= 9);
      
      if (numbers.length === 0) {
        throw new Error(`Invalid OpenAI response: "${answer}" - no valid numbers found`);
      }
      
      blueLog(`🔢 Parsed grid positions: [${numbers.join(', ')}]`);
      
      // Calculate grid cell dimensions
      // The grid starts after the header (prompt text area)
      const gridHeight = challengeHeight - headerHeight;
      const cellWidth = challengeWidth / 3;
      const cellHeight = gridHeight / 3;
      
      blueLog(`📐 Grid calculations:`);
      blueLog(`   - Challenge size: ${challengeWidth}x${challengeHeight}`);
      blueLog(`   - Header height: ${headerHeight}px`);
      blueLog(`   - Grid area: ${challengeWidth}x${gridHeight}`);
      blueLog(`   - Cell size: ${cellWidth.toFixed(0)}x${cellHeight.toFixed(0)}`);
      
      // Convert grid positions (1-9) to pixel coordinates
      // Grid position to row/col: 1-3 = row 0, 4-6 = row 1, 7-9 = row 2
      const coordinates: { x: number; y: number }[] = numbers.map((num: number) => {
        const row = Math.floor((num - 1) / 3); // 0, 1, or 2
        const col = (num - 1) % 3;              // 0, 1, or 2
        
        // Center of each cell
        const x = Math.round(col * cellWidth + cellWidth / 2);
        const y = Math.round(headerHeight + row * cellHeight + cellHeight / 2);
        
        blueLog(`   - Position ${num} → row=${row}, col=${col} → (${x}, ${y})`);
        return { x, y };
      });
      
      blueLog('🤖 ════════════════════════════════════════════════════════\n');
      return coordinates;
      
    } catch (error: any) {
      blueLog(`❌ OpenAI error: ${error.message}`);
      throw error;
    }
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
    let browser: BrowserContext;
    let page;
    try {
      browser = await this.launchBrowser();
      // Find an existing /create tab if available
      page = (await browser.pages()).find(p => p.url().includes('/create'));
      if (!page) {
        page = await browser.newPage();
        await page.goto('https://suno.com/create', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });
      } else {
        // await page.bringToFront(); // Commented out to prevent focus stealing
      }
    } catch (error: any) {
      // Browser context was closed, clear cache and retry once
      if (error.message && (error.message.includes('been closed') || error.message.includes('Target page, context or browser'))) {
        console.log('Browser context closed, clearing cache and retrying...');
        logger.info('Browser context closed, clearing cache and retrying...');
        (global as any).__cdpContext = null;
        browser = await this.launchBrowser();
        page = (await browser.pages()).find(p => p.url().includes('/create'));
        if (!page) {
          page = await browser.newPage();
          await page.goto('https://suno.com/create', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });
        } else {
          // await page.bringToFront(); // Commented out to prevent focus stealing
        }
      } else {
        throw error;
      }
    }
    try {
      await page.getByLabel('Close').click({ timeout: 2000 });
    } catch(e) {}
    // Try placeholder-based selector first, fallback to any textarea if not found
    let textarea = page.locator('textarea[placeholder*="speedcore"]');
    try {
      await textarea.waitFor({ state: 'visible', timeout: 5000 });
    } catch (e) {
      console.log("Placeholder-based selector not found, trying general textarea selector...");
      textarea = page.locator('textarea').first();
      await textarea.waitFor({ state: 'visible', timeout: 25000 });
    }
    await textarea.fill('Lorem ipsum');
    await textarea.blur(); // Triggers React validation if needed

    // Fill title input field
    const titleInput = page.locator('input[placeholder*="Song Title"]');
    try {
      await titleInput.waitFor({ state: 'visible', timeout: 5000 });
      const timestamp = Date.now();
      const titleValue = `test-${timestamp}`;
      await titleInput.fill(titleValue);
      await titleInput.blur();
    } catch (e) {
      console.log("Title input not found or not visible, skipping...");
    }

    const button = page.locator('button[aria-label="Create song"]');
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
    const hcaptchaDomains = [
      'hcaptcha.com',
      'hcaptcha-assets-prod.suno.com',
      'hcaptcha-endpoint-prod.suno.com',
      'hcaptcha-imgs-prod.suno.com',
      'hcaptcha-reportapi-prod.suno.com'
    ];
    const onRequest = (req: any) => {
      const url = req.url();
      if (hcaptchaDomains.some(domain => url.includes(domain))) {
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