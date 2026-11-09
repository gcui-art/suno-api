/**
 * 临时测试脚本：用数据库中的 cookie 测试 hCaptcha hsw 流程
 * 运行: npx tsx scripts/test-hcaptcha.ts
 */
import axios from 'axios';
import UserAgent from 'user-agents';
import * as cookie from 'cookie';
import { encode as msgpackEncode, decode as msgpackDecode, ExtensionCodec } from '@msgpack/msgpack';

// hCaptcha bundle 内嵌的 msgpack 把 Uint8Array 编码为 ext type 18（而非标准 bin8）
// 服务端期望此格式，否则返回 415
const hcaptchaCodec = new ExtensionCodec();
hcaptchaCodec.register({
  type: 18,
  encode: (input: unknown) => input instanceof Uint8Array ? input : null,
  decode: (data: Uint8Array) => data,
});
import { getDb } from '../src/lib/db';

const HCAPTCHA_SITEKEY = 'd65453de-3f1a-4aac-9366-a0f06e52b2ce';
const HCAPTCHA_API = 'https://hcaptcha-endpoint-prod.suno.com';
const HCAPTCHA_ASSETS = 'https://hcaptcha-assets-prod.suno.com';
const HCAPTCHA_VERSION = 'be2fb915d274e0153a2483e68ec5703d502b9d3d';

/**
 * 解码 JWT payload（不验证签名）
 */
function decodeJwtPayload(jwt: string): Record<string, any> {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('Invalid JWT');
  const padded = part.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - part.length % 4) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
}

// ============================================================
// hsw.js 缓存（按 lPath 缓存 JS 代码和已初始化的 hswFn）
// 避免重复下载 1.1MB hsw.js 和重复初始化 WASM
// ============================================================
const _hswJsCache = new Map<string, string>(); // lPath → js 代码
const _hswFnCache = new Map<string, Function>(); // lPath → 已初始化的 hswFn

// 已注入的浏览器 globals 列表（只注入一次，最终统一清理）
const _injectedGlobals: string[] = [];

/** 注入最小浏览器环境（只注入尚未存在的 globals） */
function _ensureBrowserGlobals(userAgent: string) {
  function setIfMissing(key: string, value: unknown) {
    if (!(key in globalThis)) {
      (globalThis as any)[key] = value;
      _injectedGlobals.push(key);
    }
  }

  setIfMissing('window', globalThis);
  setIfMissing('self', globalThis);

  function makeElement(): any {
    return new Proxy({} as any, {
      get: (_t, p) => {
        const noop = () => null;
        const dict: Record<string, any> = {
          style: {},
          setAttribute: noop, addEventListener: noop, removeEventListener: noop,
          appendChild: noop, removeChild: noop,
          classList: { add: noop, remove: noop, contains: () => false },
        };
        return dict[p as string] ?? noop;
      },
      set: () => true,
    });
  }

  setIfMissing('document', new Proxy({
    createElement: (_tag: string) => makeElement(),
    createElementNS: (_ns: string, _tag: string) => makeElement(),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    currentScript: null,
    readyState: 'complete',
  } as any, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      return () => null;
    },
  }));
  setIfMissing('navigator', { userAgent, hardwareConcurrency: 4, language: 'en-US' });
  setIfMissing('location', {
    href: `${HCAPTCHA_ASSETS}/captcha/v1/${HCAPTCHA_VERSION}/static/hcaptcha.html`,
    origin: HCAPTCHA_ASSETS,
    hostname: 'hcaptcha-assets-prod.suno.com',
    protocol: 'https:',
    pathname: `/captcha/v1/${HCAPTCHA_VERSION}/static/hcaptcha.html`,
  });
  setIfMissing('performance', { now: () => Date.now() });
}

/** 清理所有注入的浏览器 globals */
function _cleanupBrowserGlobals() {
  for (const k of _injectedGlobals) delete (globalThis as any)[k];
  _injectedGlobals.length = 0;
}

/**
 * 用缓存的 hswFn（或下载+初始化新的）解决 PoW 挑战。
 * 
 * hCaptcha hsw.js 支持三种调用模式：
 *   mode 0: hsw(jwtString) → PoW proof string
 *   mode 1: hsw(1, uint8array) → 加密请求体
 *   mode 2: hsw(2, uint8array) → 解密响应体
 */
