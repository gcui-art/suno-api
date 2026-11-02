import assert from 'node:assert/strict';
import test from 'node:test';
import { isBlockingDialogText } from './sunoPopupHandler';

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

test('ignores regular create page copy and empty text', () => {
  assert.equal(isBlockingDialogText('Warm dance song about pretending to be fine'), false);
  assert.equal(isBlockingDialogText('Create song'), false);
  assert.equal(isBlockingDialogText(''), false);
  assert.equal(isBlockingDialogText(null), false);
  assert.equal(isBlockingDialogText(undefined), false);
});
