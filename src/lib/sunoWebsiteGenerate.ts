import { chromium } from 'playwright';
import { prepareSunoBrowserCookies, collectSunoApiCookies, installSunoBrowserGenerateCapture, waitForInteractiveChallenge } from './sunoBrowserRecovery';
import { closeKnownPopups } from './sunoPopupHandler';
import type { CaptchaBrowserIdentity, SunoGenerateClip, SunoGeneratePayload } from './sunoCaptchaGenerateCapture';
import { sunoEgressBrowserProxy } from './sunoEgress';

// The workspace query makes the create form hydrate consistently on a cold
// persistent profile. The bare /create route can remain on the shell and never
// expose the v6/custom controls, which looks like a generation timeout.
const CREATE_URL = 'https://suno.com/create?wid=default';
const PROFILE_ROOT = process.env.SUNO_BROWSER_PROFILE_ROOT || '/var/lib/suno-browser/profiles';
const SAFE_KEY = /^[a-zA-Z0-9_.:@-]{1,160}$/;

function isCustomPayload(payload: SunoGeneratePayload): boolean {
  const metadata = payload.metadata;
  return Boolean(metadata && typeof metadata === 'object' &&
    (metadata as Record<string, unknown>).create_mode === 'custom') ||
    Boolean(payload.title || payload.tags || payload.negative_tags ||
      (payload.prompt && !payload.gpt_description_prompt));
}

async function fillCreateForm(page: import('playwright').Page, payload: SunoGeneratePayload): Promise<import('playwright').Locator> {
  const syncEditor = async (locator: import('playwright').Locator) => {
    await locator.click();
    await locator.press('End');
    await locator.press(' ');
    await locator.press('Backspace');
  };
  const custom = isCustomPayload(payload);
  if (custom) {
    const advanced = page.getByRole('tab', { name: /^Advanced$/i }).first();
    if (await advanced.isVisible().catch(() => false) &&
      (await advanced.getAttribute('aria-selected').catch(() => null)) !== 'true') {
      await advanced.click();
    }
    const lyrics = page.getByRole('textbox', { name: 'Lyrics editor' }).first();
    await lyrics.waitFor({ state: 'visible' });
    const lyricText = String(payload.prompt || payload.gpt_description_prompt || '').trim();
    await lyrics.fill(lyricText);
    const title = page.locator('input[placeholder="Song Title (Optional)"]:visible').first();
    const titleText = String(payload.title || '').trim();
    await title.fill(titleText);
    await syncEditor(title);
    const styles = page.locator('textarea[maxlength="1000"]:visible').first();
    const tags = String(payload.tags || '').trim();
    const styleText = tags;
    await styles.waitFor({ state: 'visible' });
    await styles.fill(styleText);
    await syncEditor(styles);
    if (!lyricText && !styleText && !titleText) {
      throw new Error('Suno browser custom generation requires lyrics, styles, or a title');
    }
    await syncEditor(lyrics);
    return lyrics;
  }
  const simple = page.getByRole('tab', { name: /^Simple$/i }).first();
  if (await simple.isVisible().catch(() => false) &&
    (await simple.getAttribute('aria-selected').catch(() => null)) !== 'true') await simple.click();
  const textarea = page.locator('textarea[maxlength="3000"]:visible').first();
  const promptText = String(payload.gpt_description_prompt || payload.prompt || '').trim();
  const prompt = payload.make_instrumental === true
    ? `Instrumental music only, no vocals. ${promptText}` : promptText;
  if (!prompt) throw new Error('Suno browser generation requires a prompt');
  await textarea.fill(prompt);
  await syncEditor(textarea);
  return textarea;
}

async function dismissCreateOverlays(page: import('playwright').Page): Promise<void> {
  // A persisted profile can reopen the Lyricist popover after navigation. Its
  // inert backdrop intercepts clicks even though the create form is visible.
  const close = page.getByRole('button', { name: 'Close', exact: true }).filter({ visible: true }).first();
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => undefined);
  await page.keyboard.press('Escape').catch(() => undefined);
}

