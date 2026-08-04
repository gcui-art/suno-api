#!/usr/bin/env node

/**
 * Extract SUNO_COOKIE by automating the suno-api manual flow:
 * 1. Open suno.com/create
 * 2. Log in (automated or manual)
 * 3. Capture Cookie header from requests containing __clerk_api_version
 *
 * @see https://github.com/gcui-art/suno-api#1-obtain-the-cookie-of-your-suno-account
 */

import { chromium } from 'rebrowser-playwright-core';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeSunoSession, verifySunoAuth } from './verify-auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  violet: '\x1b[35m',
};

const SUNO_CREATE_URL = 'https://suno.com/create';
const SUNO_SIGN_IN_URL = 'https://suno.com/sign-in';
const CLERK_URL_PATTERN = /__clerk_api_version/;
const REQUIRED_COOKIE_KEYS = ['__client'];
const CREDENTIAL_ENV_KEYS = ['SUNO_EMAIL', 'SUNO_PASSWORD'];
const AUTH_COOKIE_PATTERN =
  /^(?:__client(?:_[^=]+)?|__client_uat(?:_[^=]+)?|__session|ajs_anonymous_id|suno_device_id|suno_auth_bucket)$/;
const SUNO_COOKIE_URLS = [
  'https://suno.com',
  'https://auth.suno.com',
  'https://clerk.suno.com',
];
// Only real identity-provider / sign-in surfaces. Keep this narrow:
// broad tokens like "oauth" match post-login Suno URLs and leave the script stuck.
const AUTH_FLOW_URL_PATTERN =
  /accounts\.google\.|google\.com\/(?:signin|o\/oauth2)|appleid\.apple\.com|login\.microsoftonline\.com|facebook\.com\/login|github\.com\/login|accounts\.youtube\.com/i;
const BROWSER_PROFILE_DIR = path.join(__dirname, '.browser-profile');

function log(msg, color = '') {
  console.log(color ? `${color}${msg}${c.reset}` : msg);
}

function envFlagEnabled(name, defaultValue = true) {
  const value = process.env[name];
  if (value == null || value === '') return defaultValue;
  return !/^(0|false|no|off)$/i.test(value);
}

function parseArgs(argv) {
  const opts = {
    email: process.env.SUNO_EMAIL || '',
    password: process.env.SUNO_PASSWORD || '',
    save: envFlagEnabled('SUNO_SAVE', true),
    verify: envFlagEnabled('SUNO_VERIFY', true),
    manual: envFlagEnabled('SUNO_MANUAL', false),
    persistProfile: envFlagEnabled('SUNO_PERSIST_PROFILE', true),
    // Prefer system Chrome so npm install does not need a 100MB+ browser download.
    // Use --browser chromium (after npm run install-browsers) for Playwright's bundle.
    channel: process.env.SUNO_BROWSER_CHANNEL || 'chrome',
    executablePath: process.env.SUNO_CHROME_PATH || process.env.CHROME_PATH || '',
    headless: false,
    timeoutMs: 5 * 60 * 1000,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--save' || arg === '-s') opts.save = true;
    else if (arg === '--no-save' || arg === '--print-only') opts.save = false;
    else if (arg === '--no-verify') opts.verify = false;
    else if (arg === '--manual' || arg === '-m') opts.manual = true;
    else if (arg === '--no-profile') opts.persistProfile = false;
    else if (arg === '--headless') opts.headless = true;
    else if (arg === '--email' || arg === '-e') opts.email = argv[++i] || '';
    else if (arg === '--password' || arg === '-p') opts.password = argv[++i] || '';
    else if (arg === '--timeout') opts.timeoutMs = Number(argv[++i]) * 1000;
    else if (arg === '--browser') {
      const value = (argv[++i] || '').toLowerCase();
      if (value === 'chromium' || value === 'bundled') opts.channel = '';
      else opts.channel = value; // chrome | chrome-beta | msedge | ...
    } else if (arg === '--chrome-path' || arg === '--executable-path') {
      opts.executablePath = argv[++i] || '';
      opts.channel = '';
    }
  }

  return opts;
}

