/**
 * refresh-passkey.mjs
 *
 * Автоматически обновляет SUNO_PASSKEY_TOKEN в .env.
 *
 * КАК РАБОТАЕТ:
 *   Cloudflare Turnstile генерирует P1_ токен при загрузке suno.com/create.
 *   Скрипт перехватывает вызов turnstile.execute() через Object.defineProperty
 *   и сохраняет токен в window.__capturedPasskey. Кредиты НЕ тратятся.
 *
 * ВАЖНО — HEADLESS:
 *   Cloudflare Turnstile не работает в headless браузере.
 *   На Windows: скрипт запускается в visible окне (мелькнёт и закроется).
 *   На Linux: нужен виртуальный дисплей:
 *     sudo apt install xvfb
 *     xvfb-run -a node scripts/refresh-passkey.mjs --rebuild
 *
 * ИСПОЛЬЗОВАНИЕ:
 *   node scripts/refresh-passkey.mjs              # обновить .env
 *   node scripts/refresh-passkey.mjs --rebuild    # обновить + npm run build
 *   node scripts/refresh-passkey.mjs --restart    # обновить + build + systemctl restart
 *   node scripts/refresh-passkey.mjs --headless   # принудительно headless (может не работать)
 *
 * АВТОЗАПУСК (Linux, каждые 3 часа):
 *   0 *\/3 * * * ubuntu xvfb-run -a node /home/ubuntu/suno-api/scripts/refresh-passkey.mjs --rebuild >> /var/log/refresh-passkey.log 2>&1
 *
 * npm-скрипты (для удобства):
 *   npm run refresh-passkey           # только .env
 *   npm run refresh-passkey:rebuild   # .env + build
 *   npm run refresh-passkey:restart   # .env + build + restart
 */

import { chromium } from 'rebrowser-playwright-core';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(__dirname, '..');
const ENV_FILE   = resolve(ROOT, '.env');

// ─── Загрузка .env вручную (без dotenv) ───────────────────────────────────────
function loadEnv(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  }
}
loadEnv(ENV_FILE);

// ─── Аргументы ────────────────────────────────────────────────────────────────
const ARGS      = process.argv.slice(2);
const REBUILD   = ARGS.includes('--rebuild') || ARGS.includes('--restart');
const RESTART   = ARGS.includes('--restart');
const HEADLESS  = ARGS.includes('--headless');  // принудительно headless
const TIMEOUT_MS = 45_000;

// ─── Утилиты ──────────────────────────────────────────────────────────────────
const log = (m) => console.log(`[refresh-passkey] ${new Date().toISOString()} ${m}`);

function parseCookies(str) {
  if (!str) return [];
  return str.split(';').map(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return null;
    const name  = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    return (name && value) ? { name, value, domain: '.suno.com', path: '/', sameSite: 'Lax' } : null;
  }).filter(Boolean);
}

