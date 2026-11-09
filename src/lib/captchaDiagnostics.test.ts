import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { saveCaptchaDiagnostics } from './captchaDiagnostics';

test('captures HTML, screenshot, and coordinates for unknown captcha frames', async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'suno-captcha-diagnostics-'));
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.route('https://suno.com/create*', (route) => route.fulfill({
      contentType: 'text/html',
      body: `
      <!doctype html>
      <html>
        <body>
          <a href="/next?token=secret-handshake">Next</a>
          <script>window.handshake = 'secret-handshake'; window.mode = 'auto'</script>
          <iframe
            name="captcha-frame"
            title="Unknown captcha"
            style="width: 360px; height: 120px"
            srcdoc="<button id='verify-human'>Verify you are human</button>"
          ></iframe>
        </body>
      </html>
      `
    }));
    await page.goto('https://suno.com/create?__clerk_handshake=secret-handshake&lang=auto');

    const files = await saveCaptchaDiagnostics({
      page,
      userAgent: 'diagnostic-test',
      consoleMessages: [],
      networkEvents: [{
        timestamp: '2026-07-27T00:00:00.000Z',
        type: 'response',
        url: 'https://challenges.cloudflare.com/flow/test',
        status: 200,
        responseBody: '{"error":600010}'
      }],
      error: new Error('Timed out waiting for captcha token'),
      namePrefix: 'captcha-after-20s',
      reason: 'Captured 20 seconds after clicking Create',
      outputDirectory
    });
    const childFrame = files.frames.find((frame) => frame.name === 'captcha-frame');

    assert.ok(childFrame);
    assert.match(await readFile(childFrame.htmlPath, 'utf8'), /verify-human/);
    assert.ok(childFrame.screenshotPath);
    assert.ok((await stat(childFrame.screenshotPath)).size > 0);
    assert.equal(childFrame.element?.title, 'Unknown captcha');
    assert.ok(Number((childFrame.element?.rect as { width: number }).width) > 0);
    assert.ok((await stat(files.viewportScreenshotPath)).size > 0);
    assert.ok((await stat(files.screenshotPath)).size > 0);
    assert.match(path.basename(files.prefix), /^captcha-after-20s-/);
    const pageHtml = await readFile(files.htmlPath, 'utf8');
    assert.doesNotMatch(pageHtml, /secret-handshake/);
    assert.match(pageHtml, /window\.mode = 'auto'/);
    assert.match(pageHtml, /href="https:\/\/suno\.com\/next"/);

    const manifest = JSON.parse(await readFile(files.jsonPath, 'utf8')) as {
      url: string;
      reason: string;
      networkEvents: Array<{ responseBody?: string }>;
      frames: Array<{ name: string; htmlPath: string }>;
    };
    assert.equal(manifest.url, 'https://suno.com/create');
    assert.equal(manifest.reason, 'Captured 20 seconds after clicking Create');
    assert.equal(manifest.networkEvents[0].responseBody, '{"error":600010}');
    assert.ok(manifest.frames.some((frame) => frame.name === 'captcha-frame'));
  } finally {
    await browser.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
