#!/usr/bin/env python3
"""
hCaptcha hsw 流程 - Python 版
curl_cffi 解决 TLS/JA3/JA4 + HTTP/2 指纹问题
hsw PoW 由 Node.js 子进程（hsw_solve.mjs）完成

用法:
  python scripts/hcaptcha_solve.py
  python scripts/hcaptcha_solve.py xzwthu@gmail.com

依赖: pip install curl_cffi
"""

import json
import random
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    print("请先安装依赖: pip install curl_cffi")
    sys.exit(1)

# ─── 配置 ──────────────────────────────────────────────────────────────────
HCAPTCHA_SITEKEY = 'd65453de-3f1a-4aac-9366-a0f06e52b2ce'
HCAPTCHA_API     = 'https://hcaptcha-endpoint-prod.suno.com'
HCAPTCHA_ASSETS  = 'https://hcaptcha-assets-prod.suno.com'
HCAPTCHA_VERSION = 'be2fb915d274e0153a2483e68ec5703d502b9d3d'

TARGET_EMAIL = sys.argv[1] if len(sys.argv) > 1 else 'xzwthu@gmail.com'
DB_PATH      = Path(__file__).parent.parent / 'data' / 'suno.db'
HSW_SOLVER   = Path(__file__).parent / 'hsw_solve.mjs'

USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/124.0.0.0 Safari/537.36'
)

# ─── 工具函数 ──────────────────────────────────────────────────────────────

def read_cookie_from_db(email: str) -> str:
    """从 suno.db 读取账户 cookie 字符串"""
    # suno.db 是标准 SQLite 文件（sql.js export 格式）
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute(
        'SELECT cookie FROM accounts WHERE email = ? LIMIT 1', (email,)
    ).fetchone()
    conn.close()
    if not row:
        raise RuntimeError(f'Account {email} not found in DB')
    return row[0]


def parse_cookies(cookie_str: str) -> dict:
    """cookie 字符串 → dict，跳过含非法字符的项"""
    result = {}
    for part in cookie_str.split(';'):
        part = part.strip()
        if '=' not in part:
            continue
        k, v = part.split('=', 1)
        k, v = k.strip(), v.strip()
        # 跳过含控制字符的 cookie（与 Playwright 版本保持一致）
        if any(ord(c) < 0x20 or ord(c) == 0x7f for c in k + v):
            continue
        result[k] = v
    return result


def gen_motion_data(base_time: int) -> dict:
    """生成仿真鼠标轨迹（与 test-hcaptcha.ts 逻辑一致）"""
    x = 80 + random.random() * 40
    y = 100 + random.random() * 40
    tx = 280 + random.random() * 40
    ty = 380 + random.random() * 40
    steps = 20 + random.randint(0, 14)
    t = base_time - 2000 - random.randint(0, 499)

    mm = []
    for _ in range(steps):
        x += (tx - x) * (0.12 + random.random() * 0.08) + (random.random() - 0.5) * 3
        y += (ty - y) * (0.12 + random.random() * 0.08) + (random.random() - 0.5) * 3
        t += 30 + random.randint(0, 59)
        mm.append([t, round(x), round(y)])

    click_t = t + 80 + random.randint(0, 59)
    cx, cy = round(x), round(y)
    md = [[click_t, cx, cy]]
    mu = [[click_t + 80 + random.randint(0, 39), cx, cy]]

    top_level = {
        'st':  base_time - 3000,
        'sc':  {'availWidth': 1920, 'availHeight': 1040, 'width': 1920, 'height': 1080,
                'colorDepth': 24, 'pixelDepth': 24},
        'nv':  {
            'userAgent':          USER_AGENT,
            'language':           'zh-CN',
            'languages':          ['zh-CN', 'zh', 'en'],
            'platform':           'Win32',
            'hardwareConcurrency': 8,
            'deviceMemory':       8,
            'maxTouchPoints':     0,
            'cookieEnabled':      True,
            'doNotTrack':         None,
            'vendor':             'Google Inc.',
            'appName':            'Netscape',
            'appVersion':         '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'product':            'Gecko',
            'productSub':         '20030107',
            'connection':         {'effectiveType': '4g', 'rtt': 50, 'downlink': 10},
        },
        'dr':   'https://suno.com/create',
        'inv':  False,
        'exec': False,
        'wn':   [[0, 0, 1920, 1080, base_time - 2800]],
        'wn2':  [[1920, 1080, 1, base_time - 2800]],
        'wm':   [[0, 0, base_time - 2800]],
        'xy':   [[0, 0, 1, base_time - 2800]],
        'mm': mm, 'md': md, 'mu': mu, 'ku': [],
        'v':    1,
        'ce':   True,
        'dv':   0,
        'se':   False,
        'vd':   False,
    }

    return {
        'st':  base_time - 3000,
        'dct': base_time - 3000,
        'mm': mm, 'md': md, 'mu': mu, 'ku': [],
        'v':  1,
        'topLevel': top_level,
        'session':  [],
    }


