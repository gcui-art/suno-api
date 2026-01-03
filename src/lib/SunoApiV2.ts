/**
 * SunoApiV2.ts - Cleaned up version of SunoApi.ts
 * 
 * Removed dead code:
 * - parseModerationError, removeProblematicWord, removeProblematicPhrase (replaced by GPT rephrasing)
 * - getSessionToken, getTurnstile, solveCaptchaWithTestPrompt (never called)
 * - 2captcha integration (completely unused)
 * - Ghost cursor code (legacy feature)
 * - Commented out token injection code
 * 
 * Dependencies:
 * - @/lib/utils (sleep, isPage, waitForRequests)
 * - axios, user-agents, pino, yn, cookie
 * - rebrowser-playwright-core
 * - openai (for GPT-based CAPTCHA solving and tag rephrasing)
 */

import axios, { AxiosInstance } from 'axios';
import UserAgent from 'user-agents';
import pino from 'pino';
import yn from 'yn';
import { isPage, sleep, waitForRequests } from '@/lib/utils';
import * as cookie from 'cookie';
import { randomUUID } from 'node:crypto';
import { BrowserContext, Page, Locator, chromium, firefox } from 'rebrowser-playwright-core';
import { promises as fs } from 'fs';
import path from 'node:path';
import OpenAI from 'openai';

// SunoApi instance caching
const globalForSunoApi = global as unknown as { sunoApiCache?: Map<string, SunoApiV2> };
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApiV2>();
globalForSunoApi.sunoApiCache = cache;

// For persistent Playwright context reuse via CDP
declare global { var __cdpContext: any; }

const logger = pino();

// Helper function for blue terminal output
const blueLog = (message: string) => {
  console.log('\x1b[34m%s\x1b[0m', message);
  logger.info(message);
};

// Model versions
export const MODEL_V5 = 'chirp-crow';   // v5 - uses /api/generate/v2-web/
export const MODEL_V4_5 = 'chirp-auk';  // v4.5 - uses /api/generate/v2/
export const DEFAULT_MODEL = MODEL_V5;

// Helper to determine if a model uses the v2-web endpoint
function isV5Model(model: string): boolean {
  return model === MODEL_V5 || model === 'chirp-crows';
}

export interface AudioInfo {
  id: string;
  title?: string;
  image_url?: string;
  lyric?: string;
  audio_url?: string;
  video_url?: string;
  created_at: string;
  model_name: string;
  gpt_description_prompt?: string;
  prompt?: string;
  status: string;
  type?: string;
  tags?: string;
  negative_tags?: string;
  duration?: string;
  error_message?: string;
}

interface PersonaResponse {
  persona: {
    id: string;
    name: string;
    description: string;
    image_s3_id: string;
    root_clip_id: string;
    clip: any;
    user_display_name: string;
    user_handle: string;
    user_image_url: string;
    persona_clips: Array<{ clip: any }>;
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

class SunoApiV2 {
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
  private openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  constructor(cookies: string) {
    this.userAgent = new UserAgent(/Macintosh/).random().toString();
    this.cookies = cookie.parse(cookies);
    this.deviceId = this.cookies.ajs_anonymous_id || randomUUID();
    this.client = axios.create({
      withCredentials: true,
      headers: {
        'Affiliate-Id': 'undefined',
        'Device-Id': `"${this.deviceId}"`,
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
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
    });
  }

  public async init(): Promise<SunoApiV2> {
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  private async getAuthToken() {
    logger.info('Getting the session ID');
    const getSessionUrl = `${SunoApiV2.CLERK_BASE_URL}/v1/client?_is_native=true&_clerk_js_version=${SunoApiV2.CLERK_VERSION}`;
    
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
        `Please ensure you are LOGGED IN to suno.com when extracting the cookie.`
      );
    }
    
    this.sid = sessionResponse.data.response.last_active_session_id;
  }

  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }
    
    const renewUrl = `${SunoApiV2.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?__clerk_api_version=${SunoApiV2.CLERK_API_VERSION}&_clerk_js_version=${SunoApiV2.CLERK_VERSION}&_is_native=true`;
    
    logger.info('KeepAlive...\n');
    const renewResponse = await this.client.post(renewUrl, {}, {
      headers: { Authorization: this.cookies.__client }
    });
    
    if (isWait) {
      await sleep(1, 2);
    }
    
    this.currentToken = renewResponse.data.jwt;
  }

  private async captchaRequired(): Promise<boolean> {
    const resp = await this.client.post(`${SunoApiV2.BASE_URL}/api/c/check`, {
      ctype: 'generation'
    });
    logger.info(`CAPTCHA check response: ${JSON.stringify(resp.data)}`);
    return resp.data.required;
  }

