import assert from 'node:assert/strict';
import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import test from 'node:test';
import { chromium, Request, Response } from 'playwright';
import {
  installCaptchaGenerateCapture,
  InvalidCaptchaGenerateRequestError,
  InvalidSunoGenerateResponseError,
  MissingCaptchaTokenError,
  prepareCaptchaGenerateRequest,
  readSunoGenerateClips
} from './sunoCaptchaGenerateCapture';

interface CapturedHttpRequest {
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}

function createRequest(
  payload: Record<string, unknown>,
  headers: Record<string, string | undefined> = {}
): Request {
  return {
    postDataJSON: () => payload,
    headers: () => ({
      authorization: 'Bearer session-token',
      'browser-token': 'page-browser-token',
      'user-agent': 'Chrome/148',
      'sec-ch-ua': '"Chromium";v="148"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"',
      ...headers
    })
  } as unknown as Request;
}

function createResponse(status: number, body: unknown): Response {
  return {
    status: () => status,
    ok: () => status >= 200 && status < 300,
    json: async () => body
  } as unknown as Response;
}

test('merges page captcha fields into the complete actual payload', () => {
  const prepared = prepareCaptchaGenerateRequest(
    createRequest({
      prompt: 'placeholder',
      token: 'page-captcha-token',
      token_provider: 2,
      transaction_uuid: 'page-transaction'
    }),
    {
      prompt: 'actual prompt',
      token: null,
      token_provider: null,
      transaction_uuid: 'actual-transaction',
      user_uploaded_images_b64: ['complete-image-data']
    }
  );

  assert.deepEqual(JSON.parse(prepared.postData), {
    prompt: 'actual prompt',
    token: 'page-captcha-token',
    token_provider: 2,
    transaction_uuid: 'actual-transaction',
    user_uploaded_images_b64: ['complete-image-data']
  });
  assert.equal(prepared.authorizationToken, 'session-token');
  assert.deepEqual(prepared.browserIdentity, {
    userAgent: 'Chrome/148',
    secChUa: '"Chromium";v="148"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Linux"'
  });
});

test('rejects incomplete captcha request context', () => {
  assert.throws(
    () => prepareCaptchaGenerateRequest(
      createRequest({ token_provider: 2 }),
      { prompt: 'actual prompt' }
    ),
    MissingCaptchaTokenError
  );
  assert.throws(
    () => prepareCaptchaGenerateRequest(
      createRequest({ token: 'captcha-token' }),
      { prompt: 'actual prompt' }
    ),
    InvalidCaptchaGenerateRequestError
  );
  assert.throws(
    () => prepareCaptchaGenerateRequest(
      createRequest(
        { token: 'captcha-token', token_provider: 2 },
        { 'browser-token': undefined }
      ),
      { prompt: 'actual prompt' }
    ),
    InvalidCaptchaGenerateRequestError
  );
  assert.throws(
    () => prepareCaptchaGenerateRequest(
      createRequest(
        { token: 'captcha-token', token_provider: 2 },
        { 'user-agent': undefined }
      ),
      { prompt: 'actual prompt' }
    ),
    InvalidCaptchaGenerateRequestError
  );
  assert.throws(
    () => prepareCaptchaGenerateRequest(
      createRequest({ token: 'captcha-token', token_provider: '2' }),
      { prompt: 'actual prompt' }
    ),
    InvalidCaptchaGenerateRequestError
  );
});

test('preserves a null provider from the page request', () => {
  const prepared = prepareCaptchaGenerateRequest(
    createRequest({ token: 'captcha-token', token_provider: null }),
    { prompt: 'actual prompt', token_provider: 2 }
  );
  assert.equal(JSON.parse(prepared.postData).token_provider, null);
});