function showHelp() {
  log(`${c.bold}Suno Cookie Extractor${c.reset}`, c.violet);
  log('');
  log('Automates the cookie extraction steps from gcui-art/suno-api README.');
  log('');
  log('Usage:');
  log('  npm run get-cookie              # from project root');
  log('  npm start -- --save             # from suno-cookie-extractor/');
  log('  npm start -- --email you@example.com --password secret --save');
  log('');
  log('Options:');
  log('  -e, --email <email>       Suno account email (or SUNO_EMAIL in .env)');
  log('  -p, --password <password> Suno account password (or SUNO_PASSWORD in .env)');
  log('  -s, --save                Write SUNO_COOKIE to .env (default)');
  log('  --no-save, --print-only   Print cookie only; do not update .env');
  log('  --no-verify               Skip Suno API auth check after extraction');
  log('  -m, --manual              Manual sign-in only (use for Google/Apple SSO)');
  log('  --no-profile              Use a fresh browser profile instead of a saved one');
  log('  --browser <name>          chrome (default) | chromium | msedge | chrome-beta');
  log('  --chrome-path <path>      Explicit browser binary (skips channel lookup)');
  log('  --headless                Run browser without a visible window');
  log('  --timeout <seconds>       Max wait time (default: 300)');
  log('  -h, --help                Show this help');
  log('');
  log('By default uses your installed Google Chrome (no Playwright browser download).');
  log('For bundled Chromium: npm run install-browsers && npm start -- --browser chromium');
  log('');
  log('If email/password are omitted, you will be prompted and can also log in');
  log('manually in the opened browser window.');
}

async function promptLine(question, hidden = false) {
  if (!hidden) {
    const rl = createInterface({ input, output });
    const answer = await rl.question(question);
    rl.close();
    return answer.trim();
  }

  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const onData = (char) => {
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.removeListener('data', onData);
        stdin.setRawMode?.(wasRaw ?? false);
        stdin.pause();
        process.stdout.write('\n');
        resolve(value.trim());
        return;
      }
      if (char === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      }
      if (char === '\u007f' || char === '\b') {
        if (value.length > 0) value = value.slice(0, -1);
        return;
      }
      value += char;
    };

    stdin.on('data', onData);
  });
}

async function resolveCredentials(opts) {
  if (opts.manual) return opts;

  if (!opts.email) {
    opts.email = await promptLine('Suno email (optional, for auto sign-in): ');
  }
  if (!opts.password && opts.email) {
    opts.password = await promptLine(
      'Suno password (optional — press Enter to sign in manually in the browser): ',
      true
    );
  }
  return opts;
}

function isSunoAppUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'suno.com' || host.endsWith('.suno.com');
  } catch {
    return false;
  }
}

function isSunoSignedInAppUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'auth.suno.com') return false;
    if (!(u.hostname === 'suno.com' || u.hostname.endsWith('.suno.com'))) return false;
    return !/\/(sign-in|signin|login)(?:\/|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

function isAuthFlowUrl(url) {
  if (!url || url === 'about:blank' || url.startsWith('chrome')) return false;
  try {
    const u = new URL(url);
    if (u.hostname === 'auth.suno.com') return true;
    if (u.hostname === 'suno.com' || u.hostname.endsWith('.suno.com')) {
      return /\/(sign-in|signin|login)(?:\/|$)/i.test(u.pathname);
    }
  } catch {
    return false;
  }
  // Third-party IdP pages only — do not treat every non-Suno URL as auth.
  return AUTH_FLOW_URL_PATTERN.test(url);
}

function getAuthFlowState(context) {
  const pages = context.pages().filter((p) => !p.isClosed());
  const activeUrls = pages.map((p) => p.url()).filter(Boolean);

  // If any tab is already on the Suno app, do not block on leftover Google/OAuth tabs.
  if (activeUrls.some((url) => isSunoSignedInAppUrl(url))) {
    return {
      inAuth: false,
      url: activeUrls.find((url) => isSunoSignedInAppUrl(url)) || activeUrls[0] || '',
      pageCount: pages.length,
    };
  }

  const authUrl = activeUrls.find((url) => isAuthFlowUrl(url));
  return {
    inAuth: Boolean(authUrl),
    url: authUrl || activeUrls[0] || '',
    pageCount: pages.length,
  };
}

function describeAuthUrl(url) {
  if (/accounts\.google\.|google\.com\/(?:signin|o\/oauth2)/i.test(url)) return 'Google sign-in';
  if (/appleid\.apple\.com/i.test(url)) return 'Apple sign-in';
  if (/login\.microsoftonline\.com/i.test(url)) return 'Microsoft sign-in';
  if (/auth\.suno\.com|sign-in|signin/i.test(url)) return 'Suno sign-in';
  if (url) return 'external sign-in';
  return 'sign-in';
}

function cookieHasRequiredKeys(cookieHeader) {
  if (!cookieHeader) return false;
  return REQUIRED_COOKIE_KEYS.every((key) =>
    new RegExp(`(?:^|;\\s*)${key}=`).test(cookieHeader)
  );
}

function parseCookieHeader(cookieHeader) {
  const jar = new Map();
  if (!cookieHeader) return jar;

  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    jar.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }

  return jar;
}

