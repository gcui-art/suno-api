export class SunoCaptchaManualInterventionError extends Error {
  public readonly statusCode = 409;
  public readonly code = 'SUNO_CAPTCHA_MANUAL_INTERVENTION';

  constructor(cause?: unknown) {
    const reason = cause instanceof Error ? cause.message : undefined;
    super(
      'Suno requires manual captcha verification; update the account cookie and retry' +
        (reason ? `; recovery failed: ${reason}` : ''),
      { cause }
    );
    this.name = 'SunoCaptchaManualInterventionError';
  }
}
