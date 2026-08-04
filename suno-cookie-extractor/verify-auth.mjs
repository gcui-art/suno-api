const CLERK_VERSION = '5.117.0';
const CLERK_BASE_URL = 'https://auth.suno.com';
const SUNO_API_BASE_URL = 'https://studio-api.prod.suno.com';

function parseCookieHeader(cookieHeader) {
  const jar = new Map();
  if (!cookieHeader) return jar;

  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    jar.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }

  return jar;
}

function buildRequestHeaders(cookieHeader) {
  const jar = parseCookieHeader(cookieHeader);
  const client = jar.get('__client');
  if (!client) {
    throw new Error('SUNO_COOKIE is missing __client.');
  }

  const deviceId = jar.get('ajs_anonymous_id') || jar.get('suno_device_id') || 'suno-api-device';

  return {
    client,
    headers: {
      'Affiliate-Id': 'undefined',
      'Device-Id': `"${deviceId}"`,
      'x-suno-client': 'Android prerelease-4nt180t 1.0.42',
      'X-Requested-With': 'com.suno.android',
      'sec-ch-ua': '"Chromium";v="130", "Android WebView";v="130", "Not?A_Brand";v="99"',
      'sec-ch-ua-mobile': '?1',
      'sec-ch-ua-platform': '"Android"',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      Cookie: cookieHeader,
    },
  };
}

async function readResponseBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function probeSunoSession(cookieHeader) {
  const { client, headers } = buildRequestHeaders(cookieHeader);

  const sessionUrl = `${CLERK_BASE_URL}/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=${CLERK_VERSION}`;
  const sessionResponse = await fetch(sessionUrl, {
    headers: { ...headers, Authorization: client },
  });
  const sessionBody = await readResponseBody(sessionResponse);

  if (!sessionResponse.ok) {
    return {
      ok: false,
      sessionId: null,
      error: `Clerk session request failed (${sessionResponse.status})`,
      body: sessionBody,
    };
  }

  const sessionId = sessionBody?.response?.last_active_session_id || null;
  return {
    ok: Boolean(sessionId),
    sessionId,
    error: sessionId ? null : 'No active Suno session yet',
    body: sessionBody,
  };
}

/**
 * Run the same auth flow SunoApi.init() uses: session → JWT → billing.
 * Throws when the cookie cannot authenticate.
 */
export async function verifySunoAuth(cookieHeader) {
  const { client, headers } = buildRequestHeaders(cookieHeader);
  const session = await probeSunoSession(cookieHeader);

  if (!session.ok) {
    throw new Error(
      session.error ||
        'No active Suno session in this cookie. Sign in at suno.com/create and re-run get-cookie.'
    );
  }

  const sessionId = session.sessionId;

  const renewUrl = `${CLERK_BASE_URL}/v1/client/sessions/${sessionId}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=${CLERK_VERSION}`;
  const renewResponse = await fetch(renewUrl, {
    method: 'POST',
    headers: { ...headers, Authorization: client },
    body: '{}',
  });
  const renewBody = await readResponseBody(renewResponse);

  if (!renewResponse.ok) {
    throw new Error(
      `Clerk token renewal failed (${renewResponse.status}): ${JSON.stringify(renewBody)}`
    );
  }

  const jwt = renewBody?.jwt;
  if (!jwt) {
    throw new Error(`Clerk token renewal returned no JWT: ${JSON.stringify(renewBody)}`);
  }

  const billingResponse = await fetch(`${SUNO_API_BASE_URL}/api/billing/info/`, {
    headers: { ...headers, Authorization: `Bearer ${jwt}` },
  });
  const billingBody = await readResponseBody(billingResponse);

  if (!billingResponse.ok) {
    throw new Error(
      `Suno billing request failed (${billingResponse.status}): ${JSON.stringify(billingBody)}`
    );
  }

  return {
    sessionId,
    creditsLeft: billingBody.total_credits_left,
    period: billingBody.period,
    monthlyLimit: billingBody.monthly_limit,
    monthlyUsage: billingBody.monthly_usage,
  };
}