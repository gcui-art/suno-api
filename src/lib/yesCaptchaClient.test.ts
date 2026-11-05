import assert from 'node:assert/strict';
import test from 'node:test';
import { AxiosInstance } from 'axios';
import { YesCaptchaClient } from './yesCaptchaClient';

test('creates a TurnstileTaskProxyless task and returns its token', async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const client = createClient(
    {
      errorId: 0,
      status: 'ready',
      solution: { token: 'turnstile-token' }
    },
    requests
  );

  const token = await new YesCaptchaClient('client-key', client).solveTurnstile(
    'https://suno.com/create',
    'website-key'
  );

  assert.equal(token, 'turnstile-token');
  assert.deepEqual(requests, [
    {
      url: 'https://api.yescaptcha.com/createTask',
      body: {
        clientKey: 'client-key',
        task: {
          type: 'TurnstileTaskProxyless',
          websiteURL: 'https://suno.com/create',
          websiteKey: 'website-key'
        }
      }
    }
  ]);
});

test('rejects a ready Turnstile task without a token', async () => {
  const client = createClient(
    { errorId: 0, status: 'ready', solution: {} },
    []
  );
  await assert.rejects(
    () =>
      new YesCaptchaClient('client-key', client).solveTurnstile(
        'https://suno.com/create',
        'website-key'
      ),
    /no Turnstile token/
  );
});

test('maps image classification objects and top_k to tile indexes, ignoring montage coordinates', async () => {
  for (const selection of [
    { objects: [true, false, true], top_k: [1] },
    { objects: [1, 0, 1] },
    { top_k: [0, 2] }
  ]) {
    const client = createClient(
      {
        errorId: 0,
        status: 'ready',
        solution: {
          type: 'click',
          box: ['60', '60', '300', '60'],
          clicks: [
            { x: 60, y: 60 },
            { x: 300, y: 60 }
          ],
          ...selection
        }
      },
      []
    );

    assert.deepEqual(
      await new YesCaptchaClient('client-key', client).solveHcaptchaByImages(
        ['image-0', 'image-1', 'image-2'],
        'Select drinks'
      ),
      [
        { type: 'clickTile', index: 0 },
        { type: 'clickTile', index: 2 }
      ]
    );
  }
});

test('rejects image classification results that cannot identify the submitted tiles', async () => {
  for (const solution of [
    { box: ['60', '60'] },
    { objects: [true] },
    { top_k: [-1] },
    { top_k: [3] },
    { top_k: [0.5] },
    { objects: [false, false, false], top_k: [0], box: ['60', '60'] }
  ]) {
    const client = createClient({ errorId: 0, status: 'ready', solution }, []);
    await assert.rejects(() =>
      new YesCaptchaClient('client-key', client).solveHcaptchaByImages(
        ['image-0', 'image-1', 'image-2'],
        'Select drinks'
      )
    );
  }
});

test('keeps screenshot click coordinates even when classification indexes are also returned', async () => {
  for (const points of [
    { box: ['60', '180'] },
    { clicks: [{ x: 60, y: 180 }] },
    { coordinates: [{ x: 60, y: 180 }] },
    { pointJson: [{ x: 60, y: 180 }] }
  ]) {
    const client = createClient(
      {
        errorId: 0,
        status: 'ready',
        solution: { type: 'click', objects: [true], top_k: [0], ...points }
      },
      []
    );
    assert.deepEqual(
      await new YesCaptchaClient(
        'client-key',
        client
      ).solveHcaptchaByScreenshot('screenshot', 'Select drinks'),
      [{ type: 'click', point: { x: 60, y: 180 } }]
    );
  }
});

test('keeps screenshot drag actions', async () => {
  const client = createClient(
    {
      errorId: 0,
      status: 'ready',
      solution: { type: 'drag', box: [{ start: [20, 40], end: [120, 160] }] }
    },
    []
  );
  assert.deepEqual(
    await new YesCaptchaClient('client-key', client).solveHcaptchaByScreenshot(
      'screenshot',
      'Move the object'
    ),
    [{ type: 'drag', start: { x: 20, y: 40 }, end: { x: 120, y: 160 } }]
  );
});

function createClient(
  response: unknown,
  requests: Array<{ url: string; body: unknown }>
): AxiosInstance {
  return {
    post: async (url: string, body: unknown) => {
      requests.push({ url, body });
      return { data: response };
    }
  } as unknown as AxiosInstance;
}
