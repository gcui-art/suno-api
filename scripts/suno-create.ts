/**
 * 用 Playwright 遍历 Suno 账号，打开 suno.com/create，填入 prompt 并点击 Create song。
 *
 * 用法:
 *   npx tsx scripts/suno-create.ts "your song prompt here"
 *   npx tsx scripts/suno-create.ts "your song prompt here" --headless
 *   npx tsx scripts/suno-create.ts "your song prompt here" --email user@example.com
 *   npx tsx scripts/suno-create.ts "your song prompt here" --keep-open-on-failure
 *
 * 默认遍历 DB 中所有 enabled 账号。每个账号使用独立 browser context。
 */
import { chromium, type Browser, type BrowserContext, type Page, type Response, type Video } from 'playwright';
import * as cookie from 'cookie';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDb } from '../src/lib/db';
import { finishSunoCreateRun, startSunoCreateRun } from '../src/lib/sunoCreateRunStore';
import {
  CREATE_SONG_BUTTON_SELECTOR,
  waitForPromptTextarea,
} from '../src/lib/sunoCreateSelectors';
import {
  describePointerBlocker,
  waitForPointerTarget,
} from '../src/lib/sunoPopupHandler';

const DEFAULT_PROMPT = 'A chill lo-fi hip hop beat with soft piano and rain sounds';
const TIMEOUT = 60_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const INVALID_COOKIE_RE = /[\x00-\x1f\x7f;,"]/;
const DEBUG_SAVE = process.env.CAPTCHA_DEBUG_SAVE === 'true';
const VIDEO_DIR = path.join(process.cwd(), 'logs', 'create-videos');
const FAILURE_DIR = path.join(process.cwd(), 'logs', 'create-failures');

interface AccountRow {
  id: string;
  email: string;
  cookie: string;
}

interface CliOptions {
  prompt: string;
  headless: boolean;
  emails: string[];
  verbose: boolean;
  keepOpenOnFailure: boolean;
}

interface AccountResult {
  email: string;
  ok: boolean;
  error?: string;
}

function parseCliOptions(): CliOptions {
  const emails: string[] = [];
  const promptParts: string[] = [];
  let headless = false;
  let verbose = false;
  let keepOpenOnFailure = false;

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--headless') {
      headless = true;
      continue;
    }
    if (arg === '--verbose') {
      verbose = true;
      continue;
    }
    if (arg === '--keep-open-on-failure') {
      keepOpenOnFailure = true;
      continue;
    }
    if (arg === '--email') {
      const email = process.argv[i + 1];
      if (!email) throw new Error('--email requires a value');
      emails.push(email);
      i++;
      continue;
    }
    if (arg === '--help') {
      printUsage();
      process.exit(0);
    }
    promptParts.push(arg);
  }

  return {
    prompt: promptParts.length > 0 ? promptParts.join(' ') : DEFAULT_PROMPT,
    headless,
    emails,
    verbose,
    keepOpenOnFailure,
  };
}

function printUsage() {
  console.log([
    'Usage:',
    '  npx tsx scripts/suno-create.ts "your song prompt here"',
    '  npx tsx scripts/suno-create.ts "your song prompt here" --headless',
    '  npx tsx scripts/suno-create.ts "your song prompt here" --email user@example.com',
    '  npx tsx scripts/suno-create.ts "your song prompt here" --verbose',
    '  npx tsx scripts/suno-create.ts "your song prompt here" --keep-open-on-failure',
    '',
    'Default: runs all enabled accounts from data/suno.db sequentially.',
  ].join('\n'));
}

async function loadAccounts(emails: string[]): Promise<AccountRow[]> {
  const db = await getDb();
  if (emails.length === 0) {
    return db.prepare(`
      SELECT id, email, cookie
      FROM accounts
      WHERE enabled = 1
      ORDER BY added_at ASC
    `).all() as AccountRow[];
  }

  const accounts: AccountRow[] = [];
  const stmt = db.prepare('SELECT id, email, cookie FROM accounts WHERE email = ? AND enabled = 1 LIMIT 1');
  for (const email of emails) {
    const row = stmt.get([email]) as AccountRow | undefined;
    if (!row) throw new Error(`Enabled account not found: ${email}`);
    accounts.push(row);
  }
  return accounts;
}

function toPlaywrightCookies(cookieStr: string) {
  const parsedCookies = cookie.parse(cookieStr);
  return Object.entries(parsedCookies)
    .filter(([name, value]) => {
      const cookieValue = value as string;
      if (INVALID_COOKIE_RE.test(name) || INVALID_COOKIE_RE.test(cookieValue)) {
        console.warn(`[warn] Skipping invalid cookie: ${name}`);
        return false;
      }
      return true;
    })
    .map(([name, value]) => ({
      name,
      value: value as string,
      domain: '.suno.com',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'None' as const,
    }));
}