function updateEnvFile(key, value) {
  if (!existsSync(ENV_FILE)) throw new Error(`.env не найден: ${ENV_FILE}`);
  let content = readFileSync(ENV_FILE, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  content = re.test(content) ? content.replace(re, `${key}=${value}`) : content + `\n${key}=${value}\n`;
  writeFileSync(ENV_FILE, content, 'utf8');
  log(`✅ ${key} обновлён в .env`);
}

// ─── Inject-скрипт: патч window.turnstile ─────────────────────────────────────
// Cloudflare присваивает window.turnstile ПОСЛЕ загрузки страницы.
// Object.defineProperty перехватывает это присвоение и патчит .execute.
const INJECT_SCRIPT = `
(function() {
  var _orig;
  function patch(t) {
    if (!t || typeof t.execute !== 'function' || t.__patched) return;
    t.__patched = true;
    var origExec = t.execute.bind(t);
    t.execute = function(sitekey, params) {
      if (params && typeof params.callback === 'function') {
        var cb = params.callback;
        params.callback = function(token) {
          if (token && token.indexOf('P1_') === 0) {
            window.__capturedPasskey = token;
            try { console.log('PASSKEY_CAPTURED:' + token); } catch(e){}
          }
          cb(token);
        };
      }
      return origExec(sitekey, params);
    };
  }
  // Если turnstile уже есть — патчим сразу
  if (window.turnstile) { patch(window.turnstile); }
  // Перехватываем будущее присвоение
  Object.defineProperty(window, 'turnstile', {
    get: function() { return _orig; },
    set: function(val) { _orig = val; patch(val); },
    configurable: true
  });
})();
`;

// ─── Получение токена через системный Chrome + CDP ────────────────────────────
async function getPasskeyViaCDP(chromePath, cookieStr, cookies) {
  const port = 9337;
  const userDataDir = resolve(tmpdir(), 'suno-passkey-profile');
  log(`Запускаю системный Chrome (${chromePath})...`);

  const proc = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    'about:blank',
  ], { detached: false, stdio: 'ignore' });

  // Ждём пока Chrome запустится
  await new Promise(r => setTimeout(r, 2000));

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (e) {
    proc.kill();
    throw new Error(`Не удалось подключиться к Chrome CDP: ${e.message}`);
  }

  const context = browser.contexts()[0] || await browser.newContext();

  // Инжектируем патч
  await context.addInitScript(INJECT_SCRIPT);

  // Добавляем cookies
  await context.addCookies(cookies);

  const page = await context.newPage();

  return new Promise(async (resolve, reject) => {
    let done = false;

    const cleanup = async () => {
      await browser.close().catch(() => {});
      proc.kill();
    };

    const finish = async (token, src) => {
      if (done) return; done = true;
      log(`✅ Токен получен из: ${src} (${token.length} символов)`);
      await cleanup();
      resolve(token);
    };
    const fail = async (msg) => {
      if (done) return; done = true;
      await cleanup();
      reject(new Error(msg));
    };

    setTimeout(() => fail(
      `Токен не получен за ${TIMEOUT_MS / 1000} секунд. Проверь SUNO_COOKIE.`
    ), TIMEOUT_MS);

    page.on('console', msg => {
      const t = msg.text();
      if (t.startsWith('PASSKEY_CAPTURED:')) {
        const token = t.replace('PASSKEY_CAPTURED:', '').trim();
        if (token.startsWith('P1_')) finish(token, 'turnstile (CDP Chrome)');
      }
    });

    const poll = setInterval(async () => {
      if (done) { clearInterval(poll); return; }
      try {
        const token = await page.evaluate(() => window.__capturedPasskey || null);
        if (token?.startsWith('P1_')) { clearInterval(poll); finish(token, '__capturedPasskey poll (CDP)'); }
      } catch (_) {}
    }, 400);

    await page.route('**/api/generate/v2**', async route => {
      try {
        const data = route.request().postDataJSON();
        if (data?.token?.startsWith('P1_')) {
          await route.abort();
          finish(data.token, 'network route (CDP)');
          return;
        }
      } catch (_) {}
      await route.abort().catch(() => {});
    });

    try {
      await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded', timeout: 25_000 });
    } catch (e) { return fail(`Не удалось загрузить страницу: ${e.message}`); }

    log('Страница загружена, ожидаю Turnstile...');
    try { await page.waitForLoadState('networkidle', { timeout: 12_000 }); } catch (_) {}

    // Принудительно инжектируем патч через evaluate (запасной вариант если initScript не успел)
    try {
      await page.evaluate(INJECT_SCRIPT);
      log('Патч turnstile.execute инжектирован через evaluate');
    } catch (_) {}

    // Диагностика
    try {
      const diag = await page.evaluate(() => ({
        hasTurnstile: typeof window.turnstile !== 'undefined',
        captured: window.__capturedPasskey?.substring(0, 20) || null,
        title: document.title,
        loggedIn: document.cookie.includes('__session') || document.body.innerHTML.includes('Create'),
      }));
      log(`Диагностика: ${JSON.stringify(diag)}`);
    } catch (_) {}

    if (!done) {
      // Нажимаем Create чтобы триггернуть Turnstile
      try {
        const ta = page.locator('textarea[placeholder="Describe the sound you want"]');
        await ta.waitFor({ timeout: 4000 });
        await ta.fill('test song for passkey');
        await page.waitForTimeout(500);
        await page.click('button[aria-label="Create song"]');
        log('Create нажат, ожидаю токен...');
        await page.waitForTimeout(8000); // Turnstile может занять несколько секунд
      } catch (e) { log(`Create click: ${e.message}`); }
    }
  });
}

