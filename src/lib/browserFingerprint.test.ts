import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import {
  createDesktopChromiumClientHints,
  createMatchingChromiumUserAgent
} from './browserFingerprint';

test('builds a Linux user agent matching the actual Chromium version', () => {
  assert.equal(
    createMatchingChromiumUserAgent('148.0.7778.96', 'linux', 'x64'),
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36'
  );
});

test('rejects an incomplete Chromium version', () => {
  assert.throws(
    () => createMatchingChromiumUserAgent('148', 'linux', 'x64'),
    /Unsupported Chromium version/
  );
});

test('builds desktop client hints matching the user agent', () => {
  assert.deepEqual(
    createDesktopChromiumClientHints(
      createMatchingChromiumUserAgent('148.0.7778.96', 'linux', 'x64')
    ),
    {
      'sec-ch-ua': '"Chromium";v="148", "Not=A?Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"'
    }
  );
});

test('matches the running Chromium user agent and client hints', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const version = browser.version();
    const majorVersion = version.split('.')[0];
    const context = await browser.newContext({
      userAgent: createMatchingChromiumUserAgent(version, 'linux', 'x64')
    });
    const page = await context.newPage();
    let navigationHeaders: Record<string, string> | undefined;
    await page.route('https://suno.com/create', (route) => {
      navigationHeaders = route.request().headers();
      return route.fulfill({ contentType: 'text/html', body: 'ok' });
    });
    await page.goto('https://suno.com/create');
    const identity = await page.evaluate(async () => {
      const data = (navigator as Navigator & {
        userAgentData?: {
          getHighEntropyValues(hints: string[]): Promise<{
            fullVersionList: Array<{ brand: string; version: string }>;
          }>;
        };
      }).userAgentData;
      return {
        userAgent: navigator.userAgent,
        highEntropy: await data?.getHighEntropyValues(['fullVersionList'])
      };
    });

    assert.match(identity.userAgent, new RegExp(`Chrome/${version.replaceAll('.', '\\.')}`));
    assert.ok(identity.highEntropy?.fullVersionList.some((brand) => (
      brand.brand === 'Chromium' && brand.version === version
    )));
    assert.match(navigationHeaders?.['sec-ch-ua'] ?? '', new RegExp(`v="${majorVersion}"`));
  } finally {
    await browser.close();
  }
});
