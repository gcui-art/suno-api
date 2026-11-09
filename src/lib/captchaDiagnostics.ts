import { ConsoleMessage, Frame, Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CaptchaNetworkEvent } from './sunoCaptchaNetworkLogging';
import {
  sanitizeDiagnosticUrl,
  SENSITIVE_DIAGNOSTIC_QUERY_PARAMETERS
} from './captchaDiagnosticSanitizer';

const DIAGNOSTIC_DIR = path.join(process.cwd(), 'logs', 'captcha-diagnostics');

export interface CaptchaDiagnosticFiles {
  prefix: string;
  viewportScreenshotPath: string;
  screenshotPath: string;
  htmlPath: string;
  jsonPath: string;
  frames: CaptchaFrameDiagnostic[];
}

export interface CaptchaFrameDiagnostic {
  index: number;
  name: string;
  url: string;
  parentUrl?: string;
  htmlPath: string;
  screenshotPath?: string;
  element?: Record<string, unknown>;
  error?: string;
}

interface CaptchaDiagnosticsInput {
  page: Page;
  userAgent: string;
  consoleMessages: string[];
  networkEvents?: CaptchaNetworkEvent[];
  error?: unknown;
  namePrefix?: string;
  outputDirectory?: string;
  reason?: string;
}

export function formatConsoleMessage(message: ConsoleMessage): string {
  const location = message.location();
  const source = location.url
    ? ` ${sanitizeDiagnosticUrl(location.url)}:${location.lineNumber}:${location.columnNumber}`
    : '';
  return `[${message.type()}]${source} ${message.text()}`;
}

export async function saveCaptchaDiagnostics(
  input: CaptchaDiagnosticsInput
): Promise<CaptchaDiagnosticFiles> {
  const outputDirectory = input.outputDirectory ?? DIAGNOSTIC_DIR;
  await mkdir(outputDirectory, { recursive: true });
  const prefix = path.join(outputDirectory, createDiagnosticName(input.namePrefix));
  const files: CaptchaDiagnosticFiles = {
    prefix,
    viewportScreenshotPath: `${prefix}.viewport.png`,
    screenshotPath: `${prefix}.png`,
    htmlPath: `${prefix}.html`,
    jsonPath: `${prefix}.json`,
    frames: []
  };
  await input.page.screenshot({ path: files.viewportScreenshotPath });
  await input.page.screenshot({ path: files.screenshotPath, fullPage: true });
  const fingerprint = await readBrowserFingerprint(input.page);
  const frames = await saveFrameDiagnostics(input.page, prefix);
  const pageHtml = await readSanitizedFrameContent(input.page.mainFrame());
  files.frames = frames;
  await Promise.all([
    writeFile(files.htmlPath, pageHtml, 'utf8'),
    writeFile(files.jsonPath, JSON.stringify({
      url: sanitizeDiagnosticUrl(input.page.url()),
      files: {
        viewportScreenshotPath: files.viewportScreenshotPath,
        screenshotPath: files.screenshotPath,
        htmlPath: files.htmlPath,
        jsonPath: files.jsonPath
      },
      userAgent: input.userAgent,
      reason: input.reason,
      error: serializeError(input.error),
      fingerprint,
      consoleMessages: input.consoleMessages,
      networkEvents: input.networkEvents ?? [],
      frames
    }, null, 2), 'utf8')
  ]);
  return files;
}

async function saveFrameDiagnostics(
  page: Page,
  prefix: string
): Promise<CaptchaFrameDiagnostic[]> {
  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  return Promise.all(frames.map((frame, index) => saveFrameDiagnostic(frame, index, prefix)));
}

async function saveFrameDiagnostic(
  frame: Frame,
  index: number,
  prefix: string
): Promise<CaptchaFrameDiagnostic> {
  const framePrefix = `${prefix}.frame-${String(index).padStart(2, '0')}`;
  const parentFrame = frame.parentFrame();
  const diagnostic: CaptchaFrameDiagnostic = {
    index,
    name: frame.name(),
    url: sanitizeDiagnosticUrl(frame.url()),
    parentUrl: parentFrame
      ? sanitizeDiagnosticUrl(parentFrame.url())
      : undefined,
    htmlPath: `${framePrefix}.html`
  };

  try {
    await writeFile(diagnostic.htmlPath, await readSanitizedFrameContent(frame), 'utf8');
    const frameElement = await frame.frameElement();
    diagnostic.element = await readFrameElement(frameElement);
    if (typeof diagnostic.element.src === 'string') {
      diagnostic.element.src = sanitizeDiagnosticUrl(diagnostic.element.src);
    }
    const screenshotPath = `${framePrefix}.png`;
    await frameElement.screenshot({ path: screenshotPath, timeout: 10_000 });
    diagnostic.screenshotPath = screenshotPath;
  } catch (error) {
    diagnostic.error = serializeErrorMessage(error);
  }

  return diagnostic;
}