// ─── Найти путь к системному Chrome ──────────────────────────────────────────
function findChrome() {
  const candidates = [
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ─── Основной процесс ─────────────────────────────────────────────────────────
async function getPasskeyToken() {
  const cookieStr = process.env.SUNO_COOKIE || '';
  if (!cookieStr) throw new Error('SUNO_COOKIE не задан в .env');

  const cookies = parseCookies(cookieStr);
  if (!cookies.length) throw new Error('Не удалось распарсить SUNO_COOKIE');
  log(`Загружено ${cookies.length} cookies`);

  // Если не headless — запускаем системный Chrome через CDP.
  // Это обходит ограничения rebrowser-playwright-core для non-headless.
  if (!HEADLESS) {
    const chromePath = findChrome();
    if (chromePath) {
      return getPasskeyViaCDP(chromePath, cookieStr, cookies);
    }
    log('⚠️  Системный Chrome не найден, пробую headless Chromium...');
  }

  log(`Запускаю Chromium (headless=true)...`);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=site-per-process,IsolateOrigins',
      '--disable-extensions',
      '--disable-infobars',
      '--disable-gpu',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:    process.env.BROWSER_LOCALE || 'en-US',
    viewport:  { width: 1280, height: 800 },
  });

  await context.addCookies(cookies);

  // Инжектируем патч до загрузки любого скрипта страницы
  await context.addInitScript(INJECT_SCRIPT);

  const page = await context.newPage();

  return new Promise(async (resolve, reject) => {
    let done = false;

    const finish = async (token, src) => {
      if (done) return;
      done = true;
      log(`✅ Токен получен из: ${src} (${token.length} символов)`);
      await browser.close().catch(() => {});
      resolve(token);
    };

    const fail = async (msg) => {
      if (done) return;
      done = true;
      await browser.close().catch(() => {});
      reject(new Error(msg));
    };

    // Таймаут
    const timer = setTimeout(() => fail(
      `Токен не получен за ${TIMEOUT_MS / 1000} секунд.\n` +
      (headless
        ? `  Headless режим — Cloudflare Turnstile заблокирован.\n  Попробуй без --headless или через: xvfb-run -a node scripts/refresh-passkey.mjs --rebuild`
        : `  Проверь SUNO_COOKIE — возможно сессия истекла.`)
    ), TIMEOUT_MS);

    // ── Перехват из console.log (сигнал от нашего inject-скрипта) ─────────────
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.startsWith('PASSKEY_CAPTURED:')) {
        const token = text.replace('PASSKEY_CAPTURED:', '').trim();
        if (token.startsWith('P1_')) {
          clearTimeout(timer);
          finish(token, 'turnstile.execute (console)');
        }
      }
    });

    // ── Polling window.__capturedPasskey каждые 400ms ─────────────────────────
    const poll = setInterval(async () => {
      if (done) { clearInterval(poll); return; }
      try {
        const token = await page.evaluate(() => window.__capturedPasskey || null);
        if (token && token.startsWith('P1_')) {
          clearInterval(poll);
          clearTimeout(timer);
          finish(token, 'window.__capturedPasskey (poll)');
        }
      } catch (_) {}
    }, 400);

    log('Открываю https://suno.com/create ...');
    try {
      await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded', timeout: 25_000 });
    } catch (e) {
      clearTimeout(timer); clearInterval(poll);
      return fail(`Не удалось загрузить страницу: ${e.message}`);
    }

    log('Страница загружена. Ожидаю Cloudflare Turnstile...');

    // Ждём полной загрузки JS (Turnstile инициализируется после DOMContentLoaded)
    try { await page.waitForLoadState('networkidle', { timeout: 15_000 }); } catch (_) {}

    // Если после networkidle токена нет — пробуем кликнуть Create (без кредитов — route abort)
    if (!done) {
      log('Turnstile не сработал сам — нажимаю Create (запрос будет прерван)...');
      await page.route('**/api/generate/v2**', async (route) => {
        // Перехватываем тело запроса, потом abort — кредиты не тратятся
        try {
          const data = route.request().postDataJSON();
          if (data?.token?.startsWith('P1_')) {
            clearTimeout(timer); clearInterval(poll);
            await route.abort();
            finish(data.token, 'network route (aborted)');
            return;
          }
        } catch (_) {}
        await route.abort().catch(() => {});
      });

      try {
        const textarea = page.locator('textarea[placeholder="Describe the sound you want"]');
        await textarea.waitFor({ timeout: 5000 });
        await textarea.fill('test');
        await page.click('button[aria-label="Create song"]');
        log('Create нажат, ожидаю токен...');
      } catch (e) {
        log(`⚠️  Не смог нажать Create: ${e.message}`);
      }
    }
  });
}

// ─── Точка входа ──────────────────────────────────────────────────────────────
async function main() {
  log('=== Обновление SUNO_PASSKEY_TOKEN ===');
  if (!HEADLESS) log('Режим: visible браузер (нужен для Cloudflare Turnstile)');

  const token = await getPasskeyToken().catch(e => { log(`❌ ${e.message}`); process.exit(1); });

  updateEnvFile('SUNO_PASSKEY_TOKEN', token);

  if (REBUILD) {
    log('🔨 npm run build...');
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
    log('✅ Build завершён');
  }

  if (RESTART) {
    for (const cmd of ['systemctl restart suno-api', 'pm2 restart suno-api']) {
      try { execSync(cmd, { stdio: 'inherit' }); log(`✅ ${cmd}`); break; }
      catch (_) {}
    }
  }

  if (!REBUILD) {
    log('');
    log('⚠️  Применить изменения: npm run build && npm start');
    log('   Или: npm run refresh-passkey:rebuild');
  }

  log('=== Готово ===');
}

main();
