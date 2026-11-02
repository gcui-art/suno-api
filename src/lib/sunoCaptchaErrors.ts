export class SunoCaptchaManualInterventionError extends Error {
  public readonly statusCode = 409;
  public readonly code = 'SUNO_CAPTCHA_MANUAL_INTERVENTION';

  constructor(public readonly retryAfterSeconds?: number) {
    super(
      retryAfterSeconds
        ? `Suno requires manual captcha verification; retry after ${retryAfterSeconds} seconds or update the account cookie`
        : 'Suno requires manual captcha verification; update the account cookie and retry'
    );
    this.name = 'SunoCaptchaManualInterventionError';
  }
}