async function readSanitizedFrameContent(frame: Frame): Promise<string> {
  return frame.evaluate((sensitiveParameterNames) => {
    const sourceUrl = new URL(window.location.href);
    const secrets = sensitiveParameterNames
      .flatMap((name) => sourceUrl.searchParams.getAll(name))
      .filter((value) => value.length > 0)
      .flatMap((value) => [value, encodeURIComponent(value)]);
    const clone = document.documentElement.cloneNode(true) as HTMLElement;

    for (const element of clone.querySelectorAll<HTMLElement>('[href], [src], [action], [formaction], [poster]')) {
      for (const attribute of ['href', 'src', 'action', 'formaction', 'poster']) {
        const value = element.getAttribute(attribute);
        if (!value) continue;
        try {
          const url = new URL(value, sourceUrl);
          if (url.protocol === 'http:' || url.protocol === 'https:') {
            element.setAttribute(attribute, `${url.origin}${url.pathname}`);
          }
        } catch {
          // Keep non-URL attribute values unchanged.
        }
      }
    }

    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (const secret of secrets) {
        node.nodeValue = node.nodeValue?.replaceAll(secret, '[redacted]') ?? null;
      }
    }

    const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>\n` : '';
    return `${doctype}${clone.outerHTML}`;
  }, [...SENSITIVE_DIAGNOSTIC_QUERY_PARAMETERS]);
}

async function readFrameElement(
  frameElement: Awaited<ReturnType<Frame['frameElement']>>
): Promise<Record<string, unknown>> {
  return frameElement.evaluate((element) => {
    if (!(element instanceof Element)) {
      throw new Error('Frame owner is not an Element');
    }
    const rect = element.getBoundingClientRect();
    return {
      tagName: element.tagName,
      id: element.id,
      className: element.getAttribute('class'),
      title: element.getAttribute('title'),
      name: element.getAttribute('name'),
      src: element.getAttribute('src'),
      ariaLabel: element.getAttribute('aria-label'),
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      }
    };
  });
}

function createDiagnosticName(prefix = 'captcha'): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function serializeError(error: unknown): Record<string, string> | undefined {
  if (!error) {
    return undefined;
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? ''
    };
  }
  return { message: String(error) };
}

function serializeErrorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function readBrowserFingerprint(page: Page): Promise<Record<string, unknown>> {
  const browserVersion = page.context().browser()?.version();
  const pageFingerprint = await page.evaluate(async () => {
    const navigatorWithHints = navigator as Navigator & {
      userAgentData?: {
        brands: Array<{ brand: string; version: string }>;
        mobile: boolean;
        platform: string;
        getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
      };
    };
    const userAgentData = navigatorWithHints.userAgentData;
    const highEntropyValues = await userAgentData?.getHighEntropyValues?.([
      'architecture',
      'bitness',
      'fullVersionList',
      'model',
      'platformVersion',
      'wow64'
    ]);
    const canvas = document.createElement('canvas');
    const webgl = canvas.getContext('webgl');
    const debugInfo = webgl?.getExtension('WEBGL_debug_renderer_info');

    return {
      userAgent: navigator.userAgent,
      userAgentData: userAgentData ? {
        brands: userAgentData.brands,
        mobile: userAgentData.mobile,
        platform: userAgentData.platform,
        highEntropyValues
      } : undefined,
      platform: navigator.platform,
      webdriver: navigator.webdriver,
      languages: navigator.languages,
      language: navigator.language,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: 'deviceMemory' in navigator ? navigator.deviceMemory : undefined,
      cookieEnabled: navigator.cookieEnabled,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      webgl: debugInfo && webgl ? {
        vendor: webgl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
        renderer: webgl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      } : undefined
    };
  });
  return { browserVersion, ...pageFingerprint };
}
