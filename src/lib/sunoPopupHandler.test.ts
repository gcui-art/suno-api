import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { closeKnownPopups, isBlockingDialogText } from './sunoPopupHandler';

test('detects the Premier discount promo dialog copy', () => {
  assert.equal(isBlockingDialogText("You've unlocked 20% off Premier annual."), true);
  assert.equal(isBlockingDialogText('Save 30% off Premier annual'), true);
  assert.equal(isBlockingDialogText('Unlock 20% off your first year'), true);
});

test('detects the past-due billing dialog copy', () => {
  assert.equal(isBlockingDialogText('Update Billing'), true);
  assert.equal(
    isBlockingDialogText('We were unable to process your recent subscription renewal.'),
    true
  );
  assert.equal(
    isBlockingDialogText(
      'We were unable to process your recent subscription renewal. Please update your billing information or retry your payment to keep creating.'
    ),
    true
  );
});

test('detects the MIDI feature dialog copy', () => {
  assert.equal(isBlockingDialogText('NEW FEATURE Start your ideas with MIDI.'), true);
  assert.equal(isBlockingDialogText('Perform this MIDI as a lush classical string quartet'), true);
});

test('ignores regular create page copy and empty text', () => {
  assert.equal(isBlockingDialogText('Warm dance song about pretending to be fine'), false);
  assert.equal(isBlockingDialogText('Create song'), false);
  assert.equal(isBlockingDialogText(''), false);
  assert.equal(isBlockingDialogText(null), false);
  assert.equal(isBlockingDialogText(undefined), false);
});

test('closes the MIDI feature dialog before the cookie banner', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div data-base-ui-portal>
        <div role="dialog" aria-modal="true">
          <button aria-label="Close" onclick="this.closest('[data-base-ui-portal]').remove()">×</button>
          <p>NEW FEATURE</p>
          <p>Start your ideas with MIDI.</p>
        </div>
      </div>
      <button id="onetrust-reject-all-handler" onclick="this.remove()">Reject All</button>
    `);

    await closeKnownPopups(page);

    assert.equal(await page.locator('[data-base-ui-portal]').count(), 0);
    assert.equal(await page.locator('#onetrust-reject-all-handler').count(), 0);
  } finally {
    await browser.close();
  }
});
