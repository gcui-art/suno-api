/**
 * passkey-server.mjs
 *
 * Tiny HTTP сервер, который принимает P1_ токен от bookmarklet в браузере,
 * записывает его в .env и пересобирает suno-api.
 *
 * ЗАПУСК:
 *   node scripts/passkey-server.mjs              # просто принять токен
 *   node scripts/passkey-server.mjs --rebuild    # принять + npm run build
 *   node scripts/passkey-server.mjs --restart    # принять + build + restart
 *
 * ИСПОЛЬЗОВАНИЕ:
 *   1. Запусти этот скрипт
 *   2. Он выведет bookmarklet — добавь его в браузер или скопируй код
 *   3. Зайди на suno.com/create в браузере
 *   4. Кликни bookmarklet (или вставь код в DevTools Console)
 *   5. Нажми кнопку Create на suno.com
 *   6. Токен автоматически придёт на сервер → .env обновится → rebuild
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT     = resolve(__dirname, '..');
const ENV_FILE = resolve(ROOT, '.env');
const PORT     = 3099;

const ARGS    = process.argv.slice(2);
const REBUILD = ARGS.includes('--rebuild') || ARGS.includes('--restart');
const RESTART = ARGS.includes('--restart');

const log = (m) => console.log(`[passkey-server] ${new Date().toISOString()} ${m}`);

function updateEnvFile(key, value) {
  if (!existsSync(ENV_FILE)) throw new Error(`.env не найден: ${ENV_FILE}`);
  let content = readFileSync(ENV_FILE, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  content = re.test(content) ? content.replace(re, `${key}=${value}`) : content + `\n${key}=${value}\n`;
  writeFileSync(ENV_FILE, content, 'utf8');
  log(`✅ ${key} обновлён`);
}

// ─── Bookmarklet код ──────────────────────────────────────────────────────────
// Патчит turnstile.execute и при получении P1_ токена
// отправляет POST на localhost:3099/token
function makeBookmarklet() {
  const code = `
(function(){
  if(window.__passkeyPatchDone){alert('Уже установлен! Просто нажми Create.');return;}
  window.__passkeyPatchDone=true;
  function patch(t){
    if(!t||t.__pk)return;t.__pk=1;
    var e=t.execute.bind(t);
    t.execute=function(sk,p){
      if(p&&typeof p.callback==='function'){
        var cb=p.callback;
        p.callback=function(tok){
          if(tok&&tok.indexOf('P1_')===0){
            fetch('http://localhost:${PORT}/token',{
              method:'POST',
              headers:{'Content-Type':'text/plain','Origin':'https://suno.com'},
              body:tok
            }).then(function(r){return r.text();}).then(function(s){
              alert('✅ Passkey обновлён! '+s);
            }).catch(function(err){
              prompt('Сервер недоступен. Скопируй токен вручную:',tok);
            });
          }
          cb(tok);
        };
      }
      return e(sk,p);
    };
  }
  if(window.turnstile)patch(window.turnstile);
  var _t;
  Object.defineProperty(window,'turnstile',{
    get:function(){return _t;},
    set:function(v){_t=v;patch(v);},
    configurable:true
  });
  alert('✅ Перехватчик установлен! Теперь нажми Create.');
})()
  `.replace(/\s+/g, ' ').trim();
  return `javascript:${encodeURIComponent(code)}`;
}

// ─── HTTP сервер ──────────────────────────────────────────────────────────────
function startServer() {
  const server = createServer((req, res) => {
    // CORS — нужен чтобы suno.com мог делать fetch на localhost
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204); res.end(); return;
    }

    if (req.method === 'POST' && req.url === '/token') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        const token = body.trim();
        if (!token.startsWith('P1_')) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Ожидался P1_ токен');
          return;
        }

        log(`Токен получен (${token.length} символов)`);

        try {
          updateEnvFile('SUNO_PASSKEY_TOKEN', token);

          if (REBUILD) {
            log('🔨 npm run build...');
            execSync('npm run build', { cwd: ROOT, stdio: 'pipe' });
            log('✅ Build завершён');
          }

          if (RESTART) {
            for (const cmd of ['systemctl restart suno-api', 'pm2 restart suno-api']) {
              try { execSync(cmd, { stdio: 'pipe' }); log(`✅ ${cmd}`); break; }
              catch (_) {}
            }
          }

          const msg = REBUILD
            ? 'Токен обновлён, build завершён'
            : 'Токен обновлён. Запусти: npm run build && npm start';

          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(msg);
          log('=== Готово ===');

          if (!REBUILD) {
            log('⚠️  Не забудь пересобрать: npm run build && npm start');
          }

          // Не останавливаем сервер — может потребоваться повторно
          log('Сервер продолжает работать. Ctrl+C для остановки.');

        } catch (e) {
          log(`❌ Ошибка: ${e.message}`);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Ошибка: ${e.message}`);
        }
      });
      return;
    }

    // Главная страница с инструкцией
    if (req.method === 'GET' && req.url === '/') {
      const bm = makeBookmarklet();
      const html = `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"><title>SUNO Passkey Updater</title>
<style>
  body { font-family: sans-serif; max-width: 700px; margin: 40px auto; padding: 20px; background: #0f0f0f; color: #e0e0e0; }
  h1 { color: #fff; } .step { background: #1a1a1a; border-radius: 8px; padding: 16px; margin: 12px 0; }
  .step h3 { margin: 0 0 8px; color: #4ade80; }
  a.bookmarklet { display: inline-block; padding: 10px 20px; background: #4ade80; color: #000;
    font-weight: bold; border-radius: 6px; text-decoration: none; margin: 8px 0; }
  code { background: #2a2a2a; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  .status { padding: 10px; background: #1a1a1a; border-left: 3px solid #4ade80; margin: 16px 0; }
</style>
</head>
<body>
<h1>🎵 SUNO Passkey Updater</h1>
<div class="status">Сервер запущен на порту ${PORT}. Ожидаю токен...</div>

<div class="step">
  <h3>Шаг 1 — Добавь bookmarklet в браузер</h3>
  <p>Перетащи эту кнопку в панель закладок:</p>
  <a class="bookmarklet" href="${bm}">🔑 Capture Passkey</a>
  <p>Или скопируй код для DevTools Console:</p>
  <textarea style="width:100%;height:80px;background:#2a2a2a;color:#fff;border:1px solid #444;padding:8px;"
    onclick="this.select()" readonly>${bm.replace('javascript:', '')}</textarea>
</div>

<div class="step">
  <h3>Шаг 2 — Перейди на suno.com/create</h3>
  <p>Убедись что ты залогинен в аккаунт SUNO.</p>
</div>

<div class="step">
  <h3>Шаг 3 — Кликни bookmarklet</h3>
  <p>После клика появится alert "Перехватчик установлен!"</p>
</div>

<div class="step">
  <h3>Шаг 4 — Нажми Create на suno.com</h3>
  <p>Введи любой текст и нажми Create. Появится alert "✅ Passkey обновлён!"</p>
</div>

<p style="color:#888">После обновления токена сервер продолжает работать.
${REBUILD ? 'Build запускается автоматически.' : 'Запусти <code>npm run build && npm start</code> вручную.'}</p>
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html); return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.listen(PORT, '127.0.0.1', () => {
    log('=== SUNO Passkey Server запущен ===');
    log(`Открой в браузере: http://127.0.0.1:${PORT}/`);
    log('');
    log('Инструкция:');
    log(`  1. Открой http://127.0.0.1:${PORT}/ — там есть bookmarklet`);
    log('  2. Зайди на https://suno.com/create');
    log('  3. Кликни bookmarklet (или вставь код в DevTools Console)');
    log('  4. Нажми Create');
    log('  5. Токен автоматически придёт сюда');
    log('');
    log('Ctrl+C для остановки.');
  });
}

startServer();
