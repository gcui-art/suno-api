import { FeishuNotifier } from '@/lib/feishuNotifier';
import axios from 'axios';
import { spawn } from 'node:child_process';
import path from 'node:path';

interface NotifyCaptchaFailureInput {
  error: unknown;
  feishuNotifier: FeishuNotifier;
  formatError: (error: unknown) => string;
  htmlPath?: string;
  jsonPath?: string;
  screenshotPath?: string;
  viewportScreenshotPath?: string;
  videoPath?: string;
}

export async function notifyCaptchaFailure(input: NotifyCaptchaFailureInput): Promise<void> {
  const text = [
    `Error: ${input.formatError(input.error)}`,
    input.viewportScreenshotPath ? `Viewport screenshot: ${input.viewportScreenshotPath}` : undefined,
    input.screenshotPath ? `Screenshot: ${input.screenshotPath}` : undefined,
    input.htmlPath ? `HTML: ${input.htmlPath}` : undefined,
    input.jsonPath ? `Diagnostics: ${input.jsonPath}` : undefined,
    input.videoPath ? `Recording: ${input.videoPath}` : undefined
  ].filter((line) => line !== undefined).join('\n');

  const tasks: Promise<void>[] = [];
  if (input.feishuNotifier.enabled) {
    tasks.push(input.feishuNotifier.notify({
      title: 'SunoCaptchaSolver requires manual verification',
      text,
      imagePath: input.viewportScreenshotPath
    }));
  }

  const smsWebhookUrl = process.env.SUNO_CAPTCHA_SMS_WEBHOOK_URL?.trim();
  if (smsWebhookUrl) {
    tasks.push(axios.post(smsWebhookUrl, {
      event: 'suno_captcha_manual_required',
      service: 'suno-api',
      to: process.env.SUNO_CAPTCHA_SMS_TO?.trim(),
      message: `Suno 需要人工完成验证码，请在网页端重新登录。${input.formatError(input.error)}`,
      timestamp: new Date().toISOString()
    }, { timeout: 10_000 }).then(() => undefined));
  } else if (isManualCaptchaFailure(input.error) && process.env.SUNO_CAPTCHA_SMS_TO?.trim()) {
    tasks.push(sendTencentCaptchaSms(
      process.env.SUNO_CAPTCHA_SMS_TO.trim(),
      process.env.SUNO_CAPTCHA_SMS_CODE?.trim() || '999999'
    ));
  }

  await Promise.all(tasks);
}

function isManualCaptchaFailure(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'SUNO_CAPTCHA_MANUAL_INTERVENTION'
  );
}

function sendTencentCaptchaSms(phone: string, code: string): Promise<void> {
  const python = process.env.SUNO_CAPTCHA_SMS_PYTHON?.trim() || '/root/Aunera/backend/.venv/bin/python';
  const script = path.join(process.cwd(), 'scripts', 'send-captcha-sms.py');
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, phone, code], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env
    });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Tencent captcha SMS timed out'));
    }, 20_000);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk).slice(0, 500);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timeout);
      if (status === 0) return resolve();
      reject(new Error(`Tencent captcha SMS failed (exit ${status}): ${stderr.trim()}`));
    });
  });
}