  private async click(target: Locator | Page, position?: { x: number, y: number }): Promise<void> {
    if (isPage(target)) {
      return target.mouse.click(position?.x ?? 0, position?.y ?? 0);
    }
    return target.click({ force: true, position });
  }

  private getBrowserType() {
    const browser = process.env.BROWSER?.toLowerCase();
    switch (browser) {
      case 'firefox':
        return firefox;
      default:
        return chromium;
    }
  }

  private async launchBrowser(): Promise<BrowserContext> {
    const cdpEndpoint = process.env.CDP_BROWSER_ENDPOINT;
    
    if (cdpEndpoint) {
      console.log('Connecting to persistent browser via CDP:', cdpEndpoint);
      logger.info(`Connecting to persistent browser via CDP: ${cdpEndpoint}`);
      
      // Check if cached context exists and is still valid
      const cachedContext = (global as any).__cdpContext;
      if (cachedContext) {
        try {
          await cachedContext.pages();
          console.log('Reusing cached browser context');
          return cachedContext;
        } catch (error: any) {
          console.log('Cached browser context is invalid, reconnecting...');
          (global as any).__cdpContext = null;
        }
      }
      
      // Try multiple endpoints
      let browser: any;
      const port = cdpEndpoint.match(/:(\d+)/)?.[1] || '9222';
      const endpointsToTry = [
        cdpEndpoint,
        `http://[::1]:${port}`,
        `http://localhost:${port}`,
      ];
      
      let lastError: Error | null = null;
      for (const endpoint of endpointsToTry) {
        try {
          console.log(`Trying CDP endpoint: ${endpoint}`);
          browser = await Promise.race([
            chromium.connectOverCDP(endpoint),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`Timeout connecting to ${endpoint}`)), 5000)
            )
          ]) as any;
          console.log(`Successfully connected to CDP via ${endpoint}`);
          break;
        } catch (error: any) {
          console.log(`Failed to connect to ${endpoint}: ${error.message}`);
          lastError = error;
        }
      }
      
      if (!browser) {
        throw new Error(`CDP connection failed: Could not connect to Chrome on port ${port}. Make sure Chrome is running with --remote-debugging-port=${port}`);
      }
      
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

    // Fallback: Launch new browser
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=site-per-process',
      '--disable-features=IsolateOrigins',
      '--disable-extensions',
      '--disable-infobars',
      '--noerrdialogs',
      '--no-first-run',
      '--window-position=-2400,-2400',
      '--window-size=800,600'
    ];
    
    if (yn(process.env.BROWSER_DISABLE_GPU, { default: false })) {
      args.push('--enable-unsafe-swiftshader', '--disable-gpu', '--disable-setuid-sandbox');
    }
    
    const browser = await this.getBrowserType().launch({
      args,
      headless: yn(process.env.BROWSER_HEADLESS, { default: true })
    });
    
    const context = await browser.newContext({
      userAgent: this.userAgent,
      locale: process.env.BROWSER_LOCALE,
      viewport: null
    });
    
    const cookies = [];
    const lax: 'Lax' = 'Lax';
    cookies.push({
      name: '__session',
      value: this.currentToken + '',
      domain: '.suno.com',
      path: '/',
      sameSite: lax
    });
    
    for (const key in this.cookies) {
      cookies.push({
        name: key,
        value: this.cookies[key] + '',
        domain: '.suno.com',
        path: '/',
        sameSite: lax
      });
    }
    
    await context.addCookies(cookies);
    return context;
  }

  /**
   * Checks for CAPTCHA verification and solves the CAPTCHA if needed
   */
  public async getCaptcha(): Promise<string | null> {
    console.log("getCaptcha");
    
    if (!await this.captchaRequired()) return null;

    logger.info('CAPTCHA required. Launching browser...');
    let browser: BrowserContext;
    let page;
    
    try {
      browser = await this.launchBrowser();
      page = (await browser.pages()).find(p => p.url().includes('/create'));
      if (!page) {
        console.log("No existing /create tab found, creating new page...");
        page = await browser.newPage();
        await page.goto('https://suno.com/create', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });
      }
    } catch (error: any) {
      if (error.message?.includes('been closed') || error.message?.includes('Target page, context or browser')) {
        console.log('Browser context closed, clearing cache and retrying...');
        (global as any).__cdpContext = null;
        browser = await this.launchBrowser();
        page = (await browser.pages()).find(p => p.url().includes('/create'));
        if (!page) {
          page = await browser.newPage();
          await page.goto('https://suno.com/create', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });
        }
      } else {
        throw error;
      }
    }

    page.on('console', msg => {
      console.log(`[browser console.${msg.type()}]`, msg.text());
    });

    await page.goto('https://suno.com/create', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });

    logger.info('Waiting for Suno interface to load');
    await page.waitForResponse('**/api/project/**\\?**', { timeout: 60000 });
    
    logger.info('Checking if CAPTCHA is already solved...');
    try {
      await page.getByLabel('Close').click({ timeout: 2000 });
    } catch {}

    // Check for existing solved CAPTCHA
    try {
      const hcaptchaResponse = await page.locator('textarea[name="h-captcha-response"]').first();
      const responseValue = await hcaptchaResponse.inputValue().catch(() => '');
      if (responseValue && responseValue.length > 50) {
        console.log('Found existing hCaptcha response in textarea, CAPTCHA already solved');
        return responseValue;
      }
    } catch {}

    logger.info('No existing solved CAPTCHA found, triggering new CAPTCHA');
    
    // Find and fill textarea
    let textarea = page.locator('textarea[placeholder*="speedcore"]');
    try {
      await textarea.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      textarea = page.locator('textarea').first();
      await textarea.waitFor({ state: 'visible', timeout: 25000 });
    }
    
    await textarea.fill('Test song');
    await textarea.blur();

    // Fill title
    const titleInput = page.locator('input[placeholder*="Song Title"]');
    try {
      await titleInput.waitFor({ state: 'visible', timeout: 5000 });
      await titleInput.fill(`test-${Date.now()}`);
      await titleInput.blur();
    } catch {}

    // Click create button
    const button = page.locator('button[aria-label="Create song"]');
    await button.waitFor({ state: 'visible', timeout: 10000 });
    
    const start = Date.now();
    while (!(await button.isEnabled())) {
      if (Date.now() - start > 10000) throw new Error('Create button not enabled after 10s');
      await page.waitForTimeout(200);
    }
    await button.click();

    // Wait for hCaptcha
    let captchaToken = null;
    try {
      const timeout = 45000;
      const startTime = Date.now();
      let captchaDetected = false;
      
      const iframeSelectors = [
        'iframe[src*="hcaptcha"]',
        'iframe[title*="hCaptcha"]',
        'div[style*="z-index: 2147483647"] iframe',
      ];
      
      while (Date.now() - startTime < timeout && !captchaDetected) {
        for (const selector of iframeSelectors) {
          try {
            const count = await page.locator(selector).count();
            if (count > 0) {
              captchaDetected = true;
              break;
            }
          } catch {}
        }
        
        if (captchaDetected) break;
        
        try {
          await waitForCaptchaRequest(page, 1000);
          captchaDetected = true;
          break;
        } catch {}
        
        await page.waitForTimeout(500);
      }
      
      if (!captchaDetected) {
        console.log('No hCaptcha detected within 45s');
        return 'NO_CAPTCHA';
      }
      
      console.log('hCaptcha detected, waiting for it to fully load...');
      await page.waitForTimeout(3000);
      captchaToken = true;
    } catch (e: any) {
      console.log('Error detecting hCaptcha:', e.message);
      return 'NO_CAPTCHA';
    }

    // Solve with AI
    blueLog('═══════════════════════════════════════════════════════════');
    if (process.env.GEMINI_API_KEY) {
      blueLog('Using Gemini 3 Pro for CAPTCHA solving...');
    } else if (process.env.OPENAI_API_KEY) {
      blueLog('Using OpenAI GPT-5.2 for CAPTCHA solving...');
    } else {
      blueLog('⚠️  No AI API key set - CAPTCHA solving unavailable');
    }
    blueLog('═══════════════════════════════════════════════════════════');
    
    try {
      return await this.solveCaptchaWithCoordinates(page, browser, button);
    } catch (fallbackErr: any) {
      if (!process.env.CDP_BROWSER_ENDPOINT) {
        browser.browser()?.close();
      }
      throw new Error('Failed to solve hCaptcha: ' + fallbackErr.message);
    }
  }

  private async solveCaptchaWithCoordinates(page: any, browser: any, button: any): Promise<string> {
    blueLog('🔵 COORDINATES-BASED CAPTCHA SOLVING STARTED');
    const controller = new AbortController();
    
    new Promise<void>(async (resolve, reject) => {
      let frame;
      try {
        frame = page.frameLocator('iframe[title*="hCaptcha"]');
        await frame.locator('body').waitFor({ timeout: 5000 });
      } catch {
        try {
          frame = page.frameLocator('iframe[src*="hcaptcha"]');
          await frame.locator('body').waitFor({ timeout: 5000 });
        } catch {
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
          
          if (attemptCount > MAX_ATTEMPTS) {
            blueLog(`❌ MAX ATTEMPTS (${MAX_ATTEMPTS}) EXCEEDED`);
            blueLog('❌ Please solve the hCaptcha manually in the browser window');
            return;
          }
          
          if (attemptCount > 1) {
            blueLog(`⚠️  Previous answer was WRONG - trying again...`);
          }
          
          blueLog(`\n🔄 Attempt #${attemptCount}/${MAX_ATTEMPTS}`);
          
          if (wait) {
            try {
              await Promise.race([
                waitForRequests(page, controller.signal),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
              ]);
            } catch {}
          }
          
          const promptText = await challenge.locator('.prompt-text').first().innerText();
          blueLog(`📋 Challenge: "${promptText}"`);
          const drag = promptText.toLowerCase().includes('drag');
          
          let captcha: any;
          for (let j = 0; j < 3; j++) {
            try {
              const screenshotBuffer = await challenge.screenshot({ timeout: 5000 });
              const screenshotBase64 = screenshotBuffer.toString('base64');
              
              // Save screenshot
              const screenshotsDir = path.join(process.cwd(), 'captcha-screenshots');
              try { await fs.mkdir(screenshotsDir, { recursive: true }); } catch {}
              const screenshotPath = path.join(screenshotsDir, `captcha-${Date.now()}.png`);
              await fs.writeFile(screenshotPath, screenshotBuffer);
              blueLog(`💾 Screenshot: ${screenshotPath}`);
              
              const challengeBox = await challenge.boundingBox();
              if (!challengeBox) throw new Error('Could not get challenge bounding box');
              
              const coordinates = await this.solveCaptchaWithAI(
                screenshotBase64,
                promptText,
                challengeBox.width,
                challengeBox.height,
                150
              );
              
              captcha = { data: coordinates, id: `ai-${Date.now()}` };
              blueLog(`✅ AI solved: ${captcha.data.length} click points`);
              break;
            } catch (err: any) {
              blueLog(`❌ AI error (attempt ${j + 1}/3): ${err.message}`);
              if (j === 2) throw err;
            }
          }
          
          if (drag) {
            blueLog('⚠️  DRAG challenges not fully supported');
            wait = false;
            continue;
          }
          
          for (let i = 0; i < captcha.data.length; i++) {
            const data = captcha.data[i];
            blueLog(`   Click #${i + 1}: (${data.x}, ${data.y})`);
            await this.click(challenge, { x: +data.x, y: +data.y });
          }
          
          this.click(frame.locator('.button-submit')).catch((e: any) => {
            if (e.message.includes('viewport')) {
              this.click(button);
            } else {
              throw e;
            }
          });
        }
      } catch (e: any) {
        if (e.message.includes('been closed') || e.message === 'AbortError') {
          resolve();
        } else {
          reject(e);
        }
      }
    }).catch(e => {
      if (!process.env.CDP_BROWSER_ENDPOINT) {
        browser.browser()?.close();
      }
      throw e;
    });
    
    return new Promise((resolve, reject) => {
      page.route('**/api/generate/v2*/**', async (route: any) => {
        try {
          blueLog('🎉 SUCCESS: hCaptcha token received');
          route.abort();
          if (!process.env.CDP_BROWSER_ENDPOINT) {
            browser.browser()?.close();
          }
          controller.abort();
          const request = route.request();
          const token = request.postDataJSON().token;
          this.currentToken = request.headers().authorization.split('Bearer ').pop();
          resolve(token);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  private async solveCaptchaWithOpenAI(
    screenshotBase64: string,
    promptText: string,
    challengeWidth: number,
    challengeHeight: number,
    headerHeight: number = 150
  ): Promise<{ x: number; y: number }[]> {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    
    const instructionText = `Images are 
1 2 3 
4 5 6 
7 8 9 

${promptText}

NOTE: The images are designed to trick you. If a sample image is provided at the top, spend 50% of your energy understanding it first. There usually are 2 or 3 right answers.
Respond in comma separated numbers`;

    blueLog(`⏳ Sending to OpenAI GPT-5.2...`);
    const startTime = Date.now();
    
    const response = await (this.openai as any).responses.create({
      model: "gpt-5.2",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: instructionText },
          { type: "input_image", image_url: `data:image/png;base64,${screenshotBase64}` }
        ]
      }],
      text: { format: { type: "text" }, verbosity: "low" },
      reasoning: { effort: "low", summary: "auto" },
      tools: [],
      store: false,
      include: []
    });
    
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
    
    blueLog(`✅ GPT-5.2 responded (${Date.now() - startTime}ms): "${answer}"`);
    
    const numbers = answer
      .split(',')
      .map((s: string) => parseInt(s.trim(), 10))
      .filter((n: number) => n >= 1 && n <= 9);
    
    if (numbers.length === 0) {
      throw new Error(`Invalid OpenAI response: "${answer}"`);
    }
    
    const gridHeight = challengeHeight - headerHeight;
    const cellWidth = challengeWidth / 3;
    const cellHeight = gridHeight / 3;
    
    return numbers.map((num: number) => {
      const row = Math.floor((num - 1) / 3);
      const col = (num - 1) % 3;
      return {
        x: Math.round(col * cellWidth + cellWidth / 2),
        y: Math.round(headerHeight + row * cellHeight + cellHeight / 2)
      };
    });
  }

  private async solveCaptchaWithGemini(
    screenshotBase64: string,
    promptText: string,
    challengeWidth: number,
    challengeHeight: number,
    headerHeight: number = 150
  ): Promise<{ x: number; y: number }[]> {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }
    
    const instructionText = `Images are arranged in a 3x3 grid:
1 2 3 
4 5 6 
7 8 9 

${promptText}

NOTE: The images are designed to trick you. If a sample image is provided at the top, spend 50% of your energy understanding it first. There usually are 2 or 3 right answers.

IMPORTANT: Respond ONLY with comma separated numbers (e.g., "1, 4, 7"). No other text.`;

    blueLog(`⏳ Sending to Gemini 3 Pro...`);
    const startTime = Date.now();
    
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent`,
      {
        contents: [{
          parts: [
            { text: instructionText },
            { inlineData: { mimeType: "image/png", data: screenshotBase64 } }
          ]
        }],
        generationConfig: {
          thinkingConfig: { thinkingLevel: "low" },
          temperature: 1.0
        }
      },
      {
        headers: { 'x-goog-api-key': geminiApiKey, 'Content-Type': 'application/json' },
        timeout: 120000
      }
    );
    
    let answer = '';
    const candidates = response.data?.candidates;
    if (candidates?.[0]?.content?.parts) {
      for (const part of candidates[0].content.parts) {
        if (part.text) {
          answer = part.text.trim();
          break;
        }
      }
    }
    
    blueLog(`✅ Gemini responded (${Date.now() - startTime}ms): "${answer}"`);
    
    const numbers = answer
      .replace(/[^0-9,\s]/g, '')
      .split(/[,\s]+/)
      .map((s: string) => parseInt(s.trim(), 10))
      .filter((n: number) => n >= 1 && n <= 9);
    
    if (numbers.length === 0) {
      throw new Error(`Invalid Gemini response: "${answer}"`);
    }
    
    const gridHeight = challengeHeight - headerHeight;
    const cellWidth = challengeWidth / 3;
    const cellHeight = gridHeight / 3;
    
    return numbers.map((num: number) => ({
      x: Math.round(((num - 1) % 3) * cellWidth + cellWidth / 2),
      y: Math.round(headerHeight + Math.floor((num - 1) / 3) * cellHeight + cellHeight / 2)
    }));
  }

  private async solveCaptchaWithAI(
    screenshotBase64: string,
    promptText: string,
    challengeWidth: number,
    challengeHeight: number,
    headerHeight: number = 150
  ): Promise<{ x: number; y: number }[]> {
    if (process.env.GEMINI_API_KEY) {
      return this.solveCaptchaWithGemini(screenshotBase64, promptText, challengeWidth, challengeHeight, headerHeight);
    } else if (process.env.OPENAI_API_KEY) {
      return this.solveCaptchaWithOpenAI(screenshotBase64, promptText, challengeWidth, challengeHeight, headerHeight);
    }
    throw new Error('Neither GEMINI_API_KEY nor OPENAI_API_KEY is set. Cannot solve captcha.');
  }

  /**
   * Rephrases tags using GPT-5.2 to avoid moderation issues
   */
  public async rephraseTagsWithGPT(tags: string, errorMessage: string): Promise<string> {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    
    if (!tags || tags.trim().length === 0) return tags;
    
    blueLog(`🤖 Rephrasing tags: "${tags}"`);
    blueLog(`⚠️  Error: "${errorMessage}"`);
    
    const instructionText = `Error Message: ${errorMessage}
Tags: ${tags}
Respond with the new tags in JSON, with the problematic terms removed (or with a new choice of word). Keep everything else same:

{"tags":"<new_description>"}`;

    const response = await (this.openai as any).responses.create({
      model: "gpt-5.2",
      input: [{ role: "user", content: [{ type: "input_text", text: instructionText }] }],
      text: { format: { type: "json_object" }, verbosity: "low" },
      reasoning: { effort: "none" },
      tools: [],
      store: false,
      include: []
    });
    
    let responseText = '';
    if (response.output) {
      for (const item of response.output) {
        if (item.type === 'message' && item.content) {
          for (const content of item.content) {
            if (content.type === 'output_text') {
              responseText = content.text?.trim() || '';
              break;
            }
          }
        }
      }
    }
    
    if (!responseText) throw new Error('No response from GPT-5.2');
    
    const jsonData = JSON.parse(responseText);
    const rephrasedTags = jsonData.tags || '';
    
    if (!rephrasedTags) throw new Error('No tags in GPT-5.2 response');
    
    blueLog(`✅ Rephrased: "${rephrasedTags}"`);
    return rephrasedTags;
  }

  // ============================================================================
  // PUBLIC API METHODS
  // ============================================================================

  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    return this.generateSongs(prompt, false, undefined, undefined, make_instrumental, model, wait_audio);
  }

  public async concatenate(clip_id: string): Promise<AudioInfo> {
    await this.keepAlive(false);
    const response = await this.client.post(
      `${SunoApiV2.BASE_URL}/api/generate/concat/v2/`,
      { clip_id },
      { timeout: 10000 }
    );
    if (response.status !== 200) throw new Error('Error response:' + response.statusText);
    return response.data;
  }

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
    return this.generateSongs(
      prompt, true, tags, title, make_instrumental, model, wait_audio,
      negative_tags, undefined, undefined, undefined, gpt_description_prompt
    );
  }

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
    await this.keepAlive();
    
    const actualModel = model || DEFAULT_MODEL;
    const generateEndpoint = isV5Model(actualModel) 
      ? `${SunoApiV2.BASE_URL}/api/generate/v2-web/` 
      : `${SunoApiV2.BASE_URL}/api/generate/v2/`;
    
    let payload: any = {
      make_instrumental,
      mv: actualModel,
      prompt: '',
      generation_type: 'TEXT',
      continue_at,
      continue_clip_id,
      task
    };
    
    if (isCustom) {
      payload.tags = tags;
      payload.title = title;
      payload.negative_tags = negative_tags;
      payload.override_fields = ["tags"];
      payload.prompt = gpt_description_prompt ? '' : prompt;
      if (gpt_description_prompt) payload.gpt_description_prompt = gpt_description_prompt;
    } else {
      payload.gpt_description_prompt = prompt;
    }
    
    let response;
    let captchaToken: string | null = null;
    
    // Try without captcha first
    try {
      response = await this.client.post(generateEndpoint, payload, { timeout: 10000 });
      blueLog('✅ Request succeeded without captcha');
    } catch (error: any) {
      const status = error.response?.status;
      const detail = error.response?.data?.detail;
      
      blueLog(`⚠️ First attempt failed: ${status} - ${detail || error.message}`);
      
      if (status === 422 || detail?.toLowerCase().includes('captcha')) {
        blueLog('🔐 Captcha required - solving...');
        
        if (await this.captchaRequired()) {
          captchaToken = await this.getCaptcha();
          
          if (captchaToken && captchaToken !== 'NO_CAPTCHA') {
            payload.token = captchaToken;
            response = await this.client.post(generateEndpoint, payload, { timeout: 10000 });
            blueLog('✅ Request succeeded with captcha');
          } else {
            response = await this.client.post(generateEndpoint, payload, { timeout: 10000 });
          }
        } else {
          await sleep(1, 2);
          response = await this.client.post(generateEndpoint, payload, { timeout: 10000 });
        }
      } else {
        throw error;
      }
    }
    
    if (response.status !== 200) throw new Error('Error response:' + response.statusText);
    
    const songIds = response.data.clips.map((audio: any) => audio.id);
    
    if (wait_audio) {
      const MAX_MODERATION_RETRIES = 5;
      let moderationRetryCount = 0;
      await sleep(5, 5);
      
      const startTime = Date.now();
      while (Date.now() - startTime < 100000) {
        const pollResponse = await this.get(songIds);
        
        if (pollResponse.every(a => a.status === 'streaming' || a.status === 'complete')) {
          return pollResponse;
        }
        
        if (pollResponse.every(a => a.status === 'error')) {
          const moderationFailures = pollResponse.filter(a => a.error_message?.includes('contain'));
          
          if (moderationFailures.length === pollResponse.length && moderationRetryCount < MAX_MODERATION_RETRIES) {
            moderationRetryCount++;
            const firstError = moderationFailures[0]?.error_message || 'Moderation failure';
            blueLog(`⚠️  Moderation failure (${moderationRetryCount}/${MAX_MODERATION_RETRIES}): ${firstError}`);
            
            try {
              if (payload.tags) {
                payload.tags = await this.rephraseTagsWithGPT(payload.tags, firstError);
                
                if (captchaToken !== null && captchaToken !== 'NO_CAPTCHA') {
                  captchaToken = await this.getCaptcha();
                  if (captchaToken !== null && captchaToken !== 'NO_CAPTCHA') {
                    payload.token = captchaToken;
                  } else {
                    delete payload.token;
                  }
                }
                
                const retryResponse = await this.client.post(generateEndpoint, payload, { timeout: 10000 });
                if (retryResponse.status === 200) {
                  songIds.length = 0;
                  songIds.push(...retryResponse.data.clips.map((a: any) => a.id));
                  await sleep(5, 5);
                  continue;
                }
              }
            } catch (e: any) {
              logger.error(`Moderation retry failed: ${e.message}`);
            }
          }
          
          console.log('\x1b[31m%s\x1b[0m', 'SONG GENERATION FAILED: ' + JSON.stringify(pollResponse, null, 2));
          return pollResponse;
        }
        
        await sleep(3, 6);
        await this.keepAlive(true);
      }
    }
    
    // Non-wait mode: return immediately with moderation retry loop
    let finalClips = response.data.clips;
    let currentPayload = { ...payload };
    let currentSongIds = response.data.clips.map((a: any) => a.id);
    const MAX_MODERATION_RETRIES = 5;

    for (let retryAttempt = 0; retryAttempt < MAX_MODERATION_RETRIES; retryAttempt++) {
      await sleep(2, 3);
      const pollResp = await this.get(currentSongIds);
      
      if (!pollResp.every(c => c.status === 'error')) {
        finalClips = pollResp;
        break;
      }

      const moderationFailures = pollResp.filter(a => a.error_message?.includes('contain'));
      if (moderationFailures.length !== pollResp.length || moderationFailures.length === 0) {
        finalClips = pollResp;
        break;
      }

      const firstError = moderationFailures[0]?.error_message || 'Moderation failure';
      blueLog(`⚠️  Moderation retry ${retryAttempt + 1}/${MAX_MODERATION_RETRIES}: ${firstError}`);
      
      try {
        if (currentPayload.tags) {
          currentPayload.tags = await this.rephraseTagsWithGPT(currentPayload.tags, firstError);
          
          if (captchaToken !== null && captchaToken !== 'NO_CAPTCHA') {
            captchaToken = await this.getCaptcha();
            if (captchaToken !== null && captchaToken !== 'NO_CAPTCHA') {
              currentPayload.token = captchaToken;
            } else {
              delete currentPayload.token;
            }
          }
          
          const retryResp = await this.client.post(generateEndpoint, currentPayload, { timeout: 10000 });
          if (retryResp.status === 200) {
            currentSongIds = retryResp.data.clips.map((a: any) => a.id);
            finalClips = retryResp.data.clips;
          } else {
            finalClips = pollResp;
            break;
          }
        } else {
          finalClips = pollResp;
          break;
        }
      } catch (e: any) {
        logger.error(`Moderation retry failed: ${e.message}`);
        finalClips = pollResp;
        break;
      }
    }

    return finalClips.map((audio: any) => {
      const metadata = audio.metadata || {};
      return {
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: metadata.gpt_description_prompt ? '' : this.parseLyrics(metadata.prompt || audio.prompt || ''),
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: metadata.gpt_description_prompt || audio.gpt_description_prompt,
        prompt: metadata.prompt || audio.prompt || '',
        type: metadata.type,
        tags: metadata.tags || audio.tags,
        negative_tags: metadata.negative_tags,
        duration: metadata.duration,
        error_message: metadata.error_message || audio.error_message
      };
    });
  }

  public async generateLyrics(prompt: string): Promise<string> {
    await this.keepAlive(false);
    const generateResponse = await this.client.post(`${SunoApiV2.BASE_URL}/api/generate/lyrics/`, { prompt });
    const generateId = generateResponse.data.id;

    let lyricsResponse = await this.client.get(`${SunoApiV2.BASE_URL}/api/generate/lyrics/${generateId}`);
    while (lyricsResponse?.data?.status !== 'complete') {
      await sleep(2);
      lyricsResponse = await this.client.get(`${SunoApiV2.BASE_URL}/api/generate/lyrics/${generateId}`);
    }

    return lyricsResponse.data;
  }

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

  public async generateStems(song_id: string): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const response = await this.client.post(`${SunoApiV2.BASE_URL}/api/edit/stems/${song_id}`, {});
    return response.data.clips.map((clip: any) => ({
      id: clip.id,
      status: clip.status,
      created_at: clip.created_at,
      title: clip.title,
      stem_from_id: clip.metadata.stem_from_id,
      duration: clip.metadata.duration
    }));
  }

  public async getLyricAlignment(song_id: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApiV2.BASE_URL}/api/gen/${song_id}/aligned_lyrics/v2/`);
    return response.data?.aligned_words.map((w: any) => ({
      word: w.word,
      start_s: w.start_s,
      end_s: w.end_s,
      success: w.success,
      p_align: w.p_align
    }));
  }

  private parseLyrics(prompt: string): string {
    return prompt.split('\n').filter(line => line.trim() !== '').join('\n');
  }

  public async get(songIds?: string[], page?: string | null): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const url = new URL(`${SunoApiV2.BASE_URL}/api/feed/v2`);
    if (songIds) url.searchParams.append('ids', songIds.join(','));
    if (page) url.searchParams.append('page', page);
    
    const response = await this.client.get(url.href, { timeout: 10000 });
    const audios = response.data.clips;

    audios.forEach((audio: any) => {
      if (audio.status === 'error') {
        console.log('\x1b[31m%s\x1b[0m', 'Error: ' + JSON.stringify(audio, null, 2));
      }
    });

    return audios.map((audio: any) => ({
      id: audio.id,
      title: audio.title,
      image_url: audio.image_url,
      lyric: audio.metadata.prompt ? this.parseLyrics(audio.metadata.prompt) : '',
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

  public async getClip(clipId: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApiV2.BASE_URL}/api/clip/${clipId}`);
    return response.data;
  }

  public async get_credits(): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApiV2.BASE_URL}/api/billing/info/`);
    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage
    };
  }

  public async getPersonaPaginated(personaId: string, page: number = 1): Promise<PersonaResponse> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApiV2.BASE_URL}/api/persona/get-persona-paginated/${personaId}/?page=${page}`,
      { timeout: 10000 }
    );
    if (response.status !== 200) throw new Error('Error response: ' + response.statusText);
    return response.data;
  }
}

// Factory function
export const sunoApiV2 = async (cookie?: string) => {
  const resolvedCookie = cookie && cookie.includes('__client') ? cookie : process.env.SUNO_COOKIE;
  if (!resolvedCookie) {
    throw new Error('Please provide a cookie either in the .env file or in the Cookie header of your request.');
  }

  const cachedInstance = cache.get(resolvedCookie);
  if (cachedInstance) return cachedInstance;

  const instance = await new SunoApiV2(resolvedCookie).init();
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
      if (hcaptchaDomains.some(domain => req.url().includes(domain))) {
        found = true;
        page.off('request', onRequest);
        resolve(true);
      }
    };
    
    page.on('request', onRequest);
    setTimeout(() => {
      if (!found) {
        page.off('request', onRequest);
        reject(new Error('No hCaptcha request within timeout.'));
      }
    }, timeoutMs);
  });
}

// Standalone exported function for testing
export async function rephraseTagsWithGPT(tags: string, errorMessage: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable is not set');
  }
  
  if (!tags || tags.trim().length === 0) return tags;
  
  console.log(`🤖 Rephrasing tags: "${tags}"`);
  console.log(`⚠️  Error: "${errorMessage}"`);
  
  const instructionText = `Error Message: ${errorMessage}
Tags: ${tags}
Respond with the new tags in JSON, with the problematic terms removed. Keep everything else same:

{"tags":"<new_description>"}`;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  
  const response = await (openai as any).responses.create({
    model: "gpt-5.2",
    input: [{ role: "user", content: [{ type: "input_text", text: instructionText }] }],
    text: { format: { type: "json_object" }, verbosity: "low" },
    reasoning: { effort: "none" },
    tools: [],
    store: false,
    include: []
  });
  
  let responseText = '';
  if (response.output) {
    for (const item of response.output) {
      if (item.type === 'message' && item.content) {
        for (const content of item.content) {
          if (content.type === 'output_text') {
            responseText = content.text?.trim() || '';
            break;
          }
        }
      }
    }
  }
  
  if (!responseText) throw new Error('No response from GPT-5.2');
  
  const jsonData = JSON.parse(responseText);
  const rephrasedTags = jsonData.tags || '';
  
  if (!rephrasedTags) throw new Error('No tags in GPT-5.2 response');
  
  console.log(`✅ Rephrased: "${rephrasedTags}"`);
  return rephrasedTags;
}

export default SunoApiV2;

