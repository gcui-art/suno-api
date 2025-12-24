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
  // console.log(`Sleeping for ${timeout / 1000} seconds`);
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
 * Waits for an hCaptcha image requests and then waits for all of them to end
 * @param page
 * @param signal `const controller = new AbortController(); controller.status`
 * @param maxWaitMs Maximum time to wait for initial request (default: 5000ms)
 * @returns {Promise<void>} 
 */
export const waitForRequests = (page: Page, signal: AbortSignal, maxWaitMs: number = 5000): Promise<void> => {
  return new Promise((resolve, reject) => {
    // Match both standard hCaptcha and enterprise/custom domain patterns:
    // - Standard: https://img*.hcaptcha.com/*
    // - Suno enterprise: https://hcaptcha-imgs-prod.suno.com/*
    const urlPattern = /^https:\/\/(img[a-zA-Z0-9]*\.hcaptcha\.com|hcaptcha-imgs-prod\.suno\.com)\/.*$/;
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
      if (urlPattern.test(request.url())) {
        requestOccurred = true;
        activeRequestCount++;
        if (timeoutHandle)
          clearTimeout(timeoutHandle);
      }
    };

    const onRequestFinished = (request: { url: () => string }) => {
      if (urlPattern.test(request.url())) {
        activeRequestCount--;
        resetTimeout();
      }
    };

    // Wait for an hCaptcha request for up to maxWaitMs (default 5 seconds)
    // If no requests happen, assume images are already loaded and proceed
    const initialTimeout = setTimeout(() => {
      cleanupListeners();
      if (!requestOccurred) {
        // No requests happened - images might already be loaded, resolve instead of reject
        console.log('\x1b[34m%s\x1b[0m', `⚠️  No hCaptcha image requests detected within ${maxWaitMs}ms - images may already be loaded, proceeding...`);
        resolve();
      } else {
        // Start waiting for no hCaptcha requests
        resetTimeout();
      }
    }, maxWaitMs);

    page.on('request', onRequest);
    page.on('requestfinished', onRequestFinished);
    page.on('requestfailed', onRequestFinished);

    // Cleanup the initial timeout if an hCaptcha request occurs
    page.on('request', (request: { url: () => string }) => {
      if (urlPattern.test(request.url())) {
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