def solve_pow(req_jwt: str, cookie_str: str) -> str:
    """调用 Node.js 子进程（hsw_solve.mjs）解 PoW"""
    payload = json.dumps({
        'jwt':         req_jwt,
        'cookie':      cookie_str,
        'assets_base': HCAPTCHA_ASSETS,
        'version':     HCAPTCHA_VERSION,
    })
    result = subprocess.run(
        ['node', str(HSW_SOLVER)],
        input=payload,
        capture_output=True,
        text=True,
        timeout=60,
    )
    # stderr 是 debug 日志，直接透传打印
    if result.stderr:
        for line in result.stderr.strip().splitlines():
            print(line)
    if result.returncode != 0:
        raise RuntimeError(f'hsw_solve.mjs exited {result.returncode}: {result.stderr[:300]}')
    # hsw.js 内部可能有 console.log 输出（如 "undefined"），取最后一个 JSON 行
    json_line = next(
        (ln for ln in reversed(result.stdout.strip().splitlines()) if ln.strip().startswith('{')),
        None,
    )
    if not json_line:
        raise RuntimeError(f'No JSON in stdout: {repr(result.stdout[:300])}')
    data = json.loads(json_line)
    if 'error' in data:
        raise RuntimeError(f'hsw_solve error: {data["error"]}')
    return data['proof']


# ─── 主流程 ────────────────────────────────────────────────────────────────

