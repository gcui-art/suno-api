/**
 * hCaptcha hsw PoW 求解器（Node.js 子进程）
 * 读取 stdin: JSON { jwt, cookie, assets_base, version }
 * 输出 stdout: JSON { proof } 或 { error }
 *
 * 用法: node scripts/hsw_solve.mjs
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';

const _require = createRequire(import.meta.url);

// ─── 读取 stdin ────────────────────────────────────────────────────────────
function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', d => (buf += d));
    process.stdin.on('end', () => resolve(buf.trim()));
  });
}

// ─── 注入最小浏览器 globals ───────────────────────────────────────────────
function injectBrowserGlobals(userAgent, assetsBase, version) {
  const noop = () => null;
  const makeEl = () => new Proxy({}, {
    get: (_, p) => ({
      style: {}, setAttribute: noop, addEventListener: noop,
      removeEventListener: noop, appendChild: noop, removeChild: noop,
      classList: { add: noop, remove: noop, contains: () => false },
    }[p] ?? noop),
    set: () => true,
  });

  if (!('window' in globalThis)) globalThis.window = globalThis;
  if (!('self' in globalThis))   globalThis.self   = globalThis;

  if (!('document' in globalThis)) {
    globalThis.document = new Proxy({
      createElement: () => makeEl(),
      createElementNS: () => makeEl(),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      head: { appendChild: noop },
      body: { appendChild: noop },
      currentScript: null,
      readyState: 'complete',
    }, { get(t, p) { return p in t ? t[p] : noop; } });
  }

  if (!('navigator' in globalThis)) {
    globalThis.navigator = {
      userAgent,
      hardwareConcurrency: 8,
      language: 'zh-CN',
      languages: ['zh-CN', 'zh', 'en'],
      platform: 'Win32',
      vendor: 'Google Inc.',
      maxTouchPoints: 0,
      cookieEnabled: true,
      doNotTrack: null,
      deviceMemory: 8,
    };
  }

  if (!('location' in globalThis)) {
    globalThis.location = {
      href: `${assetsBase}/captcha/v1/${version}/static/hcaptcha.html`,
      origin: assetsBase,
      hostname: new URL(assetsBase).hostname,
      protocol: 'https:',
      pathname: `/captcha/v1/${version}/static/hcaptcha.html`,
    };
  }

  if (!('performance' in globalThis)) {
    globalThis.performance = { now: () => Date.now(), timeOrigin: Date.now() };
  }

  // __name polyfill（esbuild/tsx 编译产物会用到）
  if (!('__name' in globalThis)) {
    globalThis.__name = (fn, _name) => fn;
  }
}

// ─── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  let input;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: 'Invalid stdin JSON: ' + e.message }));
    process.exit(1);
  }

  const { jwt, cookie: cookieStr, assets_base, version } = input;
  const ASSETS = assets_base ?? 'https://hcaptcha-assets-prod.suno.com';
  const VERSION = version ?? 'be2fb915d274e0153a2483e68ec5703d502b9d3d';
  const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  // 解析 JWT payload 取 lPath
  let lPath;
  try {
    const parts = jwt.split('.');
    const pad = parts[1].replace(/-/g, '+').replace(/_/g, '/') + '==';
    const payload = JSON.parse(Buffer.from(pad, 'base64').toString());
    lPath = payload.l;
    process.stderr.write(`[hsw_solve] JWT: l=${lPath} n=${payload.n} c=${payload.c}\n`);
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: 'JWT parse failed: ' + e.message }));
    process.exit(1);
  }

  // 下载 hsw.js
  const hswUrl = `${ASSETS}${lPath}/hsw.js`;
  process.stderr.write(`[hsw_solve] Fetching: ${hswUrl}\n`);
  let hswCode;
  try {
    const resp = await fetch(hswUrl, {
      headers: {
        'user-agent': USER_AGENT,
        'referer': `${ASSETS}/captcha/v1/${VERSION}/static/hcaptcha.html`,
        'accept': '*/*',
        ...(cookieStr ? { cookie: cookieStr } : {}),
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    hswCode = await resp.text();
    process.stderr.write(`[hsw_solve] hsw.js size: ${hswCode.length} chars\n`);
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: 'hsw.js fetch failed: ' + e.message }));
    process.exit(1);
  }

  // 注入 globals
  injectBrowserGlobals(USER_AGENT, ASSETS, VERSION);

  // fetch 拦截：补全相对路径
  const _origFetch = globalThis.fetch;
  globalThis.fetch = async (url, ...args) => {
    const u = String(url);
    process.stderr.write(`[hsw_solve] fetch intercepted: ${u}\n`);
    const resolved = u.startsWith('/') ? ASSETS + u : u;
    return _origFetch(resolved, ...args);
  };

  // eval hsw.js
  try {
    eval(hswCode); // eslint-disable-line no-eval
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: 'eval hsw.js failed: ' + e.message }));
    process.exit(1);
  }

  const hswFn = globalThis.hsw;
  if (typeof hswFn !== 'function') {
    process.stdout.write(JSON.stringify({ error: 'hsw function not found after eval' }));
    process.exit(1);
  }

  // 调用 hsw 解 PoW
  process.stderr.write('[hsw_solve] Calling hsw()...\n');
  try {
    const result = await hswFn(jwt, {
      href: 'https://suno.com/',
      ardata: null,
      vm_data: null,
      uj_data: null,
    });
    const proof = typeof result === 'string' ? result
      : (result?.solved ? String(result.solved) : String(result));
    process.stderr.write(`[hsw_solve] proof (first 80): ${proof.substring(0, 80)}\n`);
    // 必须等 write 回调后再 exit，Windows 管道下 stdout 是异步的
    process.stdout.write(JSON.stringify({ proof }) + '\n', () => process.exit(0));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: 'hsw() failed: ' + e.message }));
    process.exit(1);
  } finally {
    globalThis.fetch = _origFetch;
  }
}

main().catch(e => {
  process.stdout.write(JSON.stringify({ error: String(e) }));
  process.exit(1);
});
