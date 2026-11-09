import { Page } from 'playwright';

export const TURNSTILE_HOOK_KEY = '__sunoTurnstileHookState';
const TURNSTILE_API_URL_PATTERN = '**/turnstile/v0/api.js*';
const GENERATION_TURNSTILE_CONTAINER_SELECTOR =
  '#generation-turnstile-container';
const TURNSTILE_WAIT_TIMEOUT_MS = 60_000;
const TURNSTILE_POLL_INTERVAL_MS = 250;
const TURNSTILE_REPLACEMENT_WAIT_MS = 2_000;

type TurnstileChallengeStatus = 'pending' | 'solving' | 'solved';
type TurnstileDeliveryResult = 'callback-missing' | 'delivered' | 'missing';

interface PageTurnstileChallenge {
  id: string;
  websiteKey: string;
  websiteURL: string;
  callback?: unknown;
  container: unknown;
  status: TurnstileChallengeStatus;
  token?: string;
}

interface PageTurnstileHookState {
  challenges: PageTurnstileChallenge[];
  sequence: number;
  apiDetected: boolean;
  instrumentedApiCount: number;
  instrumentedApis: WeakSet<object>;
  lastError?: string;
}

interface TurnstileHookWindow extends Window {
  [TURNSTILE_HOOK_KEY]?: PageTurnstileHookState;
}

interface TurnstileRenderOptions extends Record<string, unknown> {
  callback?: unknown;
  sitekey?: unknown;
}

export interface CapturedTurnstileChallenge {
  id: string;
  websiteKey: string;
  websiteURL: string;
}

export type TurnstileTokenSolver = (
  challenge: CapturedTurnstileChallenge,
  signal: AbortSignal
) => Promise<string>;

export async function installTurnstileChallengeHook(page: Page): Promise<void> {
  await page.route(TURNSTILE_API_URL_PATTERN, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({
      response,
      body: createInstrumentedTurnstileScript(source)
    });
  });
}

export function createInstrumentedTurnstileScript(source: string): string {
  const install = installTurnstileApiHookInPage.toString();
  const patchApi = patchTurnstileApiInPage.toString();
  return `${source}\n;{
    const __name = (target, value) => Object.defineProperty(target, 'name', {
      value,
      configurable: true
    });
    (${install})(
      globalThis.turnstile,
      ${JSON.stringify(TURNSTILE_HOOK_KEY)},
      ${JSON.stringify(GENERATION_TURNSTILE_CONTAINER_SELECTOR)},
      (${patchApi})
    );
  }`;
}

export async function solveTurnstileChallenges(
  page: Page,
  signal: AbortSignal,
  solveToken: TurnstileTokenSolver,
  onSolved?: (challenge: CapturedTurnstileChallenge) => void
): Promise<void> {
  const challenge = await waitForTurnstileChallenge(page, signal);
  if (!challenge) return;

  const token = await solveToken(challenge, signal);
  if (signal.aborted) return;
  let deliveryChallenge =
    (await claimPendingTurnstileChallenge(page, challenge.websiteKey)) ??
    challenge;
  let deliveryResult = await deliverTurnstileToken(
    page,
    deliveryChallenge.id,
    token
  );
  if (deliveryResult === 'missing') {
    const replacement = await waitForReplacementChallenge(
      page,
      signal,
      challenge.websiteKey
    );
    if (replacement) {
      deliveryChallenge = replacement;
      deliveryResult = await deliverTurnstileToken(page, replacement.id, token);
    }
  }
  if (deliveryResult !== 'delivered') {
    throw new Error(
      'Cloudflare Turnstile token could not be delivered to the page'
    );
  }
  if (!signal.aborted) onSolved?.(deliveryChallenge);
  await waitForAbort(signal);
}

async function waitForTurnstileChallenge(
  page: Page,
  signal: AbortSignal
): Promise<CapturedTurnstileChallenge | undefined> {
  const deadline = Date.now() + TURNSTILE_WAIT_TIMEOUT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    const challenge = await claimPendingTurnstileChallenge(page);
    if (challenge) return challenge;
    if (!(await waitForDuration(signal, TURNSTILE_POLL_INTERVAL_MS)))
      return undefined;
  }
  if (signal.aborted) return undefined;
  throw new Error(
    'Timed out waiting for Cloudflare Turnstile render parameters'
  );
}

async function claimPendingTurnstileChallenge(
  page: Page,
  websiteKey?: string
): Promise<CapturedTurnstileChallenge | undefined> {
  return page.evaluate(
    ({ hookKey, requestedWebsiteKey }) => {
      const hookWindow = window as TurnstileHookWindow;
      const state = hookWindow[hookKey as typeof TURNSTILE_HOOK_KEY];
      const challenge = state?.challenges.findLast(
        (item) =>
          item.status === 'pending' &&
          (!requestedWebsiteKey || item.websiteKey === requestedWebsiteKey)
      );
      if (!challenge) return undefined;
      challenge.status = 'solving';
      return {
        id: challenge.id,
        websiteKey: challenge.websiteKey,
        websiteURL: challenge.websiteURL
      };
    },
    { hookKey: TURNSTILE_HOOK_KEY, requestedWebsiteKey: websiteKey }
  );
}

