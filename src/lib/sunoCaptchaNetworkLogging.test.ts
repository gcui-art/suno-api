import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import {
  attachCaptchaNetworkLogging,
  CaptchaNetworkEvent
} from './sunoCaptchaNetworkLogging';

test('captures Turnstile response bodies and frame navigation', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const events: CaptchaNetworkEvent[] = [];
  const messages: string[] = [];

  try {
    attachCaptchaNetworkLogging(context, '/api/generate/v2-web/', {
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message)
    }, events);
    const page = await context.newPage();
    await page.route('https://suno.com/create', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/test"></iframe>'
    }));
    await page.route('https://challenges.cloudflare.com/**', (route) => {
      if (route.request().url().includes('/flow/')) {
        return route.fulfill({
          contentType: 'application/json',
          headers: { 'cf-ray': 'test-ray-id' },
          body: '{"error":600010}'
        });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: '<script>fetch("/cdn-cgi/challenge-platform/turnstile/flow/test")</script>'
      });
    });

    await page.goto('https://suno.com/create');
    await waitForResponseBody(page, events);

    const response = events.find((event) => event.responseBody === '{"error":600010}');
    assert.ok(response);
    assert.equal(response.responseHeaders?.['cf-ray'], 'test-ray-id');
    assert.ok(events.some((event) => (
      event.type === 'frame-navigated' && event.url.endsWith('/turnstile/challenge')
    )));
    assert.ok(messages.some((message) => (
      message.includes('response: 200 fetch') && message.endsWith('/turnstile/flow')
    )));
  } finally {
    await browser.close();
  }
});

async function waitForResponseBody(
  page: import('playwright').Page,
  events: CaptchaNetworkEvent[]
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!events.some((event) => event.responseBody !== undefined)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Turnstile response body');
    await page.waitForTimeout(50);
  }
}
