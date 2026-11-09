// 通过 CDP 拦截浏览器对 hcaptcha-endpoint-prod.suno.com 的请求
// 保存原始二进制 body，并解码 formData 结构

import fs from 'fs';
import http from 'http';
import { WebSocket } from 'ws';
import { decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';
import { createRequire } from 'module';

const CDP_HOST = 'http://localhost:9222';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

let cmdId = 1;
const pending = new Map();

function send(ws, method, params = {}) {
  const id = cmdId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const targets = await httpGet(`${CDP_HOST}/json`);
  const pageTarget = targets.find(t => t.type === 'page') || targets[0];
  console.log('连接到 Tab:', pageTarget.url);

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  console.log('✅ CDP 已连接\n');

  ws.on('message', raw => {
    const msg = JSON.parse(raw);

    // 处理命令响应
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }

    // 处理事件
    if (msg.method === 'Network.requestWillBeSent') {
      const req = msg.params;
      if (req.request.url.includes('hcaptcha-endpoint-prod.suno.com')) {
        console.log(`\n🌐 [${req.requestId}] ${req.request.method} ${req.request.url}`);
        console.log('   Headers:', Object.entries(req.request.headers)
          .filter(([k]) => ['content-type', 'origin', 'referer'].includes(k.toLowerCase()))
          .map(([k,v]) => `${k}: ${v}`).join(', '));
      }
    }

    if (msg.method === 'Network.loadingFinished') {
      const { requestId } = msg.params;
      // 获取请求 body
      getRequestBody(ws, requestId);
    }
  });

  // 启用 Network
  await send(ws, 'Network.enable', {});
  console.log('📡 Network 监听已启动');
  console.log('⏳ 等待浏览器发送 hCaptcha 请求...');
  console.log('   请在浏览器中触发验证码（刷新 suno.com 或点击生成按钮）\n');

  // 保持运行
  process.on('SIGINT', () => {
    console.log('\n退出');
    ws.close();
    process.exit(0);
  });
}

// 缓存已知的 hcaptcha requestId
const hcaptchaRequests = new Map();

async function getRequestBody(ws, requestId) {
  // 先获取这个请求的信息（通过之前记录的 URL）
  // 我们在 requestWillBeSent 里记录 hcaptcha 请求的 id
  // 这里直接尝试获取所有请求的 body（会有很多，但只处理 hcaptcha 的）
  try {
    const result = await send(ws, 'Network.getResponseBody', { requestId });
    // 不是 hcaptcha 的跳过（这里用个 trick：body 如果包含 success 字段才处理）
    let body;
    if (result.base64Encoded) {
      body = Buffer.from(result.body, 'base64');
    } else {
      body = Buffer.from(result.body, 'utf-8');
    }
    
    if (body.length < 10) return;
    
    // 尝试解析为 JSON 判断是否是 hcaptcha 响应
    try {
      const text = body.toString('utf-8');
      if (text.includes('success') && (text.includes('hsw') || text.includes('hcaptcha'))) {
        const json = JSON.parse(text);
        console.log(`\n📥 响应 [${requestId}]:`, JSON.stringify(json, null, 2));
        if (json.generated_pass_UUID) {
          console.log('\n🎉🎉🎉 GOT TOKEN:', json.generated_pass_UUID);
        }
      }
    } catch(e) {}
  } catch(e) {}
}

// 重新设计：拦截请求 body
async function mainV2() {
  const targets = await httpGet(`${CDP_HOST}/json`);
  // 优先连接 suno.com 的 tab
  const pageTarget = targets.find(t => t.type === 'page' && t.url.includes('suno.com'))
    || targets.find(t => t.type === 'page')
    || targets[0];
  console.log('连接到 Tab:', pageTarget.url);

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  console.log('✅ CDP 已连接\n');

  // 记录 hcaptcha 请求
  const requestMap = new Map(); // requestId -> {url, method}

  ws.on('message', raw => {
    const msg = JSON.parse(raw);

    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }

    if (msg.method === 'Network.requestWillBeSentExtraInfo') {
      // 包含额外 headers 信息
    }

    if (msg.method === 'Network.requestWillBeSent') {
      const { requestId, request } = msg.params;
      if (request.url.includes('hcaptcha-endpoint-prod')) {
        requestMap.set(requestId, { url: request.url, method: request.method });
        console.log(`\n🌐 捕获请求 [${requestId}]`);
        console.log('   URL:', request.url);
        console.log('   Method:', request.method);
        if (request.postData) {
          console.log('   postData (text):', request.postData.slice(0, 100));
        }
      }
    }

    if (msg.method === 'Network.loadingFinished') {
      const { requestId } = msg.params;
      if (requestMap.has(requestId)) {
        handleHcaptchaResponse(ws, requestId, requestMap.get(requestId));
      }
    }

    if (msg.method === 'Network.loadingFailed') {
      const { requestId, errorText } = msg.params;
      if (requestMap.has(requestId)) {
        console.log(`\n❌ 请求失败 [${requestId}]:`, errorText);
      }
    }
  });

  await send(ws, 'Network.enable', {});
  
  // 启用请求体捕获
  await send(ws, 'Network.setRequestInterception', {
    patterns: [{ urlPattern: '*hcaptcha-endpoint-prod*', interceptionStage: 'Request' }]
  }).catch(() => {
    // 旧版 CDP 用 Fetch.enable
    return send(ws, 'Fetch.enable', {
      patterns: [{ urlPattern: '*hcaptcha-endpoint-prod*', requestStage: 'Request' }]
    });
  });

  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.method === 'Network.requestIntercepted') {
      handleIntercepted(ws, msg.params);
    }
    if (msg.method === 'Fetch.requestPaused') {
      handleFetchPaused(ws, msg.params);
    }
  });

  console.log('📡 请求拦截已启动');
  console.log('⏳ 请在浏览器中触发 hCaptcha（刷新 suno.com 页面）\n');

  process.on('SIGINT', () => { ws.close(); process.exit(0); });
}