async function deliverTurnstileToken(
  page: Page,
  challengeId: string,
  token: string
): Promise<TurnstileDeliveryResult> {
  return page.evaluate(
    async ({ hookKey, challengeId: id, token: solvedToken }) => {
      const hookWindow = window as TurnstileHookWindow;
      const challenge = hookWindow[
        hookKey as typeof TURNSTILE_HOOK_KEY
      ]?.challenges.find((item) => item.id === id);
      if (!challenge) return 'missing';

      challenge.status = 'solved';
      challenge.token = solvedToken;
      const callback = resolveTurnstileCallback(challenge.callback);
      if (!callback) return 'callback-missing';
      await callback(solvedToken);
      return 'delivered';

      function resolveTurnstileCallback(
        value: unknown
      ): ((token: string) => unknown) | undefined {
        if (typeof value === 'function')
          return (value as (token: string) => unknown).bind(hookWindow);
        if (typeof value !== 'string') return undefined;
        const parts = value.split('.');
        let owner: unknown = hookWindow;
        for (const part of parts.slice(0, -1)) {
          if (!owner || typeof owner !== 'object') return undefined;
          owner = (owner as Record<string, unknown>)[part];
        }
        if (!owner || typeof owner !== 'object') return undefined;
        const resolved = (owner as Record<string, unknown>)[parts.at(-1) ?? ''];
        return typeof resolved === 'function'
          ? (resolved as (token: string) => unknown).bind(owner)
          : undefined;
      }
    },
    { hookKey: TURNSTILE_HOOK_KEY, challengeId, token }
  );
}

async function waitForReplacementChallenge(
  page: Page,
  signal: AbortSignal,
  websiteKey: string
): Promise<CapturedTurnstileChallenge | undefined> {
  const deadline = Date.now() + TURNSTILE_REPLACEMENT_WAIT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    const challenge = await claimPendingTurnstileChallenge(page, websiteKey);
    if (challenge) return challenge;
    if (!(await waitForDuration(signal, TURNSTILE_POLL_INTERVAL_MS)))
      return undefined;
  }
  return undefined;
}

function installTurnstileApiHookInPage(
  apiValue: unknown,
  hookKey: string,
  generationContainerSelector: string,
  patchApi: (
    api: Record<PropertyKey, unknown>,
    state: PageTurnstileHookState,
    generationContainerSelector: string
  ) => void
): void {
  const hookWindow = window as TurnstileHookWindow;
  const stateKey = hookKey as typeof TURNSTILE_HOOK_KEY;
  let state = hookWindow[stateKey];
  if (!state) {
    state = {
      challenges: [],
      sequence: 0,
      apiDetected: false,
      instrumentedApiCount: 0,
      instrumentedApis: new WeakSet<object>()
    };
    Object.defineProperty(hookWindow, stateKey, { value: state });
  }
  if (!apiValue || typeof apiValue !== 'object') {
    state.lastError = 'Cloudflare Turnstile API was not available after api.js';
    return;
  }
  state.apiDetected = true;
  try {
    patchApi(
      apiValue as Record<PropertyKey, unknown>,
      state,
      generationContainerSelector
    );
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
  }
}

function patchTurnstileApiInPage(
  api: Record<PropertyKey, unknown>,
  state: PageTurnstileHookState,
  generationContainerSelector: string
): void {
  if (state.instrumentedApis.has(api)) return;
  const methodNames = [
    'render',
    'execute',
    'reset',
    'remove',
    'getResponse',
    'isExpired'
  ] as const;
  const originals = new Map<PropertyKey, unknown>(
    methodNames.map((name) => [name, api[name]])
  );
  if (typeof originals.get('render') !== 'function') {
    throw new Error('Cloudflare Turnstile render API is unavailable');
  }

  const findChallenge = (reference: unknown) => {
    if (typeof reference === 'string') {
      return state.challenges.find(
        (item) => item.id === reference || item.container === reference
      );
    }
    if (reference)
      return state.challenges.find((item) => item.container === reference);
    return undefined;
  };
  const callOriginal = (method: PropertyKey, args: unknown[]): unknown => {
    const original = originals.get(method);
    return typeof original === 'function'
      ? original.apply(api, args)
      : original;
  };
  const resolveContainer = (container: unknown): Element | null => {
    if (typeof container === 'string') return document.querySelector(container);
    return container instanceof Element ? container : null;
  };

  api.render = (...args: unknown[]) => {
    const container = args[0];
    const element = resolveContainer(container);
    const options = isRecord(args[1])
      ? (args[1] as TurnstileRenderOptions)
      : {};
    const websiteKey =
      typeof options.sitekey === 'string' && options.sitekey.trim()
        ? options.sitekey.trim()
        : element?.getAttribute('data-sitekey')?.trim() || undefined;
    if (!element?.matches(generationContainerSelector) || !websiteKey)
      return callOriginal('render', args);

    const id = `suno-turnstile-${++state.sequence}`;
    state.challenges.push({
      id,
      websiteKey,
      websiteURL: `${location.origin}${location.pathname}`,
      callback: options.callback,
      container,
      status: 'pending'
    });
    return id;
  };

  for (const method of methodNames.slice(1)) {
    api[method] = (...args: unknown[]) => {
      const challenge = findChallenge(args[0]);
      if (!challenge) return callOriginal(method, args);
      if (method === 'execute' || method === 'reset') {
        if (challenge.status !== 'solving') {
          challenge.status = 'pending';
          challenge.token = undefined;
        }
        return undefined;
      }
      if (method === 'remove') {
        state.challenges.splice(state.challenges.indexOf(challenge), 1);
        return undefined;
      }
      if (method === 'getResponse') return challenge.token ?? '';
      return !challenge.token;
    };
  }

  state.instrumentedApis.add(api);
  state.instrumentedApiCount++;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true })
  );
}

function waitForDuration(
  signal: AbortSignal,
  durationMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, durationMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
