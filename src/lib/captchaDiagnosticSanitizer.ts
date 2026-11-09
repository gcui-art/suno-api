const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const TURNSTILE_DIAGNOSTIC_PATH = '/cdn-cgi/challenge-platform/turnstile';

export const SENSITIVE_DIAGNOSTIC_QUERY_PARAMETERS = [
  '__clerk_handshake',
  '__session',
  'authorization',
  'code',
  'session',
  'session_id',
  'state',
  'token'
] as const;

export function sanitizeDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.origin === TURNSTILE_ORIGIN) {
      return `${TURNSTILE_ORIGIN}${classifyTurnstilePath(url.pathname)}`;
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.origin}${url.pathname}`;
    }
    return `${url.protocol}${url.pathname}`;
  } catch {
    return value;
  }
}

function classifyTurnstilePath(pathname: string): string {
  if (pathname.includes('/failure_retry/')) return `${TURNSTILE_DIAGNOSTIC_PATH}/failure_retry`;
  if (pathname.includes('/pat/')) return `${TURNSTILE_DIAGNOSTIC_PATH}/pat`;
  if (pathname.includes('/flow/')) return `${TURNSTILE_DIAGNOSTIC_PATH}/flow`;
  if (pathname.includes('/turnstile/') || pathname.includes('/rch')) {
    return `${TURNSTILE_DIAGNOSTIC_PATH}/challenge`;
  }
  return pathname;
}
