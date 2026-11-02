import type {
  CaptchaBrowserIdentity,
  SunoGenerateClip,
  SunoGeneratePayload
} from '@/lib/sunoCaptchaGenerateCapture';
import { SunoCaptchaCapacityError, SunoCaptchaSolver } from '@/lib/sunoCaptchaSolver';

export interface ServerCaptchaRecoveryResult {
  clips: SunoGenerateClip[];
  cookies: Record<string, string>;
  browserIdentity: CaptchaBrowserIdentity;
}

/**
 * 用服务器自己的浏览器 + YesCaptcha 完成一次生成，绕开 Suno 的 API 验证码。
 * 返回结果里带最新 cookies，调用方应写回账号，后续 API 请求才能继续。
 */
export async function generateWithServerCaptchaSolver(options: {
  accountId: string;
  cookies: Record<string, string | undefined>;
  currentToken?: string;
  payload: SunoGeneratePayload;
  signal?: AbortSignal;
}): Promise<ServerCaptchaRecoveryResult> {
  options.signal?.throwIfAborted();

  const solver = new SunoCaptchaSolver({
    cookies: options.cookies,
    currentToken: options.currentToken
  });

  try {
    const result = await solver.generate(options.payload);
    return {
      clips: result.clips,
      cookies: result.cookies,
      browserIdentity: result.browserIdentity
    };
  } catch (error) {
    if (error instanceof SunoCaptchaCapacityError) {
      throw Object.assign(error, { code: 'SUNO_BROWSER_RECOVERY_CAPACITY' });
    }
    throw error;
  }
}
