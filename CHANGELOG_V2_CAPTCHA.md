# V2 — CAPTCHA Handling Rewrite

## Problem

The original CAPTCHA handling in `SunoApi.ts` used hardcoded selectors (`.custom-textarea`) that broke when Suno updated their UI. This caused:

1. `TimeoutError: Timeout 30000ms exceeded` waiting for `.custom-textarea`
2. Massive log spam from polling loops (`"Sleeping for 0.25 seconds"` hundreds of times)
3. Unhandled promise rejections when the captcha-solver promise failed
4. No way to debug what the Suno page actually looked like

## Changes

### `src/lib/SunoApi.ts`

#### New Helper Methods

| Method | Purpose |
|---|---|
| `saveDebugSnapshot(page, label, requestLog?)` | Saves HTML, screenshot, request log, and frame list to `debug/` folder |
| `waitForCaptchaFrame(page, timeout?)` | Detects hCaptcha, reCAPTCHA, Cloudflare Turnstile, or Arkose/FunCaptcha iframes |
| `waitForAnyVisibleLocator(page, selectors, timeout?)` | Polls multiple CSS selectors, returns first visible. Uses raw `setTimeout(500)` to avoid log spam |

#### Rewritten `getCaptcha()`

The entire method was rewritten with numbered debug snapshots at every step:

| Step | Snapshot | Description |
|---|---|---|
| 1 | `01-page-loaded` | HTML + screenshot after navigating to `suno.com/create` |
| 2 | `02-interactive-elements.log` | All `<button>`, `<textarea>`, `<input>`, `[contenteditable]` elements with full attributes |
| 3 | `03-no-prompt-input` | Saved only if no prompt input was found |
| 4 | `04-no-create-button` | Saved only if no Create button was found |
| 5 | `05-after-create-click` | HTML + screenshot + request log after clicking Create |
| 6 | `06-after-second-click` | Same, after retry if first click didn't trigger CAPTCHA |
| 7 | `07-no-captcha-final` | Final state if no CAPTCHA appeared and generation didn't proceed |
| 8 | `08-unsupported-captcha` | If a non-hCaptcha provider was detected |

#### Key Improvements

- **Fallback selectors**: 10 selectors for prompt input, 8 for Create button
- **Popup dismissal**: Automatically closes modals/banners before interacting
- **Interactive element discovery**: Logs every interactive element on the page to help identify new selectors
- **Route interception before click**: Sets up `page.route('**/api/generate/v2/**')` before clicking Create so we never miss the generate call
- **Retry logic**: Clicks Create a second time if no CAPTCHA appears after the first click
- **Race condition handling**: Races between token interception and timeout, correctly handles generation proceeding without CAPTCHA
- **Error propagation**: Captcha solver errors are properly wired to the outer token promise via `rejectOuter()`

### `src/lib/utils.ts`

#### Updated `sleep()`

- Only logs calls ≥ 1 second to prevent polling log spam

#### Updated `waitForRequests()`

- Detects **6 URL patterns** across 4 CAPTCHA providers:
  - `img*.hcaptcha.com` + `*.hcaptcha.com/captcha/`
  - `www.google.com/recaptcha/` + `www.gstatic.com/recaptcha/`
  - `challenges.cloudflare.com/`
  - `*.arkoselabs.com/`
- Timeout increased from 60s → 120s
- Error message updated: "No CAPTCHA image/resource requests detected within 2 minutes"

## Debug Output

After running a request, check the `debug/` folder:

```
debug/
├── 01-page-loaded.html
├── 01-page-loaded.png
├── 01-page-loaded-frames.log
├── 01-page-loaded-requests.log
├── 02-interactive-elements.log       ← Most valuable for selector debugging
├── 05-after-create-click.html
├── 05-after-create-click.png
├── 05-after-create-click-requests.log
├── 05-after-create-click-frames.log
└── ...
```

## How to Debug

1. Run `npm run dev`
2. Hit `/api/custom_generate` with a POST request
3. Check `debug/02-interactive-elements.log` — every interactive element on the Suno page with full attributes
4. Check screenshots to see what the page actually looks like
5. Check request logs to see what URLs were loaded
6. Adjust selectors in `promptSelectors` and `buttonSelectors` arrays if Suno changed their UI again