function serializeCookieJar(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function mergeCookieHeaders(...headers) {
  const jar = new Map();
  for (const header of headers) {
    for (const [name, value] of parseCookieHeader(header)) {
      jar.set(name, value);
    }
  }
  return serializeCookieJar(jar);
}

function countCookieKeys(cookieHeader) {
  return parseCookieHeader(cookieHeader).size;
}

function filterAuthCookies(cookieHeader) {
  const jar = parseCookieHeader(cookieHeader);
  const filtered = new Map();

  for (const [name, value] of jar) {
    if (AUTH_COOKIE_PATTERN.test(name)) {
      filtered.set(name, value);
    }
  }

  return serializeCookieJar(filtered);
}

function parseEnvValue(rawValue) {
  let value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return value;
}

async function loadCredentialsFromEnv() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!existsSync(envPath)) return;

  const content = await readFile(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!CREDENTIAL_ENV_KEYS.includes(key)) continue;

    const value = parseEnvValue(trimmed.slice(eq + 1));
    if (process.env[key] == null || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

async function buildCookieHeaderFromContext(context) {
  const jar = new Map();

  for (const url of SUNO_COOKIE_URLS) {
    const cookies = await context.cookies(url);
    for (const ck of cookies) {
      if (!ck.name) continue;
      if (ck.domain?.includes('suno.com') || ck.name.startsWith('__client')) {
        jar.set(ck.name, ck.value);
      }
    }
  }

  return serializeCookieJar(jar);
}

async function tryAutomatedLogin(page, email, password) {
  if (!email || !password) return false;

  log('\nAttempting automated sign-in…', c.cyan);

  try {
    await page.goto(SUNO_SIGN_IN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    const emailInput = page
      .locator('input[name="identifier"], input[type="email"], input[autocomplete="email"]')
      .first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(email);

    const continueAfterEmail = page
      .locator(
        'button:has-text("Continue"), button:has-text("Sign in"), button[type="submit"]'
      )
      .first();
    await continueAfterEmail.click({ timeout: 10000 });
    await page.waitForTimeout(1000);

    const passwordInput = page
      .locator('input[name="password"], input[type="password"]')
      .first();
    await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
    await passwordInput.fill(password);

    const submit = page
      .locator(
        'button:has-text("Continue"), button:has-text("Sign in"), button[type="submit"]'
      )
      .first();
    await submit.click({ timeout: 10000 });

    await page.waitForURL((url) => !url.pathname.includes('sign-in'), {
      timeout: 30000,
    });
    log('Sign-in form submitted.', c.green);
    return true;
  } catch (err) {
    log(`Automated sign-in failed: ${err.message}`, c.yellow);
    log('Please complete login manually in the browser window.', c.yellow);
    return false;
  }
}

function createCookieCapture(context) {
  let capturedCookie = null;
  let activeSessionId = null;

  const onRequest = (request) => {
    if (!CLERK_URL_PATTERN.test(request.url())) return;
    const header = request.headers().cookie;
    if (!cookieHasRequiredKeys(header)) return;

    if (
      !capturedCookie ||
      countCookieKeys(header) >= countCookieKeys(capturedCookie)
    ) {
      capturedCookie = header;
    }
  };

  const onResponse = async (response) => {
    if (!CLERK_URL_PATTERN.test(response.url())) return;
    try {
      const body = await response.json();
      const sessionId = body?.response?.last_active_session_id;
      if (sessionId) {
        activeSessionId = sessionId;
      }
    } catch {
      // Ignore non-JSON Clerk responses.
    }
  };

  context.on('request', onRequest);
  context.on('response', onResponse);

  return {
    get: () => capturedCookie,
    hasActiveSession: () => Boolean(activeSessionId),
    getActiveSessionId: () => activeSessionId,
    async waitFor(timeoutMs) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (capturedCookie && activeSessionId) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const contextCookie = await buildCookieHeaderFromContext(context);
      if (cookieHasRequiredKeys(contextCookie)) {
        capturedCookie = mergeCookieHeaders(contextCookie, capturedCookie);
      }

      return capturedCookie;
    },
    dispose() {
      context.off('request', onRequest);
      context.off('response', onResponse);
    },
  };
}

async function resolveFullCookie(page, capture) {
  const contextCookie = await buildCookieHeaderFromContext(page.context());
  const networkCookie = capture.get();
  const cookie = mergeCookieHeaders(contextCookie, networkCookie);

  if (cookieHasRequiredKeys(cookie)) {
    return cookie;
  }

  return null;
}

async function tryResolveAuthenticatedCookie(page, capture) {
  const rawCookie = await resolveFullCookie(page, capture);
  if (!rawCookie) return null;

  const cookie = filterAuthCookies(rawCookie);
  if (!cookieHasRequiredKeys(cookie)) return null;

  const session = await probeSunoSession(cookie);
  if (!session.ok) return null;

  return {
    cookie,
    rawCount: countCookieKeys(rawCookie),
    sessionId: session.sessionId,
  };
}

async function refreshCreatePage(page, context, capture) {
  const authState = getAuthFlowState(context);
  if (authState.inAuth) return false;

  await page.goto(SUNO_CREATE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  }).catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await capture.waitFor(15000);
  return true;
}