test('only accepts successful responses with non-empty valid clips', async () => {
  assert.deepEqual(
    await readSunoGenerateClips(createResponse(200, {
      clips: [{ id: 'clip-1', status: 'submitted' }]
    })),
    [{ id: 'clip-1', status: 'submitted' }]
  );

  await assert.rejects(
    readSunoGenerateClips(createResponse(422, { detail: 'captcha rejected' })),
    (error: unknown) => error instanceof InvalidSunoGenerateResponseError &&
      error.message.includes('status 422: captcha rejected')
  );
  await assert.rejects(
    readSunoGenerateClips(createResponse(200, { clips: [] })),
    InvalidSunoGenerateResponseError
  );
  await assert.rejects(
    readSunoGenerateClips(createResponse(200, { clips: [{}] })),
    InvalidSunoGenerateResponseError
  );
  await assert.rejects(
    readSunoGenerateClips({
      status: () => 200,
      ok: () => true,
      json: async () => { throw new Error('invalid JSON'); }
    } as unknown as Response),
    InvalidSunoGenerateResponseError
  );
});

test('continues a Simple page request with the complete cover payload and original headers', async () => {
  let capturedRequest: CapturedHttpRequest | undefined;
  const server = createGenerateServer((request) => {
    capturedRequest = request;
  });
  const baseUrl = await listen(server);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: 'Chrome/148 integration-test' });
  const page = await context.newPage();
  const messages: string[] = [];

  try {
    await page.goto(baseUrl);
    const capture = await installCaptchaGenerateCapture(
      page,
      {
        prompt: 'actual prompt',
        task: 'cover',
        cover_clip_id: 'original-cover-clip',
        cover_start_s: 0,
        cover_end_s: 120,
        persona_id: 'original-persona',
        metadata: { create_mode: 'custom' },
        transaction_uuid: 'original-transaction',
        token: null,
        token_provider: null,
        override_fields: ['prompt'],
        user_uploaded_images_b64: ['complete-image-data']
      },
      {
        info: (message) => messages.push(message),
        warn: (message) => messages.push(message)
      },
      5_000
    );

    const browserRequest = page.evaluate(async (url) => {
      const response = await fetch(`${url}/api/generate/v2-web/`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer browser-session-token',
          'browser-token': 'original-browser-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'placeholder',
          metadata: { create_mode: 'simple' },
          gpt_description_prompt: 'placeholder description',
          token: 'browser-captcha-token',
          token_provider: 2
        })
      });
      return response.status;
    }, baseUrl);
    const [result, status] = await Promise.all([capture.result, browserRequest]);

    assert.equal(status, 200);
    assert.deepEqual(capturedRequest?.body, {
      prompt: 'actual prompt',
      task: 'cover',
      cover_clip_id: 'original-cover-clip',
      cover_start_s: 0,
      cover_end_s: 120,
      persona_id: 'original-persona',
      metadata: { create_mode: 'custom' },
      transaction_uuid: 'original-transaction',
      token: 'browser-captcha-token',
      token_provider: 2,
      override_fields: ['prompt'],
      user_uploaded_images_b64: ['complete-image-data']
    });
    assert.equal(capturedRequest?.headers['browser-token'], 'original-browser-token');
    assert.equal(capturedRequest?.headers.authorization, 'Bearer browser-session-token');
    assert.equal(capturedRequest?.headers['user-agent'], 'Chrome/148 integration-test');
    assert.equal(result.authorizationToken, 'browser-session-token');
    assert.equal(result.browserIdentity.userAgent, 'Chrome/148 integration-test');
    assert.deepEqual(result.clips, [{ id: 'clip-1', status: 'submitted' }]);
    assert.ok(messages.some((message) => message.includes('browser Generate succeeded')));
    capture.cancel();
  } finally {
    await browser.close();
    await closeServer(server);
  }
});

function createGenerateServer(
  onRequest: (request: CapturedHttpRequest) => void
): Server {
  return createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body>captcha test</body></html>');
      return;
    }

    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      onRequest({ body, headers: request.headers });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        clips: [{ id: 'clip-1', status: 'submitted' }]
      }));
    });
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP port');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
