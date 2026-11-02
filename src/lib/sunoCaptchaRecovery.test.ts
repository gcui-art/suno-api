import assert from 'node:assert/strict';
import test from 'node:test';
import { SunoCaptchaManualInterventionError } from './sunoCaptchaErrors';
import { isSunoCaptchaRejection, submitWithCaptchaRecovery } from './sunoCaptchaRecovery';

const rejected = (status = 403, detail = 'Captcha verification failed') => ({ response: { status, data: { detail } } });

test('normal submissions use the prechecked token without browser work', async () => {
  const result = await submitWithCaptchaRecovery({
    precheck: async () => 'precheck-token',
    submit: async (token) => { assert.equal(token, 'precheck-token'); return ['original']; },
    recover: async () => { assert.fail('unexpected recovery'); },
    manualRequired: async () => { throw new Error('unexpected notification'); }
  });
  assert.deepEqual(result, ['original']);
});

test('precheck captcha waits for recovery and retries before returning only original clips', async () => {
  const events: string[] = [];
  let checks = 0;
  const result = await submitWithCaptchaRecovery({
    precheck: async () => { events.push('check'); return checks++ === 0 ? undefined : null; },
    submit: async (token) => { events.push('submit'); assert.equal(token, null); return ['original']; },
    recover: async () => { events.push('browser'); },
    manualRequired: async () => { throw new Error('unexpected notification'); }
  });
  assert.deepEqual(events, ['check', 'browser', 'check', 'submit']);
  assert.deepEqual(result, ['original']);
});

test('explicit rejection after a successful precheck gets just one original-request replay', async () => {
  let submissions = 0;
  let recoveries = 0;
  const result = await submitWithCaptchaRecovery({
    precheck: async () => null,
    submit: async () => { if (++submissions === 1) throw rejected(); return ['original']; },
    recover: async () => { recoveries++; },
    manualRequired: async () => { throw new Error('unexpected notification'); }
  });
  assert.deepEqual(result, ['original']);
  assert.equal(submissions, 2);
  assert.equal(recoveries, 1);
});

test('persistent captcha triggers one recovery and one manual notification', async () => {
  let recoveries = 0;
  let alerts = 0;
  await assert.rejects(submitWithCaptchaRecovery({
    precheck: async () => undefined,
    submit: async () => { assert.fail('blocked request submitted'); },
    recover: async () => { recoveries++; },
    manualRequired: async () => { alerts++; return new SunoCaptchaManualInterventionError(1800); }
  }), SunoCaptchaManualInterventionError);
  assert.equal(recoveries, 1);
  assert.equal(alerts, 1);
});

test('browser failure returns manual intervention without submitting the original request', async () => {
  const failure = new Error('browser timeout');
  await assert.rejects(submitWithCaptchaRecovery({
    precheck: async () => undefined,
    submit: async () => { assert.fail('blocked request submitted'); },
    recover: async () => { throw failure; },
    manualRequired: async (cause) => { assert.equal(cause, failure); return new SunoCaptchaManualInterventionError(); }
  }), SunoCaptchaManualInterventionError);
});

test('timeouts, rate limits, authentication and ambiguous failures never replay a POST', async () => {
  for (const failure of [new Error('timeout'), rejected(429), rejected(500), rejected(401), rejected(403, 'Forbidden')]) {
    let submissions = 0;
    await assert.rejects(submitWithCaptchaRecovery({
      precheck: async () => null,
      submit: async () => { submissions++; throw failure; },
      recover: async () => { assert.fail('unsafe replay'); },
      manualRequired: async () => { throw new Error('unexpected notification'); }
    }), (error) => error === failure);
    assert.equal(submissions, 1);
  }
});

test('repeated generate captcha rejection does not start a second browser', async () => {
  let submissions = 0;
  let recoveries = 0;
  await assert.rejects(submitWithCaptchaRecovery({
    precheck: async () => null,
    submit: async () => { submissions++; throw rejected(); },
    recover: async () => { recoveries++; },
    manualRequired: async () => new SunoCaptchaManualInterventionError()
  }), SunoCaptchaManualInterventionError);
  assert.equal(submissions, 2);
  assert.equal(recoveries, 1);
});