async function createAccountContext(browser: Browser, account: AccountRow): Promise<BrowserContext> {
  return browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    recordVideo: DEBUG_SAVE
      ? { dir: VIDEO_DIR, size: { width: 1280, height: 800 } }
      : undefined,
    storageState: {
      cookies: toPlaywrightCookies(account.cookie),
      origins: [],
    },
  });
}

/** 失败现场：整页截图 + DOM，方便看出是登录掉了、被 Cloudflare 拦了，还是选择器又变了。 */
async function saveFailureArtifacts(page: Page, account: AccountRow): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = path.join(FAILURE_DIR, `${account.email}-${stamp}`);
  try {
    await mkdir(FAILURE_DIR, { recursive: true });
    await page.screenshot({ path: `${prefix}.png`, fullPage: true });
    await writeFile(`${prefix}.html`, await page.content(), 'utf8');
    console.log(`[${account.email}] Failure artifacts: ${prefix}.png / .html`);
  } catch (error: any) {
    console.log(`[${account.email}] Failed to save artifacts:`, error?.message ?? error);
  }
}

function isGenerateUrl(url: string): boolean {
  return url.includes('/api/generate') || url.includes('/api/custom_generate');
}

function isHcaptchaFlowUrl(url: string): boolean {
  return url.includes('checksiteconfig') || url.includes('/getcaptcha/');
}

function attachNetworkLogging(context: BrowserContext, account: AccountRow, verbose: boolean) {
  context.on('request', (req) => {
    const url = req.url();
    const isHcaptcha = isHcaptchaFlowUrl(url);
    const isGenerate = isGenerateUrl(url) && req.method() === 'POST';
    if (!isHcaptcha && !isGenerate) return;

    console.log(`\n[${account.email}] [REQ]`, req.method(), url);
    if (verbose) {
      console.log(`[${account.email}] [REQ headers]`, JSON.stringify(req.headers(), null, 2));
      const postData = req.postData();
      if (postData) console.log(`[${account.email}] [REQ body]`, postData);
    }
  });

  context.on('response', async (resp) => {
    const url = resp.url();
    const isHcaptcha = isHcaptchaFlowUrl(url);
    const isGenerate = isGenerateUrl(url);
    if (!isHcaptcha && !isGenerate) return;

    console.log(`\n[${account.email}] [RESP]`, resp.status(), url);
    if (verbose) await logResponseBody(account, resp);
  });
}

async function logResponseBody(account: AccountRow, resp: Response) {
  try {
    const headers = resp.headers();
    const ct = headers['content-type'] ?? '';
    if (ct.includes('octet-stream') || ct.includes('msgpack')) {
      const buf = await resp.body();
      console.log(`[${account.email}] [RESP binary size]`, buf.length);
      console.log(`[${account.email}] [RESP hex]`, buf.toString('hex'));
      return;
    }
    const text = await resp.text();
    console.log(`[${account.email}] [RESP body]`, text);
  } catch (e: any) {
    console.log(`[${account.email}] [RESP body error]`, e.message);
  }
}

async function runAccount(
  browser: Browser,
  account: AccountRow,
  prompt: string,
  verbose: boolean,
  keepOpenOnFailure: boolean,
): Promise<AccountResult> {
  console.log(`\n=== Account: ${account.email} (${account.id}) ===`);
  const runId = await startSunoCreateRun(account.id, account.email);
  const context = await createAccountContext(browser, account);
  attachNetworkLogging(context, account, verbose);

  let page: Page | undefined;
  let video: Video | undefined;

  try {
    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    page.setDefaultNavigationTimeout(TIMEOUT);
    video = page.video() ?? undefined;

    await openCreatePage(page, account);
    await fillPrompt(page, prompt, account);
    const generatePromise = waitForGenerateResponse(page);

    console.log(`[${account.email}] Clicking "Create song"...`);
    if (!(await waitForPointerTarget(page, CREATE_SONG_BUTTON_SELECTOR))) {
      console.log(
        `[${account.email}] Create song button covered by `
          + `${await describePointerBlocker(page, CREATE_SONG_BUTTON_SELECTOR)}`,
      );
    }
    await page.locator(CREATE_SONG_BUTTON_SELECTOR).click();

    const genResp = await generatePromise;
    await logGenerateResponse(account, genResp);
    const ok = Boolean(genResp);
    await finishSunoCreateRun(
      runId,
      ok ? 'success' : 'failed',
      ok ? 'Generate API response captured' : 'No generate API response captured within timeout',
      genResp?.url(),
    );
    if (!ok && keepOpenOnFailure) {
      console.log(`[${account.email}] Keeping browser open for inspection. Press Ctrl+C when done.`);
      await page.waitForTimeout(24 * 60 * 60 * 1000);
    } else {
      await page.waitForTimeout(3000);
    }
    return { email: account.email, ok };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    console.error(`[${account.email}] Error:`, message);
    if (page) await saveFailureArtifacts(page, account);
    await finishSunoCreateRun(runId, 'failed', message);
    if (keepOpenOnFailure) {
      console.log(`[${account.email}] Keeping browser open after error. Press Ctrl+C when done.`);
      await context.pages()[0]?.waitForTimeout(24 * 60 * 60 * 1000);
    }
    return { email: account.email, ok: false, error: message };
  } finally {
    await context.close().catch(() => {});
    if (video) {
      try {
        await mkdir(VIDEO_DIR, { recursive: true });
        const target = path.join(VIDEO_DIR, `${account.email}-${Date.now()}.webm`);
        await video.saveAs(target);
        console.log(`[${account.email}] Video: ${target}`);
      } catch (error: any) {
        console.log(`[${account.email}] Failed to save video:`, error?.message ?? error);
      }
    }
  }
}