async function waitForAuthenticatedCookie(page, context, capture, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastHint = 'Ensure you finished signing in at suno.com/create.';
  let announcedAuthWait = false;
  let authFlowSeen = false;

  log('Waiting for an active Suno session (not just the __client cookie)…', c.dim);

  while (Date.now() < deadline) {
    const authState = getAuthFlowState(context);

    if (authState.inAuth) {
      authFlowSeen = true;
      // Cookies may already be valid even while an IdP tab is still open.
      const early = await tryResolveAuthenticatedCookie(page, capture);
      if (early) return early;

      if (!announcedAuthWait) {
        log(
          `\n${describeAuthUrl(authState.url)} detected — complete SSO/2FA in the browser.`,
          c.yellow
        );
        log('The script will not navigate or refresh until sign-in finishes.', c.dim);
        announcedAuthWait = true;
      }
      await page.waitForTimeout(3000);
      continue;
    }

    if (announcedAuthWait) {
      log('Sign-in flow finished. Syncing cookies from suno.com/create…', c.cyan);
      announcedAuthWait = false;
    }

    if (capture.hasActiveSession()) {
      const quick = await tryResolveAuthenticatedCookie(page, capture);
      if (quick) return quick;
    }

    const authenticated = await tryResolveAuthenticatedCookie(page, capture);
    if (authenticated) return authenticated;

    const onSunoCreate =
      isSunoAppUrl(page.url()) &&
      !page.url().includes('sign-in') &&
      !page.url().includes('signin');

    if (onSunoCreate) {
      log('Refreshing suno.com/create to sync login cookies…', c.dim);
      await refreshCreatePage(page, context, capture);
    } else if (!authFlowSeen) {
      log('Open suno.com/create in the browser and sign in when you are ready.', c.dim);
    }

    const session = await tryResolveAuthenticatedCookie(page, capture);
    if (session) return session;

    lastHint = authFlowSeen
      ? 'Finish Google/SSO/2FA, then wait until suno.com/create loads.'
      : 'Sign-in may still be in progress, or the session has not synced yet.';
    await page.waitForTimeout(2000);
  }

  throw new Error(
    `Timed out waiting for an authenticated Suno session. ${lastHint}`
  );
}

function browserLaunchOptions(opts, launchArgs) {
  const options = {
    headless: opts.headless,
    args: launchArgs,
  };

  if (opts.executablePath) {
    options.executablePath = opts.executablePath;
    log(`Using browser binary: ${opts.executablePath}`, c.dim);
  } else if (opts.channel) {
    options.channel = opts.channel;
    log(`Using system browser channel: ${opts.channel}`, c.dim);
  } else {
    log('Using Playwright bundled Chromium', c.dim);
  }

  return options;
}

async function launchBrowserContext(opts) {
  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ];
  const browserOpts = browserLaunchOptions(opts, launchArgs);

  if (opts.persistProfile) {
    log(`Using saved browser profile at ${BROWSER_PROFILE_DIR}`, c.dim);
    try {
      const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
        ...browserOpts,
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
      });
      const page = context.pages()[0] || (await context.newPage());
      return { browser: null, context, page, persistent: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Executable doesn't exist|Failed to launch|browserType\.launch/i.test(msg)) {
        throw new Error(
          `${msg}\n\nHint: install Google Chrome, or run:\n` +
            `  cd suno-cookie-extractor && npm run install-browsers\n` +
            `  npm start -- --browser chromium --save`
        );
      }
      throw err;
    }
  }

  let browser;
  try {
    browser = await chromium.launch(browserOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|Failed to launch|browserType\.launch/i.test(msg)) {
      throw new Error(
        `${msg}\n\nHint: install Google Chrome, or run:\n` +
          `  cd suno-cookie-extractor && npm run install-browsers\n` +
          `  npm start -- --browser chromium --save`
      );
    }
    throw err;
  }
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });
  const page = await context.newPage();
  return { browser, context, page, persistent: false };
}

