// 通过 Chrome DevTools Protocol (CDP) 把 DB 中的账号 cookie 注入到已打开的 Chrome 中
// 前提：chrome.exe --remote-debugging-port=9222
//
// 用法：
//   node scripts/inject-cookies-cdp.mjs
//   node scripts/inject-cookies-cdp.mjs --email user@example.com

import { existsSync, readFileSync } from 'fs';
import http from 'http';
import path from 'node:path';
import { createRequire } from 'module';
import * as cookie from 'cookie';
import { WebSocket } from 'ws';

const CDP_HOST = 'http://localhost:9222';
const DB_FILE = path.join(process.cwd(), 'data', 'suno.db');
const require = createRequire(import.meta.url);

function parseEmailArg() {
  const emailFlagIndex = process.argv.indexOf('--email');
  if (emailFlagIndex === -1) return undefined;
  const email = process.argv[emailFlagIndex + 1];
  if (!email) throw new Error('--email requires a value');
  return email;
}

async function loadTargetAccount(email) {
  if (!existsSync(DB_FILE)) throw new Error(`Database not found: ${DB_FILE}`);

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
  });
  const db = new SQL.Database(readFileSync(DB_FILE));

  try {
    const stmt = email
      ? db.prepare('SELECT id, email, cookie FROM accounts WHERE email = ? AND enabled = 1 LIMIT 1')
      : db.prepare('SELECT id, email, cookie FROM accounts WHERE enabled = 1 ORDER BY added_at ASC LIMIT 1');
    if (email) stmt.bind([email]);
    const row = stmt.step() ? stmt.getAsObject() : undefined;
    stmt.free();
    if (!row) throw new Error(email ? `Enabled account not found: ${email}` : 'No enabled accounts in DB');
    return row;
  } finally {
    db.close();
  }
}

function parseCookies(cookieStr) {
  return Object.entries(cookie.parse(cookieStr)).map(([name, value]) => ({
    name,
    value,
  }));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function cdpCommand(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const handler = (msg) => {
      const data = JSON.parse(msg);
      if (data.id !== id) return;
      ws.removeListener('message', handler);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolve(data.result);
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function selectPageTarget() {
  const targets = await httpGet(`${CDP_HOST}/json`);
  console.log('\n当前打开的 Tab:');
  targets.forEach((t, i) => console.log(`  [${i}] ${t.type}: ${t.url}`));

  const pageTarget = targets.find(t => t.type === 'page' && !t.url.startsWith('devtools://')) ?? targets[0];
  if (!pageTarget) throw new Error('No Chrome CDP target found');
  console.log('\n使用 Tab:', pageTarget.url);
  console.log('WebSocket URL:', pageTarget.webSocketDebuggerUrl);
  return pageTarget;
}

async function connectCdp(pageTarget) {
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  console.log('\nCDP 连接成功');
  return ws;
}

async function injectCookies(ws, cookies) {
  await cdpCommand(ws, 1, 'Network.enable', {});

  console.log('\n清除 suno.com 旧 cookie...');
  await cdpCommand(ws, 2, 'Network.clearBrowserCookies', {});

  console.log(`\n开始注入 ${cookies.length} 个 cookie...`);
  let cmdId = 10;
  let successCount = 0;
  let failCount = 0;

  for (const item of cookies) {
    try {
      const result = await cdpCommand(ws, cmdId++, 'Network.setCookie', {
        name: item.name,
        value: item.value,
        domain: '.suno.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'None',
      });
      if (result.success) successCount++;
      else {
        console.warn(`  ${item.name} = 设置失败`);
        failCount++;
      }
    } catch (e) {
      console.warn(`  ${item.name}: ${e.message}`);
      failCount++;
    }
  }

  console.log(`\n注入完成: ${successCount} 成功, ${failCount} 失败`);
  return cmdId;
}

async function main() {
  const target = await loadTargetAccount(parseEmailArg());
  console.log('账号:', target.email);
  console.log('Cookie 长度:', target.cookie.length);

  const pageTarget = await selectPageTarget();
  const ws = await connectCdp(pageTarget);

  try {
    const cmdId = await injectCookies(ws, parseCookies(target.cookie));
    console.log('\n正在导航到 https://suno.com ...');
    await cdpCommand(ws, cmdId, 'Page.navigate', { url: 'https://suno.com' });

    console.log('完成。浏览器应该已经跳转到 suno.com，带着注入的 cookie');
    console.log('如果登录成功，页面会显示你的账号信息');
    console.log('然后你可以在 Network 面板里找 hCaptcha 相关请求');
  } finally {
    ws.close();
  }
}

main().catch(err => {
  console.error('出错:', err.message);
  process.exit(1);
});
