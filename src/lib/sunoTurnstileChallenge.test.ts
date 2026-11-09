import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import {
  createInstrumentedTurnstileScript,
  solveTurnstileChallenges
} from './sunoTurnstileChallenge';

test('patches the loaded API and only intercepts the generation widget', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const controller = new AbortController();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    const turnstileScript = createInstrumentedTurnstileScript(
      createTurnstileApiScript()
    );
    await page.route('https://suno.com/create*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: createTurnstilePage(turnstileScript)
      })
    );
    await page.goto('https://suno.com/create?private=value');
    await page.waitForFunction(
      () =>
        (
          window as typeof window & {
            __sunoTurnstileHookState?: { challenges: unknown[] };
          }
        ).__sunoTurnstileHookState?.challenges.length === 1
    );

    const hookState = await page.evaluate(() => {
      const hookWindow = window as typeof window & {
        __sunoTurnstileHookState?: {
          apiDetected: boolean;
          challenges: unknown[];
          instrumentedApiCount: number;
        };
        authResults: unknown[];
        authWidgetId?: string;
        originalApi: unknown;
        originalCalls: string[];
        originalRenderCount: number;
        turnstile: unknown;
        widgetId?: string;
      };
      return {
        apiDetected: hookWindow.__sunoTurnstileHookState?.apiDetected,
        authResults: hookWindow.authResults,
        authWidgetId: hookWindow.authWidgetId,
        challengeCount: hookWindow.__sunoTurnstileHookState?.challenges.length,
        instrumentedApiCount:
          hookWindow.__sunoTurnstileHookState?.instrumentedApiCount,
        originalCalls: hookWindow.originalCalls,
        originalRenderCount: hookWindow.originalRenderCount,
        sameApiReference: hookWindow.originalApi === hookWindow.turnstile,
        widgetId: hookWindow.widgetId
      };
    });
    assert.deepEqual(
      { ...hookState, pageErrors },
      {
        apiDetected: true,
        authResults: [
          'execute-result',
          'reset-result',
          'response-result',
          false,
          'remove-result'
        ],
        authWidgetId: 'original-widget',
        challengeCount: 1,
        instrumentedApiCount: 1,
        originalCalls: [
          'render:#aa-turnstile',
          'execute:original-widget',
          'reset:original-widget',
          'getResponse:original-widget',
          'isExpired:original-widget',
          'remove:original-widget'
        ],
        originalRenderCount: 1,
        sameApiReference: true,
        widgetId: 'suno-turnstile-1',
        pageErrors: []
      }
    );

    let solveCount = 0;
    const solving = solveTurnstileChallenges(
      page,
      controller.signal,
      async (challenge) => {
        solveCount++;
        assert.equal(challenge.websiteKey, 'dynamic-site-key');
        assert.equal(challenge.websiteURL, 'https://suno.com/create');
        await page.evaluate(() =>
          (
            window as typeof window & { remountTurnstile: () => void }
          ).remountTurnstile()
        );
        return 'solved-turnstile-token';
      }
    );

    await Promise.race([
      solving,
      page.waitForFunction(
        () =>
          (window as typeof window & { callbackToken?: string })
            .callbackToken === 'solved-turnstile-token'
      )
    ]);
    controller.abort();
    await solving;

    assert.equal(solveCount, 1);
    assert.equal(
      await page.evaluate(
        () =>
          (window as typeof window & { originalRenderCount: number })
            .originalRenderCount
      ),
      1
    );
    assert.equal(
      await page.locator('input[name="cf-turnstile-response"]').count(),
      0
    );
    assert.equal(
      await page.evaluate(
        () => (window as typeof window & { widgetId: string }).widgetId
      ),
      'suno-turnstile-2'
    );
  } finally {
    controller.abort();
    await browser.close();
  }
});

function createTurnstileApiScript(): string {
  return `
    window.originalCalls = [];
    window.originalRenderCount = 0;
    window.turnstile = {
      render(container) {
        window.originalCalls.push('render:' + container);
        window.originalRenderCount++;
        return 'original-widget';
      },
      execute(reference) {
        window.originalCalls.push('execute:' + reference);
        return 'execute-result';
      },
      reset(reference) {
        window.originalCalls.push('reset:' + reference);
        return 'reset-result';
      },
      getResponse(reference) {
        window.originalCalls.push('getResponse:' + reference);
        return 'response-result';
      },
      isExpired(reference) {
        window.originalCalls.push('isExpired:' + reference);
        return false;
      },
      remove(reference) {
        window.originalCalls.push('remove:' + reference);
        return 'remove-result';
      }
    };
    window.originalApi = window.turnstile;
  `;
}

function createTurnstilePage(turnstileScript: string): string {
  return `
    <div id="aa-turnstile"></div>
    <div id="generation-turnstile-container"></div>
    <script>${turnstileScript}</script>
    <script>
      window.authWidgetId = window.originalApi.render('#aa-turnstile', {
        sitekey: 'auth-site-key'
      });
      window.authResults = [
        window.originalApi.execute(window.authWidgetId),
        window.originalApi.reset(window.authWidgetId),
        window.originalApi.getResponse(window.authWidgetId),
        window.originalApi.isExpired(window.authWidgetId),
        window.originalApi.remove(window.authWidgetId)
      ];
      window.mountTurnstile = () => {
        window.widgetId = window.originalApi.render('#generation-turnstile-container', {
          sitekey: 'dynamic-site-key',
          callback: (token) => { window.callbackToken = token; }
        });
        window.originalApi.execute(window.widgetId);
      };
      window.remountTurnstile = () => {
        window.originalApi.remove(window.widgetId);
        window.mountTurnstile();
      };
      window.mountTurnstile();
    </script>
  `;
}
