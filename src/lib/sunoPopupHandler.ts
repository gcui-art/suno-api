import pino from 'pino';
import { Locator, Page } from 'playwright';

const logger = pino();

/**
 * Suno 的营销/账单弹窗由 base-ui 渲染成全屏 portal：
 * `<div data-base-ui-portal class="z-[1000] fixed top-0 left-0">`。
 * 它会拦截页面上所有点击，导致 textarea / 按钮的 click 一直重试直到超时。
 *
 * 已知文案：
 * - 促销："You've unlocked 20% off Premier annual."
 * - 账单："Update Billing / We were unable to process your recent subscription renewal."
 * - 新功能："Start your ideas with MIDI."
 */
export const BLOCKING_DIALOG_TEXT_RE = new RegExp(
  [
    '\\d{1,3}\\s*%\\s*off',
    'off\\s+premier',
    'premier\\s+annual',
    'unlock(?:ed)?\\s+\\d{1,3}\\s*%?\\s*off',
    'update\\s+billing',
    'unable\\s+to\\s+process\\s+your\\s+recent\\s+subscription',
    'retry\\s+payment',
    'update\\s+your\\s+payment\\s+method',
    'start\\s+your\\s+ideas\\s+with\\s+midi',
    'perform\\s+this\\s+midi',
    'new\\s+feature',
  ].join('|'),
  'i'
);

const BLOCKING_DIALOG_SELECTOR = [
  '[data-base-ui-portal] [role="dialog"]',
  '[data-base-ui-portal] [role="alertdialog"]',
  '[role="dialog"][aria-modal="true"]',
].join(', ');

const COOKIE_BANNER_SELECTORS = [
  '#onetrust-reject-all-handler',
  '#onetrust-accept-btn-handler',
  '#onetrust-close-btn-container button',
];

export function isBlockingDialogText(text: string | null | undefined): boolean {
  return Boolean(text && BLOCKING_DIALOG_TEXT_RE.test(text));
}

async function isVisible(locator: Locator): Promise<boolean> {
  return locator.isVisible({ timeout: 300 }).catch(() => false);
}

async function waitUntilHidden(page: Page, locator: Locator, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isVisible(locator))) return true;
    await page.waitForTimeout(150);
  }
  return !(await isVisible(locator));
}