test('recovery can be disabled and structured captcha codes are recognized', async () => {
  assert.equal(isSunoCaptchaRejection({ response: { status: 400, data: { code: 'CAPTCHA_REQUIRED' } } }), true);
  await assert.rejects(submitWithCaptchaRecovery({
    enabled: false,
    precheck: async () => undefined,
    submit: async () => { assert.fail('blocked request submitted'); },
    recover: async () => { assert.fail('disabled browser'); },
    manualRequired: async () => new SunoCaptchaManualInterventionError()
  }), SunoCaptchaManualInterventionError);
});

test('browser capacity does not block the account or send a manual captcha alert', async () => {
  const capacity = Object.assign(new Error('busy'), { code: 'SUNO_BROWSER_RECOVERY_CAPACITY' });
  await assert.rejects(submitWithCaptchaRecovery({
    precheck: async () => undefined,
    submit: async () => { assert.fail('blocked request submitted'); },
    recover: async () => { throw capacity; },
    manualRequired: async () => { throw new Error('capacity must not send a captcha alert'); }
  }), (error) => error === capacity);
});

test('local recovery expiration or task cancellation does not impose another account cooldown', async () => {
  for (const code of ['SUNO_LOCAL_RECOVERY_REQUIRED', 'SUNO_GENERATION_TIMEOUT']) {
    const failure = Object.assign(new Error(code), { code });
    await assert.rejects(submitWithCaptchaRecovery({
      precheck: async () => undefined,
      submit: async () => { assert.fail('expired request submitted'); },
      recover: async () => { throw failure; },
      manualRequired: async () => { throw new Error('expired event must not block the account'); }
    }), (error) => error === failure);
  }
});

test('server browser fallback handles a precheck captcha without local recovery', async () => {
  const events: string[] = [];
  const result = await submitWithCaptchaRecovery({
    precheck: async () => { events.push('check'); return undefined; },
    submit: async () => { assert.fail('captcha precheck must not submit API request'); },
    recover: async () => { assert.fail('server fallback must not wait for local recovery'); },
    fallback: async () => { events.push('server-browser'); return ['browser']; },
    manualRequired: async () => { throw new Error('unexpected notification'); }
  });
  assert.deepEqual(events, ['check', 'server-browser']);
  assert.deepEqual(result, ['browser']);
});

test('server browser fallback handles an explicit captcha rejection once', async () => {
  let submissions = 0;
  let fallbacks = 0;
  const result = await submitWithCaptchaRecovery({
    precheck: async () => null,
    submit: async () => { submissions++; throw rejected(); },
    recover: async () => { assert.fail('server fallback must not start local recovery'); },
    fallback: async () => { fallbacks++; return ['browser']; },
    manualRequired: async () => { throw new Error('unexpected notification'); }
  });
  assert.equal(submissions, 1);
  assert.equal(fallbacks, 1);
  assert.deepEqual(result, ['browser']);
});

test('failed server browser triggers local recovery then retries the original once', async () => {
  const events: string[] = [];
  let submits = 0;
  const result = await submitWithCaptchaRecovery({
    precheck: async () => null,
    submit: async () => { events.push('api'); if (++submits === 1) throw rejected(); return ['original']; },
    fallback: async () => { events.push('server'); throw Object.assign(new Error('challenge'), { browserReplaySafe: true }); },
    recover: async () => { events.push('local'); },
    manualRequired: async () => { assert.fail('unexpected terminal alert'); }
  });
  assert.deepEqual(events, ['api', 'server', 'local', 'api']);
  assert.deepEqual(result, ['original']);
});

test('unknown server submission triggers local recovery but never replays the original', async () => {
  let submits = 0, locals = 0;
  const failure = new Error('response lost');
  await assert.rejects(submitWithCaptchaRecovery({
    precheck: async () => null,
    submit: async () => { submits++; throw rejected(); },
    fallback: async () => { throw failure; },
    recover: async () => { locals++; },
    manualRequired: async () => new SunoCaptchaManualInterventionError()
  }), e => e === failure);
  assert.equal(submits, 1);
  assert.equal(locals, 1);
});

test('all three stages remain bounded when captcha persists', async () => {
  let locals = 0, servers = 0;
  await assert.rejects(submitWithCaptchaRecovery({
    precheck: async () => undefined,
    submit: async () => { assert.fail('blocked'); },
    fallback: async () => { servers++; throw Object.assign(new Error('challenge'), { browserReplaySafe: true }); },
    recover: async () => { locals++; },
    manualRequired: async () => new SunoCaptchaManualInterventionError()
  }), SunoCaptchaManualInterventionError);
  assert.equal(locals, 1);
  assert.equal(servers, 2);
});
