import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptchaBrowserIdentity } from './sunoCaptchaGenerateCapture';

/**
 * Durable client identity used by the direct API transport.
 *
 * A single Suno account should look like one long-lived browser install:
 * the same Device-Id, the same User-Agent and the same client hints on every
 * request, across process restarts. The values are learned from the real
 * Chromium profile whenever a browser generation succeeds.
 */
export interface SunoApiIdentity {
  deviceId: string;
  browser?: CaptchaBrowserIdentity;
  updatedAt?: string;
}

const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identityRoot(): string {
  return process.env.SUNO_API_IDENTITY_ROOT || '/var/lib/suno-browser/api-identity';
}

function identityPath(accountId: string): string | undefined {
  return SAFE_KEY.test(accountId) ? join(identityRoot(), `${accountId}.json`) : undefined;
}

function validBrowserIdentity(value: unknown): CaptchaBrowserIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.userAgent !== 'string' || !/^Mozilla\/5\.0 /.test(item.userAgent)) return undefined;
  const optional = (key: string) => typeof item[key] === 'string' && item[key] ? item[key] as string : undefined;
  return {
    userAgent: item.userAgent,
    secChUa: optional('secChUa'),
    secChUaMobile: optional('secChUaMobile'),
    secChUaPlatform: optional('secChUaPlatform'),
  };
}

export async function loadSunoApiIdentity(accountId: string): Promise<SunoApiIdentity | undefined> {
  const path = identityPath(accountId);
  if (!path) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed?.deviceId !== 'string' || !UUID_RE.test(parsed.deviceId)) return undefined;
    return {
      deviceId: parsed.deviceId,
      browser: validBrowserIdentity(parsed.browser),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function saveSunoApiIdentity(accountId: string, identity: SunoApiIdentity): Promise<void> {
  const path = identityPath(accountId);
  if (!path) return;
  await mkdir(identityRoot(), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  const body = JSON.stringify({ ...identity, updatedAt: new Date().toISOString() }, null, 2);
  await writeFile(temp, body, { mode: 0o600 });
  await rename(temp, path);
}

/** Prefer the analytics id the website itself uses, then a persisted id. */
export function resolveDeviceId(
  cookies: Record<string, string | undefined>,
  persisted?: SunoApiIdentity
): string {
  const fromCookie = cookies.ajs_anonymous_id?.replace(/^"+|"+$/g, '');
  if (fromCookie && UUID_RE.test(fromCookie)) return fromCookie;
  return persisted?.deviceId ?? randomUUID();
}

export function mergeBrowserIdentity(
  current: CaptchaBrowserIdentity | undefined,
  next: CaptchaBrowserIdentity | undefined
): CaptchaBrowserIdentity | undefined {
  return validBrowserIdentity(next) ?? current;
}

/** Random pause before the first direct submit so requests are not metronomic. */
export function apiSubmitJitterMs(random = Math.random): number {
  const parsed = Number.parseInt(process.env.SUNO_API_SUBMIT_JITTER_MS ?? '', 10);
  const maximum = Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 60_000) : 4_000;
  return Math.floor(random() * maximum);
}

export function apiSubmitTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.SUNO_API_SUBMIT_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 5_000 ? Math.min(parsed, 60_000) : 25_000;
}

type ApiOutcome = 'accepted' | 'precheck_token' | 'captcha' | 'error';

const statsState = globalThis as typeof globalThis & {
  __sunoApiSubmitStats?: Record<ApiOutcome, number> & { since: string };
};

/** In-process counters so captcha rate can be read straight from the journal. */
export function recordApiSubmitOutcome(outcome: ApiOutcome): Record<string, number | string> {
  const stats = statsState.__sunoApiSubmitStats ??= {
    accepted: 0, precheck_token: 0, captcha: 0, error: 0, since: new Date().toISOString(),
  };
  stats[outcome] += 1;
  const attempts = stats.accepted + stats.captcha + stats.error;
  return {
    ...stats,
    captchaRate: attempts ? Number((stats.captcha / attempts).toFixed(3)) : 0,
  };
}
