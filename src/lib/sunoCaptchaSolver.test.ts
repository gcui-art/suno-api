import assert from 'node:assert/strict';
import test from 'node:test';
import { AxiosInstance } from 'axios';
import { chromium } from 'playwright';
import { SunoCaptchaSolver } from './sunoCaptchaSolver';
import { YesCaptchaClient } from './yesCaptchaClient';

const reportedResponse = {
  status: 'ready',
  taskId: '01a1a8fd-9bbb-750f-8342-8a6f1b235c52',
  errorId: 0,
  solution: {
    box: ['60', '60', '300', '180', '60', '300'],
    type: 'click',
    top_k: [0, 5, 6],
    clicks: [
      { x: 60, y: 60 },
      { x: 300, y: 180 },
      { x: 60, y: 300 }
    ],
    objects: [true, false, false, false, false, true, true, false, false],
    question: 'Tap on every drink that can be hot or cold',
    confidences: [1, 0, 0, 0, 0, 1, 1, 0, 0]
  },
  errorCode: ''
};

test('clicks tiles 1, 6 and 7 for the reported YesCaptcha response inside an offset iframe', async () => {
  const client = {
    post: async () => ({ data: reportedResponse })
  } as unknown as AxiosInstance;
  const actions = await new YesCaptchaClient(
    'client-key',
    client
  ).solveHcaptchaByImages(
    Array.from({ length: 9 }, (_, index) => `image-${index}`),
    'Tap on every drink that can be hot or cold'
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 }
    });
    await page.setContent(`
      <iframe title="hCaptcha" style="position:absolute;left:441px;top:101px;width:400px;height:600px;border:0"></iframe>
    `);
    const iframe = await page.locator('iframe').elementHandle();
    assert.ok(iframe);
    const frame = await iframe.contentFrame();
    assert.ok(frame);
    await frame.setContent(`
      <style>
        body { margin: 10px; }
        .challenge-container { width: 380px; }
        .prompt-text { height: 120px; }
        .tiles { display: grid; grid-template-columns: repeat(3, 120px); gap: 10px; }
        .task-image { width: 120px; height: 120px; }
      </style>
      <div class="challenge-container">
        <div class="prompt-text">Tap on every drink that can be hot or cold</div>
        <div class="tiles">${Array.from(
          { length: 9 },
          (_, index) =>
            `<button class="task-image" data-index="${index}">${index + 1}</button>`
        ).join('')}</div>
      </div>
      <script>
        document.querySelector('.challenge-container').addEventListener('click', (event) => {
          event.target.dataset.clicked = 'true';
        });
      </script>
    `);
    const challenge = frame.locator('.challenge-container');
    assert.deepEqual(await challenge.boundingBox(), {
      x: 451,
      y: 111,
      width: 380,
      height: 500
    });
    // Exercise the production click executor without starting a Suno session.
    const solver = Object.create(
      SunoCaptchaSolver.prototype
    ) as SunoCaptchaSolver;
    await solver['performActions'](challenge, actions);
    assert.deepEqual(
      await challenge
        .locator('.task-image[data-clicked="true"]')
        .evaluateAll((tiles) =>
          tiles.map((tile) => Number(tile.getAttribute('data-index')))
        ),
      [0, 5, 6]
    );
    assert.equal(
      await challenge.locator('.prompt-text').getAttribute('data-clicked'),
      null
    );
  } finally {
    await browser.close();
  }
});

test('switches an Advanced create page back to Simple before captcha input', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="tablist">
        <button role="tab" aria-selected="false">Simple</button>
        <button role="tab" aria-selected="true">Advanced</button>
      </div>
      <script>
        for (const tab of document.querySelectorAll('[role="tab"]')) {
          tab.addEventListener('click', () => {
            for (const other of document.querySelectorAll('[role="tab"]')) {
              other.setAttribute('aria-selected', String(other === tab));
            }
          });
        }
      </script>
    `);
    const solver = Object.create(
      SunoCaptchaSolver.prototype
    ) as SunoCaptchaSolver;
    await solver['ensureSimpleMode'](page);
    assert.equal(
      await page
        .getByRole('tab', { name: 'Simple' })
        .getAttribute('aria-selected'),
      'true'
    );
    assert.equal(
      await page
        .getByRole('tab', { name: 'Advanced' })
        .getAttribute('aria-selected'),
      'false'
    );
  } finally {
    await browser.close();
  }
});