export async function generateWithSunoWebsite(options: {
  accountId: string;
  cookies: Record<string, string | undefined>;
  currentToken?: string;
  payload: SunoGeneratePayload;
  signal?: AbortSignal;
  onSubmitted?: () => void;
  onAccepted?: (clips: SunoGenerateClip[]) => void;
}): Promise<{
  clips: SunoGenerateClip[];
  cookies: Record<string, string>;
  browserIdentity?: CaptchaBrowserIdentity;
}> {
  if (!SAFE_KEY.test(options.accountId)) throw new Error('Invalid Suno account id');
  options.signal?.throwIfAborted();
  const profileDir = `${PROFILE_ROOT}/${options.accountId}`;
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    locale: process.env.BROWSER_LOCALE || 'en-US',
    timezoneId: process.env.BROWSER_TIMEZONE || 'UTC',
    serviceWorkers: 'block',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    proxy: sunoEgressBrowserProxy(),
  });
  let submitted = false;
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  let capture: Awaited<ReturnType<typeof installSunoBrowserGenerateCapture>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await context.addCookies(prepareSunoBrowserCookies(options));
    const page = context.pages()[0] || await context.newPage();
    // Suno's initial React hydration can take a while on the server display.
    // Keep navigation/UI waits bounded, but long enough for a cold Chromium
    // profile and do not use keyboard typing for the whole prompt: each key
    // can trigger an expensive editor rerender for long Chinese prompts.
    page.setDefaultTimeout(120_000);
    if (process.env.SUNO_BROWSER_DIAGNOSTIC === 'true') {
      page.on('request', req => { const u = new URL(req.url()); if (req.method() === 'POST') console.info('[Diagnostic] POST', u.origin + u.pathname); });
      page.on('requestfailed', req => { const u = new URL(req.url()); console.info('[Diagnostic] failed', u.origin + u.pathname, req.failure()?.errorText); });
      page.on('response', res => { const u = new URL(res.url()); if (res.status() >= 400) console.info('[Diagnostic] HTTP', res.status(), u.origin + u.pathname); });
    }
    capture = await installSunoBrowserGenerateCapture(page, controller.signal, () => {
      submitted = true;
      options.onSubmitted?.();
    });
    console.info('[SunoBrowser] goto start', CREATE_URL, options.accountId);
    await page.goto(CREATE_URL, { waitUntil: 'commit', timeout: 120_000 });
    console.info('[SunoBrowser] goto committed', page.url());
    await page.waitForLoadState('domcontentloaded', { timeout: 120_000 }).catch(() => undefined);
    await page.waitForTimeout(5_000);
    await closeKnownPopups(page);
    await dismissCreateOverlays(page);
    console.info('[SunoBrowser] overlays dismissed');
    await page.keyboard.press('Escape').catch(() => undefined);
    const modelButton = page.getByRole('button', { name: /^v6(?:-mini)?$/i }).first();
    await modelButton.waitFor({ state: 'visible' });
    console.info('[SunoBrowser] v6 visible');
    await modelButton.click();
    const v6Pro = page.getByRole('menuitemradio', { name: /^v6\s+Pro\b/i }).first();
    if (await v6Pro.isVisible().catch(() => false) &&
      (await v6Pro.getAttribute('aria-checked').catch(() => null)) !== 'true') await v6Pro.click();
    await page.keyboard.press('Escape').catch(() => undefined);
    await fillCreateForm(page, options.payload);
    console.info('[SunoBrowser] form filled', isCustomPayload(options.payload));
    // `fill()` updates the DOM value but this editor only enables Create after
    // it observes a keyboard input. fillCreateForm synchronizes each edited
    // control with a no-op key pair without slow per-character typing.
    const button = page.locator('button[aria-label="Create song"]:visible').first()
      .or(page.getByRole('button', { name: /^Create(?: song)?$/i }).first());
    await button.waitFor({ state: 'visible' });
    console.info('[SunoBrowser] create visible', await button.isEnabled().catch(() => false));
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((el) => {
      const button = el as HTMLButtonElement;
      const label = (button.getAttribute('aria-label') || button.textContent || '').trim();
      return !button.disabled && /create(?: song)?/i.test(label) && Boolean(button.offsetWidth || button.offsetHeight);
    }));
    options.signal?.throwIfAborted();
    capture.arm();
    console.info('[SunoBrowser] clicking create');
    await button.click();
    console.info('[SunoBrowser] create clicked');
    const generated = await Promise.race([
      capture.result,
      waitForInteractiveChallenge(page, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(submitted
          ? 'Suno browser submitted generation but response is unknown'
          : 'Suno browser did not submit generation within its deadline')), 60_000);
      }),
    ]);
    options.onAccepted?.(generated.clips);
    const cookies = collectSunoApiCookies(await context.cookies('https://studio-api-prod.suno.com'));
    // Expose the real browser identity so the direct API transport can reuse it.
    return { clips: generated.clips, cookies, browserIdentity: generated.browserIdentity };
  } catch (error) {
    if (error && typeof error === 'object') {
      Object.assign(error, { browserReplaySafe: !submitted });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    controller.abort(new Error('Suno website operation finished'));
    await context.close().catch(() => undefined);
    await capture?.dispose();
  }
}
