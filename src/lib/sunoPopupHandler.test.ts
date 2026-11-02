import assert from 'node:assert/strict';
import test from 'node:test';
import { isPromoDialogText } from './sunoPopupHandler';

test('detects the Premier discount promo dialog copy', () => {
  assert.equal(isPromoDialogText("You've unlocked 20% off Premier annual."), true);
  assert.equal(isPromoDialogText('Save 30% off Premier annual'), true);
  assert.equal(isPromoDialogText('Unlock 20% off your first year'), true);
});

test('ignores regular create page copy and empty text', () => {
  assert.equal(isPromoDialogText('Warm dance song about pretending to be fine'), false);
  assert.equal(isPromoDialogText('Create song'), false);
  assert.equal(isPromoDialogText(''), false);
  assert.equal(isPromoDialogText(null), false);
  assert.equal(isPromoDialogText(undefined), false);
});