async function solveHsw(
  reqJwt: string,
  cookieStr: string,
  userAgent: string,
): Promise<{ proof: string; hswFn: Function }> {
  const payload = decodeJwtPayload(reqJwt);
  const lPath: string = payload.l;
  console.log('JWT payload (l=%s, n=%s, c=%d)', lPath, payload.n, payload.c);

  // 优先使用缓存的 hswFn（跳过 1.1MB 下载 + WASM 初始化）
  const cachedFn = _hswFnCache.get(lPath);
  if (cachedFn) {
    console.log('Using cached hswFn for', lPath.substring(0, 30));
    const hswOptions = {
      href: `https://suno.com/`,
      ardata: null,
      vm_data: null,
      uj_data: null,
    };
    const result = await cachedFn(reqJwt, hswOptions);
    const proof = typeof result === 'string' ? result
      : (result?.solved ? String(result.solved) : String(result));
    console.log('hsw proof (from cache, first 80):', proof.substring(0, 80));
    return { proof, hswFn: cachedFn };
  }

  // 下载 hsw.js（带 JS 代码缓存，避免同一 lPath 重复网络请求）
  let hswCode = _hswJsCache.get(lPath);
  if (!hswCode) {
    const hswUrl = `${HCAPTCHA_ASSETS}${lPath}/hsw.js`;
    console.log('Fetching hsw.js:', hswUrl);
    const hswResp = await axios.get(hswUrl, {
      headers: {
        'user-agent': userAgent,
        'referer': `${HCAPTCHA_ASSETS}/captcha/v1/${HCAPTCHA_VERSION}/static/hcaptcha.html`,
        'accept': '*/*',
        'cookie': cookieStr,
      },
      responseType: 'text',
    });
    hswCode = hswResp.data as string;
    _hswJsCache.set(lPath, hswCode);
    console.log('hsw.js size:', hswCode.length, 'chars');
  } else {
    console.log('Using cached hsw.js for', lPath.substring(0, 30));
  }

  // 注入浏览器 globals（只注入一次）
  _ensureBrowserGlobals(userAgent);

  // 拦截 fetch 以监控 WASM 加载 URL
  const _origFetch = (globalThis as any).fetch;
  const _wasmFetched: string[] = [];
  (globalThis as any).fetch = async (url: string, ...args: any[]) => {
    const urlStr = String(url);
    console.log('[fetch intercepted]', urlStr);
    _wasmFetched.push(urlStr);
    // 如果是相对路径，尝试补全为绝对路径
    if (urlStr.startsWith('/')) {
      const absUrl = HCAPTCHA_ASSETS + urlStr;
      console.log('[fetch] relative URL resolved to:', absUrl);
      return _origFetch(absUrl, ...args);
    }
    return _origFetch(urlStr, ...args);
  };

  // 拦截 WebAssembly 以监控 WASM 加载
  const origInstantiate = WebAssembly.instantiate.bind(WebAssembly);
  const origInstantiateStreaming = (WebAssembly as any).instantiateStreaming?.bind(WebAssembly);
  (WebAssembly as any).instantiate = async (source: any, imports: any) => {
    console.log('[WASM instantiate] called, source type:', typeof source, ', byteLength:', source?.byteLength);
    return origInstantiate(source, imports);
  };
  if (origInstantiateStreaming) {
    (WebAssembly as any).instantiateStreaming = async (source: any, imports: any) => {
      console.log('[WASM instantiateStreaming] called');
      return origInstantiateStreaming(source, imports);
    };
  }

  // eslint-disable-next-line no-eval
  eval(hswCode);
  // 短暂等待模块同步初始化完成（WASM 加载是懒加载的，实际在 hsw 调用时）
  await new Promise(r => setTimeout(r, 100));

  const hswFn = (globalThis as any).hsw as Function;
  if (typeof hswFn !== 'function') {
    // 恢复
    if (_origFetch) (globalThis as any).fetch = _origFetch;
    (WebAssembly as any).instantiate = origInstantiate;
    throw new Error('hsw function not found after eval');
  }
  // 缓存 hswFn（注意：不同 lPath 可能覆盖 globalThis.hsw，但我们缓存了引用）
  _hswFnCache.set(lPath, hswFn);

  // 按真实浏览器方式调用：hsw(jwtString, options)
  // 真实束: n(i.req, {href: Vr, ardata: null, vm_data: wr, uj_data: kr})
  // 保持 fetch/WASM 拦截器活跃直到 hsw 调用完成（WASM 是懒加载的）
  const hswOptions = {
    href: `https://suno.com/`,
    ardata: null,
    vm_data: null,
    uj_data: null,
  };
  const rawResult = await hswFn(reqJwt, hswOptions);

  // 恢复 fetch 和 WASM 拦截器
  if (_origFetch) (globalThis as any).fetch = _origFetch;
  (WebAssembly as any).instantiate = origInstantiate;
  if (origInstantiateStreaming) (WebAssembly as any).instantiateStreaming = origInstantiateStreaming;
  if (_wasmFetched.length > 0) {
    console.log('WASM/fetch URLs during hsw call:', _wasmFetched);
  } else {
    console.warn('No fetch calls detected during hsw call - WASM may not be loading!');
  }
  console.log('hsw raw result type:', typeof rawResult);
  if (rawResult && typeof rawResult === 'object') {
    console.log('hsw result keys:', Object.keys(rawResult).join(', '));
  }
  const proof = typeof rawResult === 'string' ? rawResult
    : (rawResult?.solved ? String(rawResult.solved) : String(rawResult));
  console.log('hsw proof (first 80):', proof.substring(0, 80));
  return { proof, hswFn };
}

