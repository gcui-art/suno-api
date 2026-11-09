import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { AxiosError, AxiosHeaders, type AxiosInstance } from 'axios';
import { SunoApi } from './SunoApi';
import { FeishuNotifier, type FeishuNotification } from './feishuNotifier';
import { SunoCaptchaManualInterventionError } from './sunoCaptchaErrors';
import type { SunoGeneratePayload } from './sunoCaptchaGenerateCapture';
import { SunoCaptchaSolver } from './sunoCaptchaSolver';

const coverPayload = {
  generation_type: 'TEXT',
  task: 'cover',
  cover_clip_id: 'original-clip',
  cover_start_s: 0,
  cover_end_s: 120,
  persona_id: 'original-persona',
  artist_clip_id: 'original-artist-clip',
  prompt: 'original lyrics',
  tags: 'original style',
  mv: 'chirp-hawk',
  metadata: { create_mode: 'custom' },
  transaction_uuid: 'original-transaction'
};

function fixture(t: TestContext) {
  const settings: Record<string, string | undefined> = {
    SUNO_SERVER_BROWSER_FALLBACK: 'true',
    SUNO_SERVER_BROWSER_SOLVER: 'true',
    SUNO_LOCAL_RECOVERY_FALLBACK: 'false',
    SUNO_CAPTCHA_AUTO_RECOVER: 'true',
    SUNO_SKIP_BROWSER_FALLBACK_ON_PRECHECK: 'true',
    SUNO_GENERATION_TRANSPORT: 'api',
    SUNO_GENERATION_MIN_INTERVAL_MS: '1',
    SUNO_API_SUBMIT_JITTER_MS: '0',
    YESCAPTCHA_KEY: 'test-key',
    FEISHU_BOT_WEBHOOK: 'https://example.invalid/test-webhook',
    SUNO_CAPTCHA_SMS_WEBHOOK_URL: undefined,
    SUNO_CAPTCHA_SMS_TO: undefined
  };
  for (const [key, value] of Object.entries(settings)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }

  const api = new SunoApi('', randomUUID());
  t.mock.method(api, 'keepAlive', async () => undefined);
  const internal = api as unknown as {
    client: AxiosInstance;
    adoptBrowserResult(): Promise<void>;
    submitGenerateRequest(payload: SunoGeneratePayload): Promise<unknown>;
  };
  const adopted = t.mock.method(
    internal,
    'adoptBrowserResult',
    async () => undefined
  );
  internal.client.defaults.adapter = async (config) => {
    assert.ok(
      config.url?.endsWith('/api/c/check'),
      'no direct generation after captcha precheck'
    );
    return {
      config,
      data: { required: true },
      status: 200,
      statusText: 'OK',
      headers: new AxiosHeaders()
    };
  };
  const notifications: FeishuNotification[] = [];
  t.mock.method(
    FeishuNotifier.prototype,
    'notify',
    async (notification: FeishuNotification) => {
      notifications.push(notification);
    }
  );
  const clips = [{ id: 'recovered-clip' }];
  const solver = t.mock.method(
    SunoCaptchaSolver.prototype,
    'generate',
    async () => ({
      clips,
      cookies: {},
      browserIdentity: { userAgent: 'test-browser' }
    })
  );
  return { internal, solver, adopted, notifications, clips };
}

test('captcha solver receives complete payloads independently of website form limits', async (t) => {
  const cases = [
    { name: 'cover with persona', payload: coverPayload },
    {
      name: 'continuation',
      payload: {
        task: 'extend',
        continue_clip_id: 'original-clip',
        continue_at: 40,
        prompt: 'continuation'
      }
    },
    {
      name: 'custom model and fields beyond website form limits',
      payload: {
        generation_type: 'TEXT',
        mv: 'chirp-crow',
        prompt: 'a'.repeat(5_001),
        tags: 'b'.repeat(1_001),
        user_uploaded_images_b64: ['complete-image-data'],
        metadata: { create_mode: 'custom' }
      }
    }
  ];
  for (const { name, payload } of cases) {
    await t.test(name, async (t) => {
      const { internal, solver, adopted, notifications, clips } = fixture(t);
      const original = structuredClone(payload);
      assert.deepEqual(await internal.submitGenerateRequest(payload), clips);
      assert.equal(solver.mock.callCount(), 1);
      assert.deepEqual(solver.mock.calls[0].arguments, [original]);
      assert.deepEqual(payload, original);
      assert.equal(adopted.mock.callCount(), 1);
      assert.deepEqual(notifications, []);
    });
  }
});

test('cover rejected by the generation API uses the solver without replaying the API POST', async (t) => {
  const { internal, solver, clips } = fixture(t);
  let submissions = 0;
  internal.client.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/api/c/check')) {
      return {
        config,
        data: { required: false },
        status: 200,
        statusText: 'OK',
        headers: new AxiosHeaders()
      };
    }
    submissions++;
    throw new AxiosError(
      'Captcha verification required',
      'ERR_BAD_REQUEST',
      config,
      undefined,
      {
        config,
        status: 403,
        statusText: 'Forbidden',
        data: { detail: 'Captcha verification required' },
        headers: new AxiosHeaders()
      }
    );
  };
  assert.deepEqual(await internal.submitGenerateRequest(coverPayload), clips);
  assert.equal(submissions, 1);
  assert.equal(solver.mock.callCount(), 1);
  assert.deepEqual(solver.mock.calls[0].arguments, [coverPayload]);
});

test('disabling the solver retains website restrictions, and disabling fallback prevents solver use', async (t) => {
  for (const setting of [
    'SUNO_SERVER_BROWSER_SOLVER',
    'SUNO_SERVER_BROWSER_FALLBACK'
  ]) {
    await t.test(setting, async (t) => {
      const { internal, solver } = fixture(t);
      process.env[setting] = 'false';
      await assert.rejects(
        internal.submitGenerateRequest(coverPayload),
        SunoCaptchaManualInterventionError
      );
      assert.equal(solver.mock.callCount(), 0);
    });
  }
});

test('solver failure remains visible in the returned error and notification when local recovery is disabled', async (t) => {
  const { internal, solver, notifications } = fixture(t);
  const failure = new Error(
    'Timed out waiting for Suno browser generate response'
  );
  solver.mock.mockImplementation(async () => {
    throw failure;
  });
  await assert.rejects(
    internal.submitGenerateRequest(coverPayload),
    (error: unknown) => {
      assert.ok(error instanceof SunoCaptchaManualInterventionError);
      assert.equal(error.cause, failure);
      assert.ok(error.message.includes(failure.message));
      assert.ok(!error.message.includes('Local browser recovery is disabled'));
      return true;
    }
  );
  assert.equal(solver.mock.callCount(), 1);
  assert.equal(notifications.length, 1);
  assert.ok(notifications[0].text.includes(failure.message));
});
