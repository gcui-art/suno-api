import pino from "pino";
import { Page } from "rebrowser-playwright-core";

const logger = pino();

/**
 * Pause for a specified number of seconds.
 * @param x Minimum number of seconds.
 * @param y Maximum number of seconds (optional).
 */
export const sleep = (x: number, y?: number): Promise<void> => {
  let timeout = x * 1000;
  if (y !== undefined && y !== x) {
    const min = Math.min(x, y);
    const max = Math.max(x, y);
    timeout = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
  }
  // Only log sleeps >= 1 second to avoid spam from polling loops
  if (timeout >= 1000)
    logger.info(`Sleeping for ${timeout / 1000} seconds`);

  return new Promise(resolve => setTimeout(resolve, timeout));
}

/**
 * @param target A Locator or a page
 * @returns {boolean} 
 */
export const isPage = (target: any): target is Page => {
  return target.constructor.name === 'Page';
}

/**
 * Waits for CAPTCHA-related image/resource requests and then waits for all of them to end.
 * Detects hCaptcha, reCAPTCHA, Turnstile, and Arkose/FunCaptcha request patterns.
 * @param page
 * @param signal `const controller = new AbortController(); controller.signal`
 * @returns {Promise<void>} 
 */
export const waitForRequests = (page: Page, signal: AbortSignal): Promise<void> => {
  return new Promise((resolve, reject) => {
    // Match any CAPTCHA provider's image/resource requests
    const urlPatterns = [
      /^https:\/\/img[a-zA-Z0-9]*\.hcaptcha\.com\/.*$/,       // hCaptcha images
      /^https:\/\/.*\.hcaptcha\.com\/captcha\/.*$/,            // hCaptcha API
      /^https:\/\/www\.google\.com\/recaptcha\/.*$/,           // reCAPTCHA
      /^https:\/\/www\.gstatic\.com\/recaptcha\/.*$/,          // reCAPTCHA assets
      /^https:\/\/challenges\.cloudflare\.com\/.*$/,           // Cloudflare Turnstile
      /^https:\/\/.*\.arkoselabs\.com\/.*$/,                   // Arkose/FunCaptcha
    ];

    const matchesCaptchaUrl = (url: string) => urlPatterns.some(p => p.test(url));

    let timeoutHandle: NodeJS.Timeout | null = null;
    let activeRequestCount = 0;
    let requestOccurred = false;

    const cleanupListeners = () => {
      page.off('request', onRequest);
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFinished);
    };

    const resetTimeout = () => {
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      if (activeRequestCount === 0) {
        timeoutHandle = setTimeout(() => {
          cleanupListeners();
          resolve();
        }, 1000); // 1 second of no requests
      }
    };

    const onRequest = (request: { url: () => string }) => {
      if (matchesCaptchaUrl(request.url())) {
        requestOccurred = true;
        activeRequestCount++;
        if (timeoutHandle)
          clearTimeout(timeoutHandle);
      }
    };

    const onRequestFinished = (request: { url: () => string }) => {
      if (matchesCaptchaUrl(request.url())) {
        activeRequestCount--;
        resetTimeout();
      }
    };

    // Wait for a CAPTCHA request for up to 2 minutes
    const initialTimeout = setTimeout(() => {
      if (!requestOccurred) {
        page.off('request', onRequest);
        cleanupListeners();
        reject(new Error('No CAPTCHA image/resource requests detected within 2 minutes.'));
      } else {
        // Start waiting for no CAPTCHA requests
        resetTimeout();
      }
    }, 120000); // 2 minute timeout

    page.on('request', onRequest);
    page.on('requestfinished', onRequestFinished);
    page.on('requestfailed', onRequestFinished);

    // Cleanup the initial timeout if a CAPTCHA request occurs
    page.on('request', (request: { url: () => string }) => {
      if (matchesCaptchaUrl(request.url())) {
        clearTimeout(initialTimeout);
      }
    });

    const onAbort = () => {
      cleanupListeners();
      clearTimeout(initialTimeout);
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  }); 
}

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

/**
 * A simple async mutex. Only one holder at a time; others queue up.
 * Usage:
 *   const release = await mutex.acquire();
 *   try { ... } finally { release(); }
 */
export class AsyncMutex {
  private queue: Array<(release: () => void) => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push((release) => resolve(release));
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next(() => this.release());
    } else {
      this.locked = false;
    }
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get queueLength(): number {
    return this.queue.length;
  }
}

/**
 * An async semaphore that allows up to `maxConcurrency` holders at a time.
 * Usage:
 *   const release = await semaphore.acquire();
 *   try { ... } finally { release(); }
 */
export class AsyncSemaphore {
  private currentCount = 0;
  private queue: Array<(release: () => void) => void> = [];

  constructor(private maxConcurrency: number) {}

  async acquire(): Promise<() => void> {
    if (this.currentCount < this.maxConcurrency) {
      this.currentCount++;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push((release) => resolve(release));
    });
  }

  private release(): void {
    this.currentCount--;
    if (this.queue.length > 0) {
      this.currentCount++;
      const next = this.queue.shift()!;
      next(() => this.release());
    }
  }

  get activeCount(): number {
    return this.currentCount;
  }

  get waitingCount(): number {
    return this.queue.length;
  }
}