async function main() {
  // 从数据库读取指定账户的 cookie
  const db = await getDb();
  const row = db.prepare("SELECT id, email, cookie FROM accounts WHERE email = 'xzwthu@gmail.com' LIMIT 1").get() as any;
  if (!row) { console.error('Account xzwthu@gmail.com not found in DB'); process.exit(1); }
  console.log('Using account:', row.email, '(id:', row.id + ')');

  const cookies = cookie.parse(row.cookie as string);
  // UA 必须与 sec-ch-ua 头一致，固定用 Windows Chrome 148
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
  const cookieStr = Object.entries(cookies)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => cookie.serialize(k, v as string))
    .join('; ');

  const commonHeaders = {
    'accept': 'application/json',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'content-type': 'application/json; charset=UTF-8',
    'origin': `${HCAPTCHA_ASSETS}`,
    'referer': `${HCAPTCHA_ASSETS}/`,
    'user-agent': userAgent,
    'cookie': cookieStr,
    'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'priority': 'u=1, i',
  };

  // Step 1: checksiteconfig
  console.log('\n--- Step 1: POST /checksiteconfig ---');
  let configData: any;
  let hcaptchaCookies = cookieStr; // 跟踪 hcaptcha 服务端 set-cookie（包括 pst 等）
  try {
    const resp = await axios.post(
      `${HCAPTCHA_API}/checksiteconfig?v=${HCAPTCHA_VERSION}&host=suno.com&sitekey=${HCAPTCHA_SITEKEY}&sc=1&swa=1&spst=1`,
      null,
      { headers: commonHeaders }
    );
    configData = resp.data;
    // 捕获 set-cookie（包括 pst per-session token）
    const setCookies = resp.headers['set-cookie'];
    if (setCookies && setCookies.length) {
      const newCookies = setCookies.map((c: string) => c.split(';')[0]).join('; ');
      hcaptchaCookies = [cookieStr, newCookies].filter(Boolean).join('; ');
      console.log('checksiteconfig set-cookie:', newCookies);
    }
    console.log('pass:', configData.pass, '| c.type:', configData.c?.type, '| enc_get_req:', configData.features?.enc_get_req);
    console.log('Full checksiteconfig response:', JSON.stringify(configData, null, 2));
  } catch (e: any) {
    console.error('checksiteconfig error:', e?.response?.status, JSON.stringify(e?.response?.data ?? e?.message));
    process.exit(1);
  }

  if (configData?.c?.type !== 'hsw') {
    console.warn('Got non-hsw type:', configData?.c?.type);
    process.exit(0);
  }

  const encGetReq: boolean = configData.features?.enc_get_req === true;
  const challengeSpec = configData.c;  // {type:"hsw", req:"JWT..."}
  const reqJwt: string = challengeSpec.req;

  // Step 2: 用 hsw.js 生成 PoW proof
  console.log('\n--- Step 2: Solving PoW via hsw.js ---');
  const jwtPay = decodeJwtPayload(reqJwt);
  if (jwtPay.e) console.log('JWT expires at:', new Date(jwtPay.e * 1000).toISOString(), '(now:', new Date().toISOString() + ')');
  let proof: string;
  let hswFn: Function;
  try {
    ({ proof, hswFn } = await solveHsw(reqJwt, cookieStr, userAgent));
  } catch (e: any) {
    _cleanupBrowserGlobals();
    console.error('solveHsw error:', e?.message ?? e);
    process.exit(1);
  }

  // ---- 生成仿真鼠标轨迹 ----
  // mm: [[t,x,y],...] 鼠标移动  md: [[t,x,y]] 按下  mu: [[t,x,y]] 抬起
  function genMotionData(baseTime: number): Record<string, any> {
    const mm: number[][] = [];
    // 模拟鼠标从左上角缓慢移向 checkbox 区域（约 300,400）
    let x = 80 + Math.random() * 40;
    let y = 100 + Math.random() * 40;
    const targetX = 280 + Math.random() * 40;
    const targetY = 380 + Math.random() * 40;
    const steps = 20 + Math.floor(Math.random() * 15);
    let t = baseTime - 2000 - Math.floor(Math.random() * 500);
    for (let i = 0; i < steps; i++) {
      x += (targetX - x) * (0.12 + Math.random() * 0.08) + (Math.random() - 0.5) * 3;
      y += (targetY - y) * (0.12 + Math.random() * 0.08) + (Math.random() - 0.5) * 3;
      t += 30 + Math.floor(Math.random() * 60);
      mm.push([t, Math.round(x), Math.round(y)]);
    }
    const clickT = t + 80 + Math.floor(Math.random() * 60);
    const cx = Math.round(x);
    const cy = Math.round(y);
    const md = [[clickT, cx, cy]];
    const mu = [[clickT + 80 + Math.floor(Math.random() * 40), cx, cy]];
    // wdata: Chrome 148 on Windows 典型的 Object.keys(window) 指纹
    const wdata = [
      "0","1","window","self","document","name","location","customElements",
      "history","navigation","locationbar","menubar","personalbar","scrollbars",
      "statusbar","toolbar","status","closed","frames","length","top","opener",
      "parent","frameElement","navigator","origin","external","screen",
      "innerWidth","innerHeight","scrollX","pageXOffset","scrollY","pageYOffset",
      "visualViewport","screenX","screenY","outerWidth","outerHeight",
      "devicePixelRatio","event","clientInformation","offscreenBuffering",
      "screenLeft","screenTop","defaultStatus","defaultstatus","styleMedia",
      "onsearch","isSecureContext","trustedTypes","performance","crypto",
      "indexedDB","sessionStorage","localStorage",
      "onload","onbeforeunload","onunload","onpagehide","onpageshow",
      "onpopstate","onstorage","onhashchange","onlanguagechange",
      "onmessage","onmessageerror","onrejectionhandled","onunhandledrejection",
      "ondevicemotion","ondeviceorientation","ondeviceorientationabsolute",
      "oncontextmenu","onblur","onfocus","oncancel","onauxclick","onbeforeinput",
      "onclick","onclose","ondblclick","ondrag","ondragend","ondragenter",
      "ondragleave","ondragover","ondragstart","ondrop","onerror","oninput",
      "onkeydown","onkeypress","onkeyup","onmousedown","onmousemove",
      "onmouseout","onmouseover","onmouseup","onmousewheel",
      "onpointercancel","onpointerdown","onpointermove","onpointerup",
      "onresize","onscroll","onselect","onsubmit","onwheel",
      "AbortController","AbortSignal","Blob","BroadcastChannel",
      "Cache","CacheStorage","CloseEvent","Comment","CustomEvent",
      "DOMException","DOMParser","Document","DocumentFragment","Element",
      "ErrorEvent","Event","EventSource","EventTarget","File","FileList",
      "FileReader","FormData","HTMLElement","Headers","Image","ImageBitmap",
      "IntersectionObserver","KeyboardEvent","Location","Map","MediaQueryList",
      "MessageChannel","MessageEvent","MessagePort","MouseEvent",
      "MutationObserver","Node","NodeList","Object","Performance",
      "PointerEvent","PopStateEvent","Promise","Proxy","ReadableStream",
      "Request","ResizeObserver","Response","Screen","Set","Storage",
      "SubtleCrypto","Text","TextDecoder","TextEncoder","TouchEvent",
      "URL","URLSearchParams","WebSocket","Window","Worker",
      "WritableStream","XMLHttpRequest","XMLSerializer",
      "caches","cancelAnimationFrame","clearInterval","clearTimeout",
      "fetch","getComputedStyle","matchMedia","postMessage","queueMicrotask",
      "requestAnimationFrame","requestIdleCallback","setInterval","setTimeout",
    ];
    // topLevel 包含 hCaptcha 收集的各类浏览器指纹，缺失字段会使服务端一直 challenge
    const topLevel = {
      st: baseTime - 3000,
      sc: { availWidth: 1920, availHeight: 1040, width: 1920, height: 1080, colorDepth: 24, pixelDepth: 24 },
      nv: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        language: 'zh-CN',
        languages: ['zh-CN', 'zh', 'en'],
        platform: 'Win32',
        hardwareConcurrency: 8,
        deviceMemory: 8,
        maxTouchPoints: 0,
        cookieEnabled: true,
        doNotTrack: null,
        vendor: 'Google Inc.',
        appName: 'Netscape',
        appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        oscpu: undefined,
        product: 'Gecko',
        productSub: '20030107',
        connection: { effectiveType: '4g', rtt: 50, downlink: 10 },
      },
      dr: 'https://suno.com/create',
      inv: false,
      exec: false,
      wn: [[0, 0, 1920, 1080, baseTime - 2800]],
      wn2: [[1920, 1080, 1, baseTime - 2800]],
      wm: [[0, 0, baseTime - 2800]],
      xy: [[0, 0, 1, baseTime - 2800]],
      mm, md, mu, ku: [],
      v: 1,
      wdata,
      cr: { '0': 1, '1': 1 },
      vc: { 'visible': 1 },
      ce: true,
      dv: 0,
      se: false,
      vd: false,
    };
    return {
      st: baseTime - 3000,
      dct: baseTime - 3000,
      mm, md, mu, ku: [], v: 1,
      topLevel,
    };
  }

  // Step 3: getcaptcha
  console.log('\n--- Step 3: POST /getcaptcha ---');
  console.log('  enc_get_req:', encGetReq);
  let token: string | null = null;
  // enc_get_req=true 时先尝试加密，若服务端返回 415 则永久降级为 plain
  let useEncrypted = encGetReq;
  // 当前轮次的 challenge spec
  let currentChallengeSpec = challengeSpec;

  for (let round = 0; round < 12; round++) {
    // 每轮之间加短暂延迟，模拟人工行为（太快会被识别为机器人）
    if (round > 0) await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 400)));
    console.log(`  Round ${round + 1}: submitting proof (first 40: ${proof.substring(0, 40)}...)`);
    console.log(`  c spec used: type=${currentChallengeSpec?.type ?? '?'}, req_prefix=${String(currentChallengeSpec?.req ?? '').substring(0, 20)}...`);
    let contentType = 'application/x-www-form-urlencoded';
    try {
      let body: string | Buffer;
      let responseType: 'json' | 'arraybuffer';

      // 构建基础 form data（不含 c 字段，加密时 c 会放入 msgpack wrapper）
      const st = Date.now();
      const motionTopLevel = genMotionData(st);
      const formData: Record<string, any> = {
        v: HCAPTCHA_VERSION,
        sitekey: HCAPTCHA_SITEKEY,
        host: 'suno.com',
        hl: 'en',
        n: proof,
        motionData: JSON.stringify({
          st: motionTopLevel.st,
          dct: motionTopLevel.dct,
          mm: motionTopLevel.mm,
          md: motionTopLevel.md,
          mu: motionTopLevel.mu,
          ku: motionTopLevel.ku,
          v: 1,
          topLevel: motionTopLevel.topLevel,
          session: [],
        }),
      };

      console.log('\n  === getcaptcha formData (before encoding) ===');
      console.log('  v:', formData.v);
      console.log('  sitekey:', formData.sitekey);
      console.log('  host:', formData.host);
      console.log('  hl:', formData.hl);
      console.log('  n (proof, first 80):', String(formData.n).substring(0, 80));
      const motionParsed = JSON.parse(formData.motionData);
      console.log('  motionData.st:', motionParsed.st);
      console.log('  motionData.dct:', motionParsed.dct);
      console.log('  motionData.mm (count):', motionParsed.mm?.length);
      console.log('  motionData.md:', JSON.stringify(motionParsed.md));
      console.log('  motionData.mu:', JSON.stringify(motionParsed.mu));
      console.log('  motionData.topLevel.nv.userAgent:', motionParsed.topLevel?.nv?.userAgent);
      console.log('  motionData.topLevel.dr:', motionParsed.topLevel?.dr);
      console.log('  motionData full (for reference):', JSON.stringify(motionParsed, null, 2));
      console.log('  === end formData ===\n');

      if (useEncrypted) {
        // 加密模式：hsw(1, msgpack(formData)) + msgpack([challengeSpecJson, encrypted])
        console.log('  Using encrypted mode (hsw mode 1 + msgpack)');
        const encodedFormData = msgpackEncode(formData); // 内层 formData 用标准 bin 编码
        console.log('  encodedFormData size:', encodedFormData.length, 'bytes');
        let encrypted: Uint8Array | null = null;
        try {
          const result = await hswFn(1, encodedFormData);
          console.log('  hsw(1) raw result type:', typeof result, '| constructor:', result?.constructor?.name, '| byteLength:', result?.byteLength ?? result?.length ?? 'n/a');
          if (result instanceof Uint8Array) encrypted = result;
          else if (result instanceof ArrayBuffer) encrypted = new Uint8Array(result);
          else if (result) encrypted = new Uint8Array(result as any);
        } catch (encErr: any) {
          console.warn('  hsw mode 1 failed:', encErr?.message, '- falling back to plain');
        }

        if (encrypted) {
          console.log('  encrypted size:', encrypted.length, 'bytes | first 8 bytes:', Array.from(encrypted.slice(0, 8)).map(b => b.toString(16).padStart(2,'0')).join(' '));
          const challengeSpecJson = JSON.stringify(currentChallengeSpec);
          body = Buffer.from(msgpackEncode([challengeSpecJson, encrypted], { extensionCodec: hcaptchaCodec })); // 外层用 ext type 18 编码 Uint8Array
          contentType = 'application/octet-stream';
          responseType = 'arraybuffer';
          console.log('  Encrypted body size:', body.length, 'bytes');
        } else {
          // 加密失败，回退到 form-urlencoded（含 c 字段）
          console.log('  Encryption fallback: sending plain form-urlencoded');
          formData.c = JSON.stringify(currentChallengeSpec);
          body = new URLSearchParams(formData).toString();
          contentType = 'application/x-www-form-urlencoded';
          responseType = 'json';
        }
      } else {
        // 普通模式：form-urlencoded（含 c 字段）
        formData.c = JSON.stringify(currentChallengeSpec);
        body = new URLSearchParams(formData).toString();
        contentType = 'application/x-www-form-urlencoded';
        responseType = 'json';
      }

      const resp = await axios.post(
        `${HCAPTCHA_API}/getcaptcha/${HCAPTCHA_SITEKEY}`,
        body,
        {
          headers: {
            ...commonHeaders,
            'accept': 'application/json, application/octet-stream',
            'content-type': contentType,
            'cookie': hcaptchaCookies, // 包含 checksiteconfig 返回的 pst 等 cookie
          },
          responseType,
        }
      );
      // 更新 hcaptcha cookies（持续跟踪 set-cookie）
      const getRespCookies = resp.headers['set-cookie'];
      if (getRespCookies && getRespCookies.length) {
        const newC = getRespCookies.map((c: string) => c.split(';')[0]).join('; ');
        hcaptchaCookies = [hcaptchaCookies, newC].filter(Boolean).join('; ');
      }
      console.log('  Status:', resp.status);

      // 解析响应
      let respData: any;
      if (responseType === 'arraybuffer') {
        const rawData = resp.data as ArrayBuffer | Buffer;
        const respBytes = Buffer.isBuffer(rawData)
          ? new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength)
          : new Uint8Array(rawData);
        console.log('  Binary response, size:', respBytes.length, 'bytes, first 16:', Array.from(respBytes.slice(0,16)).map(b=>b.toString(16).padStart(2,'0')).join(' '));
        // 检测响应格式：JSON / msgpack / hsw加密
        const firstByte = respBytes[0];
        if (firstByte === 0x7b || firstByte === 0x5b) {
          // 明文 JSON（{ 或 [）
          try { respData = JSON.parse(Buffer.from(respBytes).toString('utf-8')); console.log('  Decoded as plain JSON'); }
          catch (e: any) { console.warn('  JSON.parse failed:', e?.message); }
        } else {
          // 先尝试 msgpack
          let decoded = false;
          try { respData = msgpackDecode(respBytes, { extensionCodec: hcaptchaCodec }); decoded = true; console.log('  Decoded as msgpack'); }
          catch (_) {}
          if (!decoded) {
            // hsw(0, ...) 解密
            try {
              const decrypted = await hswFn(2, respBytes);
              console.log('  hsw(0) result:', decrypted === undefined ? 'undefined' : decrypted === null ? 'null' : (decrypted instanceof Uint8Array ? `Uint8Array(${(decrypted as Uint8Array).length})` : typeof decrypted));
              if (decrypted) {
                const decBytes = decrypted instanceof Uint8Array ? decrypted : new Uint8Array(decrypted as ArrayBuffer);
                try { respData = msgpackDecode(decBytes, { extensionCodec: hcaptchaCodec }); }
                catch { respData = JSON.parse(Buffer.from(decBytes).toString('utf-8')); }
                console.log('  Decoded after hsw(0)');
              }
            } catch (decErr: any) {
              console.warn('  All decode attempts failed:', decErr?.message ?? decErr);
            }
          }
        }
      } else {
        respData = resp.data;
      }

      if (respData) {
        const safe = { ...respData };
        delete safe.tasklist;
        console.log('  Response:', JSON.stringify(safe, null, 2));
      }

      if (respData?.generated_pass_UUID) {
        token = 'P1_' + respData.generated_pass_UUID;
        break;
      }

      // 服务端返回新挑战，继续重试
      if (respData?.success === false && respData?.c?.type === 'hsw' && respData?.c?.req) {
        console.log('  Got new HSW challenge, solving and retrying...');
        const newSpec = respData.c;
        const newJwt = newSpec.req;
        const newPayload = decodeJwtPayload(newJwt);
        if (newPayload.e) console.log('  New JWT expires at:', new Date(newPayload.e * 1000).toISOString(), '(now:', new Date().toISOString() + ')');
        try {
          ({ proof, hswFn } = await solveHsw(newJwt, cookieStr, userAgent));
          currentChallengeSpec = newSpec;
        } catch (e2: any) {
          console.error('  Re-solve error:', e2?.message);
          break;
        }
        continue;
      }

      console.log('  No token found, success=' + respData?.success);
      break;
    } catch (e: any) {
      const status = e?.response?.status;
      // 415/502: 服务端不支持加密格式或网关错误，永久降级为 plain，用当前 proof 再试一次
      if ((status === 415 || status === 502) && contentType === 'application/octet-stream') {
        console.log(`  ${status} error in encrypted mode - disabling encrypted mode, retrying with plain form-urlencoded`);
        useEncrypted = false;
        continue; // 下一轮直接用 plain form-urlencoded + 同一 proof
      }
      console.error('  getcaptcha error:', status, JSON.stringify(e?.response?.data ?? e?.message, null, 2));
      break;
    }
  }

  _cleanupBrowserGlobals();

  if (token) {
    console.log('\n✅ hCaptcha token:', token);
  } else {
    console.log('\n❌ Failed to get token after retry loop');
  }
}

main().catch(console.error);
