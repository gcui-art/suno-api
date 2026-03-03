# V3 — Async Concurrency Support

## Problem

The SunoApi class was not safe for concurrent requests. When multiple API calls hit the server simultaneously:

1. **Token refresh race**: Multiple calls to `keepAlive()` would all refresh the token at the same time, hammering the Clerk API
2. **Browser collision**: Multiple calls to `getCaptcha()` would each launch a separate browser, wasting resources
3. **No request tracking**: Logs from concurrent requests were interleaved with no way to tell them apart
4. **No concurrency limit**: Unlimited parallel generation requests could overwhelm the Suno API

## Changes

### `src/lib/utils.ts` — New Concurrency Primitives

#### `AsyncMutex`

A simple async mutual exclusion lock. Only one holder at a time; others queue up.

```typescript
const mutex = new AsyncMutex();

const release = await mutex.acquire();
try {
  // Critical section — only one caller at a time
} finally {
  release();
}
```

Properties:
- `isLocked: boolean` — Whether the mutex is currently held
- `queueLength: number` — How many callers are waiting

#### `AsyncSemaphore`

An async semaphore that allows up to N concurrent holders.

```typescript
const semaphore = new AsyncSemaphore(3); // max 3 concurrent

const release = await semaphore.acquire();
try {
  // Up to 3 callers can be here simultaneously
} finally {
  release();
}
```

Properties:
- `activeCount: number` — How many slots are currently in use
- `waitingCount: number` — How many callers are queued

### `src/lib/SunoApi.ts` — Concurrency Integration

#### New Instance Fields

| Field | Type | Purpose |
|---|---|---|
| `keepAliveMutex` | `AsyncMutex` | Serializes token refresh |
| `captchaMutex` | `AsyncMutex` | Serializes CAPTCHA browser sessions |
| `requestSemaphore` | `AsyncSemaphore` | Limits concurrent generation requests |
| `lastKeepAliveTime` | `number` | Timestamp of last successful token refresh |
| `requestCounter` | `number` | Auto-incrementing request ID for log tracing |
| `KEEPALIVE_COOLDOWN_MS` | `30000` | Skip refresh if token was refreshed within 30s |

#### Updated `keepAlive()`

- **Fast-path skip**: If token was refreshed within `KEEPALIVE_COOLDOWN_MS` (30s), returns immediately without acquiring the mutex
- **Mutex-protected refresh**: Only one caller actually refreshes the token
- **Double-check pattern**: After acquiring the mutex, re-checks the cooldown (another caller may have refreshed while waiting)

```
Request A ──► keepAlive() ──► acquires mutex ──► refreshes token ──► releases
Request B ──► keepAlive() ──► waits on mutex ──► checks cooldown ──► skips (recent) ──► releases
Request C ──► keepAlive() ──► cooldown check ──► skips immediately (fast-path)
```

#### Updated `getCaptcha()`

- **Mutex-serialized**: Only one browser session at a time
- **Re-check after lock**: After acquiring the mutex, re-checks `captchaRequired()` — a previous caller may have solved it
- **Queue visibility**: Logs how many requests are waiting when the mutex is contended

```
Request A ──► getCaptcha() ──► acquires mutex ──► launches browser ──► solves CAPTCHA ──► releases
Request B ──► getCaptcha() ──► waits on mutex ──► re-checks ──► CAPTCHA no longer needed ──► returns null
```

#### Updated `generateSongs()`

- **Semaphore-limited**: Controlled by `CONCURRENT_LIMIT` env var (default: 3)
- **Request IDs**: Each request gets `[req-N]` prefix in logs for traceability
- **Slot logging**: Logs active/waiting counts when acquiring a slot

```
[req-1] Acquired slot (active: 1, waiting: 0)
[req-2] Acquired slot (active: 2, waiting: 0)
[req-3] Acquired slot (active: 3, waiting: 0)
[req-4] ...waiting... (semaphore full)
[req-1] Released slot
[req-4] Acquired slot (active: 3, waiting: 0)
```

### `.env` — New Configuration

```env
# Max concurrent generation requests (default: 3)
CONCURRENT_LIMIT=3
```

## Concurrency Flow (5 simultaneous requests)

```
Time ──────────────────────────────────────────────────────►

req-1: ├─keepAlive(refresh)─┤─getCaptcha(null)─┤─generate──────────┤ done
req-2: ├─keepAlive(skip)────┤─getCaptcha(null)─┤─generate──────────┤ done
req-3: ├─keepAlive(skip)────┤─getCaptcha(null)─┤─generate──────────┤ done
req-4: ├─keepAlive(skip)────┤─getCaptcha(null)─┤──wait──┤─generate─┤ done
req-5: ├─keepAlive(skip)────┤─getCaptcha(null)─┤──wait──┤─generate─┤ done
                                                ▲
                                          semaphore limit (3)
```

## Response Format

Each request still returns **2 audio clips** (Suno platform behavior). So 5 concurrent requests = 10 total audio clips.

```json
// Single request response
[
  { "id": "abc-123", "title": "My Song", "status": "submitted" },
  { "id": "def-456", "title": "My Song", "status": "submitted" }
]
```

## How to Use

1. Set `CONCURRENT_LIMIT=3` in `.env` (or any number you want)
2. Run `npm run dev`
3. Fire multiple POST requests to `/api/custom_generate` simultaneously
4. Each request will be queued and processed in order, with at most `CONCURRENT_LIMIT` running at once
5. Logs will show `[req-N]` prefixes so you can trace each request