export async function closeKnownPopups(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handled = await dismissBlockingDialog(page);

    for (const selector of COOKIE_BANNER_SELECTORS) {
      const button = page.locator(selector).first();
      if (!(await isVisible(button))) continue;

      const clicked = await button.click({ timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      if (!clicked) continue;

      await page.waitForTimeout(300);
      handled = true;
      break;
    }

    if (!handled) return;
  }
}

async function findPromoDialog(page: Page): Promise<Locator | undefined> {
  const dialogs = page.locator(BLOCKING_DIALOG_SELECTOR).filter({ hasText: BLOCKING_DIALOG_TEXT_RE });
  const dialogCount = await dialogs.count().catch(() => 0);
  for (let index = 0; index < dialogCount; index += 1) {
    const dialog = dialogs.nth(index);
    if (await isVisible(dialog)) return dialog;
  }

  // 弹窗的遮罩层是 portal 的兄弟节点，role=dialog 未必命中，这里退回到整个 portal。
  const portals = page.locator('[data-base-ui-portal]').filter({ hasText: BLOCKING_DIALOG_TEXT_RE });
  const portalCount = await portals.count().catch(() => 0);
  for (let index = 0; index < portalCount; index += 1) {
    const portal = portals.nth(index);
    if (await isVisible(portal)) return portal;
  }
  return undefined;
}

/**
 * 关掉营销弹窗：Esc → 关闭按钮 → 直接摘掉 portal 并恢复 body 的交互样式。
 * 返回是否已经不再拦截页面。
 */
export async function dismissBlockingDialog(page: Page): Promise<boolean> {
  const dialog = await findPromoDialog(page);
  if (!dialog) return false;

  await page.keyboard.press('Escape').catch(() => {});
  if (await waitUntilHidden(page, dialog, 1_500)) {
    logger.info('SunoPopupHandler: closed blocking dialog with Escape');
    return true;
  }

  const closeButtons = [
    dialog.locator('button[aria-label*="close" i]'),
    dialog.locator('button[aria-label*="dismiss" i]'),
    dialog.getByRole('button', { name: /^(?:close|dismiss|no thanks|not now|maybe later|skip)$/i }),
    page.locator('[data-base-ui-portal] button[aria-label*="close" i]'),
  ];

  for (const button of closeButtons) {
    const target = button.first();
    if (!(await isVisible(target))) continue;

    const clicked = await target.click({ timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) continue;
    if (!(await waitUntilHidden(page, dialog, 1_500))) continue;

    logger.info('SunoPopupHandler: closed blocking dialog with close button');
    return true;
  }

  const removed = await removeBlockingPortals(page);
  return removed > 0;
}

/** 直接移除包含营销文案的 portal，并清掉 base-ui 加在 body 上的 pointer-events / inert 锁。 */
export async function removeBlockingPortals(page: Page): Promise<number> {
  const removed = await page.evaluate((pattern) => {
    const patternRe = new RegExp(pattern, 'i');
    let count = 0;

    document.querySelectorAll('[data-base-ui-portal]').forEach((portal) => {
      if (!patternRe.test(portal.textContent ?? '')) return;
      portal.remove();
      count += 1;
    });

    if (count === 0) return 0;

    document.body.style.pointerEvents = '';
    document.documentElement.style.pointerEvents = '';
    document.body.style.removeProperty('overflow');
    document.querySelectorAll('[data-base-ui-inert]').forEach((element) => {
      element.removeAttribute('data-base-ui-inert');
    });
    document.querySelectorAll('[inert]').forEach((element) => {
      element.removeAttribute('inert');
    });
    return count;
  }, BLOCKING_DIALOG_TEXT_RE.source).catch(() => 0);

  if (removed > 0) {
    logger.warn(`SunoPopupHandler: force-removed ${removed} blocking portal(s)`);
  }
  return removed;
}

/** 目标元素中心点是否真的能收到点击（没有被遮罩层盖住）。 */
export async function isPointerTargetReachable(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!(target instanceof Element)) return false;

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!hit) return false;
    return hit === target || target.contains(hit) || hit.contains(target);
  }, selector).catch(() => false);
}

/** 仅用于失败日志：说清楚到底是谁挡住了目标元素。 */
export async function describePointerBlocker(page: Page, selector: string): Promise<string> {
  return page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!(target instanceof Element)) return 'target-not-found';

    const rect = target.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!hit) return 'nothing-at-point';
    if (hit === target || target.contains(hit)) return 'clear';

    const text = (hit.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const className = hit.getAttribute('class') ?? '';
    const inPortal = hit.closest('[data-base-ui-portal]') ? ' in-portal' : '';
    return `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ''}${inPortal} "${text}" class="${className}"`;
  }, selector).catch((error) => `probe-failed: ${error}`);
}

/**
 * 等待目标元素真正可点：期间持续处理已知弹窗/遮罩。
 * 兜底会摘掉当前挡在目标上面的 base-ui portal（Suno 经常换文案的新弹窗）。
 */
export async function waitForPointerTarget(
  page: Page,
  selector: string,
  timeoutMs = 20_000
): Promise<boolean> {
  if (await isPointerTargetReachable(page, selector)) return true;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await dismissBlockingDialog(page)) continue;

    const removedBlocker = await removePortalBlockingTarget(page, selector);
    if (removedBlocker) {
      logger.warn('SunoPopupHandler: removed an unknown portal overlay covering the target');
      await page.waitForTimeout(200);
      continue;
    }

    await page.waitForTimeout(300);
  }

  return isPointerTargetReachable(page, selector);
}

async function removePortalBlockingTarget(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!(target instanceof Element)) return false;

    const rect = target.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!hit || hit === target || target.contains(hit)) return false;

    const portal = hit.closest('[data-base-ui-portal]');
    if (!portal) return false;

    portal.remove();
    document.body.style.pointerEvents = '';
    document.documentElement.style.pointerEvents = '';
    document.body.style.removeProperty('overflow');
    document.querySelectorAll('[data-base-ui-inert]').forEach((element) => {
      element.removeAttribute('data-base-ui-inert');
    });
    document.querySelectorAll('[inert]').forEach((element) => {
      element.removeAttribute('inert');
    });
    return true;
  }, selector).catch(() => false);
}
