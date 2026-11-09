import { Locator, Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SNAPSHOT_DIR = path.join(process.cwd(), 'logs', 'captcha-challenges');

interface CaptchaChallengeSnapshotInput {
  page: Page;
  challenge: Locator;
  prompt?: string;
  logger: {
    info(message: string): void;
  };
}

export async function saveCaptchaChallengeSnapshot(
  input: CaptchaChallengeSnapshotInput
): Promise<void> {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  const prefix = path.join(SNAPSHOT_DIR, createSnapshotName());
  const frameSnapshot = await readFrameSnapshot(input.challenge);
  const files = {
    pageScreenshotPath: `${prefix}.page.png`,
    challengeScreenshotPath: `${prefix}.challenge.png`,
    pageHtmlPath: `${prefix}.page.html`,
    frameHtmlPath: `${prefix}.frame.html`,
    challengeHtmlPath: `${prefix}.challenge.html`,
    jsonPath: `${prefix}.json`
  };

  await Promise.all([
    input.page.screenshot({ path: files.pageScreenshotPath, fullPage: true }),
    input.challenge.screenshot({ path: files.challengeScreenshotPath, timeout: 10_000 }),
    writeFile(files.pageHtmlPath, await input.page.content(), 'utf8'),
    writeFile(files.frameHtmlPath, frameSnapshot.frameHtml, 'utf8'),
    writeFile(files.challengeHtmlPath, frameSnapshot.challengeHtml, 'utf8'),
    writeFile(files.jsonPath, JSON.stringify({
      url: input.page.url(),
      prompt: input.prompt,
      files,
      challengeBox: await input.challenge.boundingBox(),
      elements: frameSnapshot.elements
    }, null, 2), 'utf8')
  ]);

  input.logger.info(`SunoCaptchaSolver: saved hCaptcha challenge snapshot to ${prefix}.*`);
}

function createSnapshotName(): string {
  return `hcaptcha-challenge-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

async function readFrameSnapshot(challenge: Locator): Promise<{
  frameHtml: string;
  challengeHtml: string;
  elements: Array<Record<string, unknown>>;
}> {
  return challenge.evaluate((element) => {
    const doc = element.ownerDocument;
    const selectors = [
      '.challenge-container',
      '.task-image',
      'img',
      'canvas',
      'svg',
      '[style*="background-image"]'
    ].join(',');
    const elements = Array.from(doc.querySelectorAll(selectors))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return {
          tagName: node.tagName,
          className: node.getAttribute('class'),
          id: node.id,
          role: node.getAttribute('role'),
          ariaLabel: node.getAttribute('aria-label'),
          src: node instanceof HTMLImageElement ? node.src : undefined,
          backgroundImage: style.backgroundImage,
          text: node.textContent,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          }
        };
      });

    return {
      frameHtml: doc.documentElement.outerHTML,
      challengeHtml: element.outerHTML,
      elements
    };
  });
}
