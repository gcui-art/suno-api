export class SunoCaptchaManualInterventionError extends Error {
  public readonly statusCode = 409;
  public readonly code = 'SUNO_CAPTCHA_MANUAL_INTERVENTION';

  constructor() {
    super('Suno requires manual captcha verification; update the account cookie and retry');
    this.name = 'SunoCaptchaManualInterventionError';
  }
}
