import { Locator, Page } from 'playwright';

/**
 * Suno 的 prompt 输入框历史上带 maxlength="3000"，2026-11 改版后只剩 rows="1"，
 * 因此按优先级依次尝试，避免每次改版都直接超时。
 */
export const PROMPT_TEXTAREA_SELECTORS = [
  'textarea[maxlength="3000"]',
  'textarea[placeholder]',
  'textarea[rows="1"]',
  'textarea',
];

export const PROMPT_TEXTAREA_SELECTOR = PROMPT_TEXTAREA_SELECTORS.join(', ');
export const CREATE_SONG_BUTTON_SELECTOR = 'button[aria-label="Create song"]';

export interface PromptTextareaHandle {
  locator: Locator;
  selector: string;
}

/** 轮询等待输入框出现，返回实际命中的选择器（后续做遮挡检测需要它）。 */
export async function waitForPromptTextarea(
  page: Page,
  timeoutMs = 60_000
): Promise<PromptTextareaHandle | undefined> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of PROMPT_TEXTAREA_SELECTORS) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible({ timeout: 300 }).catch(() => false);
      if (visible) return { locator, selector };
    }
    await page.waitForTimeout(500);
  }

  return undefined;
}