function formatEnvCookieValue(cookie) {
  const escaped = cookie.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

async function saveCookieToEnv(cookie) {
  const envPath = path.join(PROJECT_ROOT, '.env');
  const envLine = `SUNO_COOKIE=${formatEnvCookieValue(cookie)}`;
  let content = '';

  if (existsSync(envPath)) {
    content = await readFile(envPath, 'utf8');
    if (/^SUNO_COOKIE=.*$/m.test(content)) {
      content = content.replace(/^SUNO_COOKIE=.*$/m, envLine);
    } else {
      content = content.trimEnd() + `\n${envLine}\n`;
    }
  } else {
    content = `# Suno account cookie\n${envLine}\n`;
  }

  await writeFile(envPath, content, 'utf8');
  log(`Updated only SUNO_COOKIE in ${envPath}`, c.green);
  log('Other .env settings (TWOCAPTCHA_KEY, BROWSER_*, etc.) were left unchanged.', c.dim);
}

async function main() {
  await loadCredentialsFromEnv();
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    showHelp();
    return;
  }

  heading();
  await resolveCredentials(opts);

  let browser;
  let context;
  let page;
  let capture;
  try {
    ({ browser, context, page } = await launchBrowserContext(opts));
    capture = createCookieCapture(context);

    context.on('page', () => {
      const authState = getAuthFlowState(context);
      if (authState.inAuth && authState.pageCount > 1) {
        log('SSO popup opened — complete sign-in there if prompted.', c.dim);
      }
    });

    log(`Opening ${SUNO_CREATE_URL}…`, c.cyan);
    await page.goto(SUNO_CREATE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    let authenticated = await tryResolveAuthenticatedCookie(page, capture);

    if (!authenticated) {
      const useAutomatedLogin = !opts.manual && Boolean(opts.email && opts.password);

      if (useAutomatedLogin) {
        const loggedIn = await tryAutomatedLogin(page, opts.email, opts.password);
        if (loggedIn) {
          log('Automated sign-in submitted. Waiting for Suno to confirm the session…', c.cyan);
        } else {
          log('\nComplete sign-in manually in the browser (Google/Apple SSO is fine).', c.yellow);
        }
      } else {
        log('\nSign in manually in the browser (Google/Apple SSO is fine).', c.yellow);
        log('Use --manual to skip email/password prompts entirely.', c.dim);
        log('The script will not touch the browser during Google/2FA.', c.dim);
      }

      authenticated = await waitForAuthenticatedCookie(
        page,
        context,
        capture,
        opts.timeoutMs
      );
    }

    const { cookie, rawCount, sessionId } = authenticated;

    log('\nCookie extracted successfully.', c.green);
    log(
      `Prepared ${countCookieKeys(cookie)} auth cookies (filtered from ${rawCount} browser cookies).`,
      c.green
    );
    log(`Active session: ${sessionId}`, c.dim);

    if (opts.verify) {
      log('\nVerifying authentication with Suno API…', c.cyan);
      const auth = await verifySunoAuth(cookie);
      log(
        `Authentication OK — ${auth.creditsLeft} credits left (${auth.monthlyUsage}/${auth.monthlyLimit} used this period).`,
        c.green
      );
    } else {
      log('Skipped Suno API auth check (--no-verify).', c.dim);
    }

    log('\n--- SUNO_COOKIE ---\n', c.bold);
    console.log(cookie);
    log('\n-------------------\n', c.bold);

    if (opts.save) {
      await saveCookieToEnv(cookie);
    } else {
      log('Skipped saving to .env (--no-save).', c.dim);
    }
  } finally {
    capture?.dispose();
    if (context) await context.close();
    else if (browser) await browser.close();
  }
}

function heading() {
  log(`\n${c.bold}Suno Cookie Extractor${c.reset}`, c.violet);
  log('Follows gcui-art/suno-api cookie extraction steps.\n', c.dim);
}

main().catch((err) => {
  log(`\nError: ${err.message}`, c.red);
  process.exit(1);
});