def main():
    print(f'Using account: {TARGET_EMAIL}')

    cookie_str = read_cookie_from_db(TARGET_EMAIL)
    cookies = parse_cookies(cookie_str)
    print(f'Loaded {len(cookies)} cookies')

    # curl_cffi session，impersonate=chrome124 自动处理 TLS/JA3/JA4/HTTP2 指纹
    session = cffi_requests.Session(impersonate='chrome124')

    common_headers = {
        'accept-language':    'zh-CN,zh;q=0.9,en;q=0.8',
        'origin':             HCAPTCHA_ASSETS,
        'referer':            f'{HCAPTCHA_ASSETS}/',
        'sec-ch-ua':          '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile':   '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest':     'empty',
        'sec-fetch-mode':     'cors',
        'sec-fetch-site':     'same-site',
        'priority':           'u=1, i',
    }

    # 把 suno cookie 字符串直接作为请求头发送（与 TS 脚本一致）
    cookie_header = '; '.join(f'{k}={v}' for k, v in cookies.items())

    # ── Step 1: checksiteconfig ──────────────────────────────────────────
    print('\n--- Step 1: checksiteconfig ---')
    resp = session.post(
        f'{HCAPTCHA_API}/checksiteconfig'
        f'?v={HCAPTCHA_VERSION}&host=suno.com&sitekey={HCAPTCHA_SITEKEY}&sc=1&swa=1&spst=1',
        headers={
            **common_headers,
            'accept':       'application/json',
            'content-type': 'application/json; charset=UTF-8',
            'cookie':       cookie_header,
        },
    )
    config = resp.json()
    print(f'pass={config.get("pass")}  c.type={config.get("c", {}).get("type")}  '
          f'enc_get_req={config.get("features", {}).get("enc_get_req")}')

    # 收集 checksiteconfig 返回的 set-cookie（pst 等）
    hcaptcha_cookies = cookie_header
    sc = resp.headers.get('set-cookie', '')
    if sc:
        extra = '; '.join(p.split(';')[0] for p in sc.split(',') if '=' in p.split(';')[0])
        if extra:
            hcaptcha_cookies = f'{hcaptcha_cookies}; {extra}'
            print(f'  set-cookie from checksiteconfig: {extra}')

    if config.get('c', {}).get('type') != 'hsw':
        print(f'Unexpected challenge type: {config.get("c", {}).get("type")}')
        return

    current_spec = config['c']
    req_jwt = current_spec['req']

    # ── Step 2: 解 PoW ───────────────────────────────────────────────────
    print('\n--- Step 2: Solving PoW ---')
    proof = solve_pow(req_jwt, cookie_str)
    print(f'proof (first 80): {proof[:80]}')

    # ── Step 3: getcaptcha 循环 ──────────────────────────────────────────
    print('\n--- Step 3: getcaptcha ---')
    token = None

    for round_n in range(12):
        if round_n > 0:
            time.sleep(0.8 + random.random() * 0.4)

        print(f'\n  Round {round_n + 1}')
        print(f'  proof (first 40): {proof[:40]}...')

        st = int(time.time() * 1000)
        motion = gen_motion_data(st)

        form_data = {
            'v':          HCAPTCHA_VERSION,
            'sitekey':    HCAPTCHA_SITEKEY,
            'host':       'suno.com',
            'hl':         'en',
            'n':          proof,
            'c':          json.dumps(current_spec),
            'motionData': json.dumps(motion),
        }

        # 打印 motionData 关键字段，方便对比
        print(f'  motionData.st:        {motion["st"]}')
        print(f'  motionData.mm count:  {len(motion["mm"])}')
        print(f'  motionData.md:        {motion["md"]}')
        print(f'  motionData.topLevel.nv.userAgent: {motion["topLevel"]["nv"]["userAgent"][:50]}')
        print(f'  motionData.topLevel.dr: {motion["topLevel"]["dr"]}')

        resp = session.post(
            f'{HCAPTCHA_API}/getcaptcha/{HCAPTCHA_SITEKEY}',
            data=form_data,
            headers={
                **common_headers,
                'accept':       'application/json',
                'content-type': 'application/x-www-form-urlencoded',
                'cookie':       hcaptcha_cookies,
            },
        )

        # 跟踪 set-cookie
        sc2 = resp.headers.get('set-cookie', '')
        if sc2:
            extra2 = '; '.join(p.split(';')[0] for p in sc2.split(',') if '=' in p.split(';')[0])
            if extra2:
                hcaptcha_cookies = f'{hcaptcha_cookies}; {extra2}'

        print(f'  Status: {resp.status_code}')
        try:
            data = resp.json()
        except Exception as e:
            print(f'  JSON parse failed: {e}  raw: {resp.text[:200]}')
            break

        safe = {k: v for k, v in data.items() if k != 'tasklist'}
        print(f'  Response: {json.dumps(safe, indent=4, ensure_ascii=False)}')

        if data.get('generated_pass_UUID'):
            token = 'P1_' + data['generated_pass_UUID']
            break

        if (not data.get('success')
                and data.get('c', {}).get('type') == 'hsw'
                and data.get('c', {}).get('req')):
            print('  New HSW challenge, re-solving...')
            current_spec = data['c']
            proof = solve_pow(current_spec['req'], cookie_str)
            continue

        print(f'  No token, success={data.get("success")}')
        break

    if token:
        print(f'\n✅ hCaptcha token: {token}')
    else:
        print('\n❌ Failed to get token')


if __name__ == '__main__':
    main()