async function openCreatePage(page: Page, account: AccountRow) {
  console.log(`[${account.email}] Navigating to https://suno.com/create ...`);
  await page.goto('https://suno.com/create', {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUT,
  });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {
    console.log(`[${account.email}] networkidle timeout, continuing anyway`);
  });
}

async function fillPrompt(
  page: Page,
  prompt: string,
  account: AccountRow,
) {
  const handle = await waitForPromptTextarea(page, TIMEOUT);
  if (!handle) {
    throw new Error(
      `create page never exposed a prompt textarea (url=${page.url()})`,
    );
  }
  const { locator: textarea, selector: textareaSelector } = handle;
  console.log(`[${account.email}] Prompt textarea matched by ${textareaSelector}`);

  await Promise.race([
    page.waitForResponse((r) => r.url().includes('checksiteconfig'), { timeout: 8_000 })
      .then(() => console.log(`[${account.email}] checksiteconfig done`))
      .catch(() => {}),
    page.waitForTimeout(8_000),
  ]);

  if (await waitForPointerTarget(page, textareaSelector)) {
    await textarea.click({ timeout: 15_000 });
  } else {
    console.log(
      `[${account.email}] Textarea is covered by `
        + `${await describePointerBlocker(page, textareaSelector)}; focusing via DOM`,
    );
    await textarea.evaluate((element) => (element as HTMLTextAreaElement).focus());
  }
  await textarea.fill('');
  await page.waitForTimeout(500);
  await textarea.type(prompt, { delay: 40 });

  const createBtn = page.locator(CREATE_SONG_BUTTON_SELECTOR);
  await createBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
  await page.waitForFunction(
    (selector) => {
      const btn = document.querySelector<HTMLButtonElement>(selector);
      return btn && !btn.disabled;
    },
    CREATE_SONG_BUTTON_SELECTOR,
    { timeout: TIMEOUT },
  );
}

function waitForGenerateResponse(page: Page): Promise<Response | null> {
  return page.waitForResponse(
    (resp) =>
      isGenerateUrl(resp.url()) && resp.status() < 400,
    { timeout: TIMEOUT },
  ).catch(() => null);
}

async function logGenerateResponse(account: AccountRow, genResp: Awaited<ReturnType<typeof waitForGenerateResponse>>) {
  if (!genResp) {
    console.log(`[${account.email}] No generate API response captured within timeout`);
    return;
  }

  console.log(`[${account.email}] Generate API called:`, genResp.url());
  console.log(`[${account.email}] Status:`, genResp.status());
}

function printSummary(results: AccountResult[]) {
  console.log('\n=== Summary ===');
  for (const result of results) {
    const status = result.ok ? 'OK' : 'FAILED';
    const error = result.error ? ` | ${result.error}` : '';
    console.log(`${status} ${result.email}${error}`);
  }
}

async function main() {
  const options = parseCliOptions();
  const accounts = await loadAccounts(options.emails);
  if (accounts.length === 0) throw new Error('No enabled accounts in DB');

  console.log('Prompt:', options.prompt);
  console.log('Headless:', options.headless);
  console.log('Verbose:', options.verbose);
  console.log('Keep open on failure:', options.keepOpenOnFailure);
  console.log('Accounts:', accounts.map(a => a.email).join(', '));

  const browser = await chromium.launch({
    headless: options.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    slowMo: options.headless ? 0 : 100,
  });

  const results: AccountResult[] = [];
  try {
    for (const account of accounts) {
      results.push(await runAccount(
        browser,
        account,
        options.prompt,
        options.verbose,
        options.keepOpenOnFailure,
      ));
    }
  } finally {
    await browser.close();
  }

  printSummary(results);
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