async function handleIntercepted(ws, params) {
  const { interceptionId, request } = params;
  console.log(`\n🔴 拦截到请求: ${request.url}`);
  
  if (request.postData) {
    // base64 decode
    const body = Buffer.from(request.postData, 'base64');
    console.log(`   Body 长度: ${body.length} bytes`);
    console.log(`   前16字节 hex: ${body.slice(0, 16).toString('hex')}`);
    
    // 保存原始 body
    const filename = `scripts/captured_getcaptcha_${Date.now()}.bin`;
    fs.writeFileSync(filename, body);
    console.log(`   ✅ 已保存到 ${filename}`);
    
    // 尝试解码
    decodeBody(body);
  }
  
  // 放行请求
  await send(ws, 'Network.continueInterceptedRequest', { interceptionId });
}

async function handleFetchPaused(ws, params) {
  const { requestId, request } = params;
  console.log(`\n🔴 Fetch 拦截: ${request.url}`);
  
  if (request.postData) {
    const body = Buffer.from(request.postData, 'base64');
    console.log(`   Body 长度: ${body.length} bytes`);
    console.log(`   前32字节 hex: ${body.slice(0, 32).toString('hex')}`);
    
    const filename = `scripts/captured_getcaptcha_${Date.now()}.bin`;
    fs.writeFileSync(filename, body);
    console.log(`   ✅ 已保存到 ${filename}`);
    
    decodeBody(body);
  }
  
  // 放行请求
  await send(ws, 'Fetch.continueRequest', { requestId });
}

async function handleHcaptchaResponse(ws, requestId, reqInfo) {
  try {
    // 获取请求 body
    const bodyResult = await send(ws, 'Network.getRequestPostData', { requestId });
    if (bodyResult && bodyResult.postData) {
      const body = Buffer.from(bodyResult.postData, 'base64');
      console.log(`\n📤 请求 body [${requestId}] 长度: ${body.length} bytes`);
      console.log(`   前32字节 hex: ${body.slice(0, 32).toString('hex')}`);
      
      const filename = `scripts/captured_${Date.now()}.bin`;
      fs.writeFileSync(filename, body);
      console.log(`   ✅ 已保存到 ${filename}`);
      
      decodeBody(body);
    }
    
    // 获取响应 body
    const respResult = await send(ws, 'Network.getResponseBody', { requestId });
    if (respResult) {
      let respBody;
      if (respResult.base64Encoded) {
        respBody = Buffer.from(respResult.body, 'base64');
      } else {
        respBody = Buffer.from(respResult.body, 'utf-8');
      }
      console.log(`\n📥 响应 body [${requestId}] 长度: ${respBody.length} bytes`);
      
      if (respBody[0] === 0x7b) {
        const json = JSON.parse(respBody.toString('utf-8'));
        console.log('   响应:', JSON.stringify(json));
        if (json.generated_pass_UUID) {
          console.log('\n🎉🎉🎉 TOKEN 获取成功:', json.generated_pass_UUID);
        }
      }
    }
  } catch(e) {
    // console.log('获取 body 失败:', e.message);
  }
}

function decodeBody(body) {
  try {
    // msgpack fixarray(2) 应该以 0x92 开头
    if (body[0] === 0x92) {
      const decoded = msgpackDecode(body);
      console.log('\n   📦 msgpack 解码成功!');
      console.log('   [0] challengeSpec:', JSON.stringify(decoded[0]));
      if (decoded[1] instanceof Uint8Array) {
        console.log(`   [1] encrypted blob: Uint8Array(${decoded[1].length})`);
        console.log(`   [1] hex (前16): ${Buffer.from(decoded[1]).slice(0,16).toString('hex')}`);
      }
    } else {
      console.log(`   首字节 0x${body[0].toString(16)} 不是 msgpack fixarray(2) (0x92)`);
    }
  } catch(e) {
    console.log('   msgpack 解码失败:', e.message);
  }
}

mainV2().catch(e => { console.error('错误:', e.message); process.exit(1); });
