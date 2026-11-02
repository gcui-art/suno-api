import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Browser, type BrowserServer, type Cookie, type Page, type Route } from 'playwright';
import {
  collectSunoApiCookies,
  installSunoBrowserGenerateCapture,
  isSunoBrowserGenerateRequest,
  prepareSunoBrowserCookies,
  recoverSunoBrowserSession,
  SunoBrowserRecoveryTimeoutError,
} from './sunoBrowserRecovery';

const GENERATE_URL = 'https://studio-api-prod.suno.com/api/generate/v2-web/';

test('matches only the exact Suno generate host, path and POST method', () => {
  assert.equal(isSunoBrowserGenerateRequest(GENERATE_URL, 'POST'), true);
  assert.equal(isSunoBrowserGenerateRequest(`${GENERATE_URL}?source=web`, 'POST'), true);
  for (const url of [
    GENERATE_URL.replace('https:', 'http:'),
    GENERATE_URL.replace('suno.com', 'suno.com.example.org'),
    `${GENERATE_URL}extra`,
    'https://example.org/?url=' + GENERATE_URL,
  ]) assert.equal(isSunoBrowserGenerateRequest(url, 'POST'), false);
  assert.equal(isSunoBrowserGenerateRequest(GENERATE_URL, 'GET'), false);
});

test('refreshes every session cookie without mutating input or duplicating names', () => {
  const cookies = { __session: 'old', __session_suffix: 'old-suffix', __client: 'client', invalid: 'bad;cookie' };
  const prepared = prepareSunoBrowserCookies({ cookies, currentToken: 'fresh' });
  assert.deepEqual(prepared.map(({ name, value }) => [name, value]), [
    ['__session', 'fresh'], ['__session_suffix', 'fresh'], ['__client', 'client'],
  ]);
  assert.equal(cookies.__session, 'old');
});

test('exports only unexpired cookies applicable to the Suno API host', () => {
  const base: Cookie = { name: 'shared', value: 'value', domain: '.suno.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'None' };
  assert.deepEqual(collectSunoApiCookies([
    base,
    { ...base, name: 'api', domain: 'studio-api-prod.suno.com' },
    { ...base, name: 'auth-only', domain: 'auth.suno.com' },
    { ...base, name: 'page-only', domain: 'suno.com' },
    { ...base, name: 'unrelated', domain: '.example.org' },
    { ...base, name: 'expired', expires: Date.now() / 1000 - 1 },
  ]), { shared: 'value', api: 'value' });
});

function fakePage() {
  let handler!: (route: Route) => Promise<void>;
  let removed = false;
  return {
    page: {
      route: async (_matcher: unknown, value: typeof handler) => { handler = value; },
      unroute: async () => { removed = true; },
    } as unknown as Page,
    route: (value: Route) => handler(value),
    removed: () => removed,
  };
}

function fakeRoute(body: unknown = { clips: [{ id: 'warmup-clip' }] }, status = 200) {
  const state = { continued: 0, aborted: 0, options: undefined as unknown };
  const route = {
    request: () => ({
      method: () => 'POST',
      allHeaders: async () => ({
        'user-agent': 'Chrome/148',
        authorization: 'Bearer refreshed-session',
        'sec-ch-ua-platform': '"Linux"',
      }),
      response: async () => ({
        status: () => status,
        ok: () => status >= 200 && status < 300,
        json: async () => body,
      }),
    }),
    continue: async (options?: unknown) => { state.continued++; state.options = options; },
    abort: async () => { state.aborted++; },
  } as unknown as Route;
  return { route, state };
}

test('passes the original website request untouched, then blocks duplicate generation', async () => {
  const page = fakePage();
  const controller = new AbortController();
  const capture = await installSunoBrowserGenerateCapture(page.page, controller.signal);
  const early = fakeRoute();
  await page.route(early.route);
  assert.equal(early.state.aborted, 1);
  capture.arm();
  const first = fakeRoute();
  const duplicate = fakeRoute();
  await Promise.all([page.route(first.route), page.route(duplicate.route)]);
  const result = await capture.result;
  assert.equal(first.state.continued, 1);
  assert.equal(first.state.options, undefined);
  assert.equal(duplicate.state.aborted, 1);
  assert.deepEqual(result.clips, [{ id: 'warmup-clip' }]);
  assert.equal(result.authorizationToken, 'refreshed-session');
  assert.equal(result.browserIdentity.secChUaPlatform, '"Linux"');
  await capture.dispose();
  assert.equal(page.removed(), true);
});

test('a response without valid clips and a failed response cannot count as recovery', async () => {
  for (const [body, status] of [[{ clips: [] }, 200], [{ clips: [{ id: 'x' }] }, 403]] as const) {
    const page = fakePage();
    const capture = await installSunoBrowserGenerateCapture(page.page, new AbortController().signal);
    capture.arm();
    await page.route(fakeRoute(body, status).route);
    await assert.rejects(capture.result);
    await capture.dispose();
  }
});

test('deadline cancellation rejects the pending capture and prevents a later submission', async () => {
  const page = fakePage();
  const controller = new AbortController();
  const capture = await installSunoBrowserGenerateCapture(page.page, controller.signal);
  capture.arm();
  controller.abort(new Error('deadline expired'));
  await assert.rejects(capture.result, /deadline expired/);
  const late = fakeRoute();
  await page.route(late.route);
  assert.equal(late.state.continued, 0);
  assert.equal(late.state.aborted, 1);
  await capture.dispose();
});

test('the total deadline closes the browser and drains pending browser work', async (t) => {
  const previousTimeout = process.env.SUNO_BROWSER_RECOVERY_TIMEOUT_MS;
  process.env.SUNO_BROWSER_RECOVERY_TIMEOUT_MS = '20';
  let rejectContext!: (error: Error) => void;
  let closed = 0;
  let drained = false;
  const context = new Promise<never>((_, reject) => { rejectContext = reject; })
    .finally(() => { drained = true; });
  const server = {
    wsEndpoint: () => 'ws://local-test',
    close: async () => { closed++; rejectContext(new Error('Browser closed')); },
    kill: async () => { rejectContext(new Error('Browser killed')); },
    process: () => ({ exitCode: 0 }),
  } as unknown as BrowserServer;
  t.mock.method(chromium, 'launchServer', async () => server);
  t.mock.method(chromium, 'connect', async () => ({
    version: () => '148.0.7778.96',
    newContext: () => context,
  } as unknown as Browser));
  try {
    await assert.rejects(recoverSunoBrowserSession({ cookies: {} }), SunoBrowserRecoveryTimeoutError);
    assert.equal(closed, 1);
    assert.equal(drained, true);
  } finally {
    if (previousTimeout === undefined) delete process.env.SUNO_BROWSER_RECOVERY_TIMEOUT_MS;
    else process.env.SUNO_BROWSER_RECOVERY_TIMEOUT_MS = previousTimeout;
  }
});
