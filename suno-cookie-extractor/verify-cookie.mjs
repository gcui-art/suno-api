#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySunoAuth } from './verify-auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const AUTH_COOKIE_PATTERN =
  /^(?:__client(?:_[^=]+)?|__client_uat(?:_[^=]+)?|__session|ajs_anonymous_id|suno_device_id|suno_auth_bucket)$/;

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

function log(msg, color = '') {
  console.log(color ? `${color}${msg}${c.reset}` : msg);
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

function filterAuthCookies(cookieHeader) {
  const jar = new Map();
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq);
    if (AUTH_COOKIE_PATTERN.test(name)) {
      jar.set(name, trimmed.slice(eq + 1));
    }
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function loadCookieFromEnv() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!existsSync(envPath)) {
    throw new Error(`No .env file found at ${envPath}`);
  }

  const content = await readFile(envPath, 'utf8');
  const match = content.match(/^SUNO_COOKIE=(.+)$/m);
  if (!match) {
    throw new Error('SUNO_COOKIE is not set in .env');
  }

  const raw = parseEnvValue(match[1]);
  if (!raw) {
    throw new Error('SUNO_COOKIE is empty in .env');
  }

  return filterAuthCookies(raw);
}

async function main() {
  const cookie = process.argv[2] || (await loadCookieFromEnv());
  log('Verifying Suno authentication…', c.dim);

  const result = await verifySunoAuth(cookie);

  log('\nAuthentication OK', c.green);
  log(`  Credits left:  ${result.creditsLeft}`);
  log(`  Monthly limit: ${result.monthlyLimit}`);
  log(`  Monthly usage: ${result.monthlyUsage}`);
  log(`  Period:        ${result.period}`);
  log(`  Session ID:    ${result.sessionId}`, c.dim);
}

main().catch((err) => {
  log(`\nAuthentication failed: ${err.message}`, c.red);
  process.exit(1);
});