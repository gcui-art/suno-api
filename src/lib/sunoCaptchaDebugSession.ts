import { Browser, BrowserContext, Page } from 'playwright';
import { CaptchaDiagnosticFiles, formatConsoleMessage, saveCaptchaDiagnostics } from './captchaDiagnostics';
import { FeishuNotifier } from './feishuNotifier';
import { notifyCaptchaFailure } from './sunoCaptchaFailureNotifier';
import { attachCaptchaNetworkLogging, CaptchaNetworkEvent } from './sunoCaptchaNetworkLogging';

interface CaptchaDebugLogger {
  info(message: string): void;
  warn(message: string): void;
}

export class SunoCaptchaDebugSession {
  private readonly consoleMessages: string[] = [];
  private readonly networkEvents: CaptchaNetworkEvent[] = [];
  private readonly feishuNotifier = new FeishuNotifier();

  constructor(
    private readonly userAgent: string,
    private readonly logger: CaptchaDebugLogger
  ) {}

  public attach(context: BrowserContext, page: Page, generateUrlPart: string): void {
    attachCaptchaNetworkLogging(context, generateUrlPart, this.logger, this.networkEvents);
    page.on('console', (message) => {
      const formatted = formatConsoleMessage(message);
      this.consoleMessages.push(formatted);
      if (message.type() === 'error' || message.type() === 'warning') {
        this.logger.warn(`SunoCaptchaSolver browser console: ${formatted}`);
      }
    });
    page.on('pageerror', (error) => {
      const formatted = `[pageerror] ${formatError(error)}`;
      this.consoleMessages.push(formatted);
      this.logger.warn(`SunoCaptchaSolver browser error: ${formatted}`);
    });
  }

  public async save(
    page: Page,
    error: unknown,
    namePrefix: string
  ): Promise<CaptchaDiagnosticFiles | undefined> {
    try {
      const files = await saveCaptchaDiagnostics({
        page,
        userAgent: this.userAgent,
        consoleMessages: this.consoleMessages,
        networkEvents: this.networkEvents,
        error,
        namePrefix,
        reason: diagnosticReason(namePrefix)
      });
      this.logger.warn(`SunoCaptchaSolver: saved browser diagnostics to ${files.prefix}.*`);
      return files;
    } catch (diagnosticError) {
      this.logger.warn(`SunoCaptchaSolver: failed to save diagnostics: ${formatError(diagnosticError)}`);
      return undefined;
    }
  }

  public async closeBrowserWithVideoLog(page: Page, browser: Browser): Promise<string | undefined> {
    const video = page.video();
    await browser.close();
    if (!video) {
      this.logger.warn('SunoCaptchaSolver: captcha recording unavailable');
      return undefined;
    }

    try {
      const videoPath = await video.path();
      this.logger.warn(`SunoCaptchaSolver: captcha recording saved to ${videoPath}`);
      return videoPath;
    } catch (error) {
      this.logger.warn(`SunoCaptchaSolver: failed to read captcha recording path: ${formatError(error)}`);
      return undefined;
    }
  }

  public async notifyFailure(
    files: CaptchaDiagnosticFiles | undefined,
    error: unknown,
    videoPath?: string
  ): Promise<void> {
    try {
      await notifyCaptchaFailure({
        error,
        feishuNotifier: this.feishuNotifier,
        formatError,
        htmlPath: files?.htmlPath,
        jsonPath: files?.jsonPath,
        screenshotPath: files?.screenshotPath,
        viewportScreenshotPath: files?.viewportScreenshotPath,
        videoPath
      });
      this.logger.info('SunoCaptchaSolver: sent manual captcha notification');
    } catch (notifyError) {
      this.logger.warn(`SunoCaptchaSolver: failed to notify Feishu: ${formatError(notifyError)}`);
    }
  }
}

function diagnosticReason(namePrefix: string): string | undefined {
  if (namePrefix === 'captcha-after-20s') return 'Captured 20 seconds after clicking Create';
  if (namePrefix === 'captcha-failure') return 'Captured when captcha solving failed';
  if (namePrefix === 'captcha-success') return 'Captured after captcha token acquisition';
  return undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
