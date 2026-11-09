import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const EVENT_TIMEOUT_MS = 8 * 60_000;
const LEASE_TIMEOUT_MS = 5 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASONS = new Set([
  'captcha_required', 'manual_verification_required', 'browser_not_ready',
  'generation_failed', 'session_mismatch', 'local_recovery_failed',
  'expired', 'interrupted', 'lease_expired', 'storage_error', 'cancelled',
]);

export type SunoLocalRecoveryStatus = 'pending' | 'claimed' | 'completed' | 'failed' | 'expired';

export interface SunoLocalRecoveryEvent {
  id: string;
  accountId: string;
  requestId?: string;
  browserHandle: string;
  createdAt: string;
  expiresAt: string;
  status: SunoLocalRecoveryStatus;
  reason?: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  finishedAt?: string;
  clipIds?: string[];
}

interface StoredEvent extends SunoLocalRecoveryEvent {
  owner?: string;
  leaseToken?: string;
}

export interface SunoLocalRecoveryResult { clipIds: string[]; eventId: string }

export interface SunoLocalRecoveryOptions {
  reason?: string;
  requestId?: string;
  signal?: AbortSignal;
}

interface Waiter {
  promise: Promise<SunoLocalRecoveryResult>;
  resolve(value: SunoLocalRecoveryResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener?(): void;
}

export class SunoLocalRecoveryRequiredError extends Error {
  public readonly statusCode = 409;
  public readonly code = 'SUNO_LOCAL_RECOVERY_REQUIRED';

  constructor(public readonly eventId: string, public readonly reason: string) {
    super(`Suno local browser recovery did not complete (${reason})`);
    this.name = 'SunoLocalRecoveryRequiredError';
  }
}

export class SunoLocalRecoveryProtocolError extends Error {
  public readonly code = 'SUNO_LOCAL_RECOVERY_PROTOCOL';

  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'SunoLocalRecoveryProtocolError';
  }
}

function safeReason(reason: unknown, fallback: string): string {
  return typeof reason === 'string' && REASONS.has(reason) ? reason : fallback;
}

function publicEvent(event: StoredEvent): SunoLocalRecoveryEvent {
  const { owner: _owner, leaseToken: _token, ...result } = event;
  return { ...result, ...(result.clipIds ? { clipIds: [...result.clipIds] } : {}) };
}

function validIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:@-]{1,160}$/.test(value)) {
    throw new SunoLocalRecoveryProtocolError(400, `Invalid ${label}`);
  }
  return value;
}

function sameSecret(left: string | undefined, right: unknown): boolean {
  if (!left || typeof right !== 'string' || right.length > 256) return false;
  const expected = Buffer.from(left);
  const received = Buffer.from(right);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export class SunoLocalRecoveryStore {
  private readonly events = new Map<string, StoredEvent>();
  private readonly activeAccounts = new Map<string, string>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly directory: string;
  private readonly eventTimeoutMs: number;
  private readonly leaseTimeoutMs: number;
  private readonly browserHandle: string;
  private readonly now: () => number;

  constructor(options: {
    directory: string;
    browserHandle: string;
    eventTimeoutMs?: number;
    leaseTimeoutMs?: number;
    now?: () => number;
  }) {
    this.directory = path.resolve(options.directory);
    this.browserHandle = validIdentifier(options.browserHandle, 'browser handle');
    this.eventTimeoutMs = Math.min(EVENT_TIMEOUT_MS, Math.max(1, options.eventTimeoutMs ?? EVENT_TIMEOUT_MS));
    this.leaseTimeoutMs = Math.min(LEASE_TIMEOUT_MS, Math.max(1, options.leaseTimeoutMs ?? LEASE_TIMEOUT_MS));
    this.now = options.now ?? Date.now;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.restore();
  }

  wait(accountId: string, options?: SunoLocalRecoveryOptions): Promise<SunoLocalRecoveryResult> {
    validIdentifier(accountId, 'account id');
    if (options?.requestId) validIdentifier(options.requestId, 'request id');
    this.expireDue();
    const existing = this.activeAccounts.get(accountId);
    if (existing) return this.waiters.get(existing)!.promise;
    const now = this.now();
    const event: StoredEvent = {
      id: randomUUID(), accountId, requestId: options?.requestId, browserHandle: this.browserHandle,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.eventTimeoutMs).toISOString(),
      status: 'pending', reason: safeReason(options?.reason, 'captcha_required'),
    };
    this.persist(event);
    let resolve!: Waiter['resolve'];
    let reject!: Waiter['reject'];
    const promise = new Promise<SunoLocalRecoveryResult>((res, rej) => { resolve = res; reject = rej; });
    // The request may still be sending its notification before attaching its await.
    void promise.catch(() => undefined);
    const waiter: Waiter = { promise, resolve, reject, timer: setTimeout(() => this.expireDue(), this.eventTimeoutMs) };
    this.events.set(event.id, event);
    this.activeAccounts.set(accountId, event.id);
    this.waiters.set(event.id, waiter);
    if (options?.signal) {
      const signal = options.signal;
      const onAbort = () => {
        if (this.waiters.has(event.id)) this.terminate(this.events.get(event.id)!, 'expired', 'cancelled');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      waiter.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
    }
    return promise;
  }

  list(includeRecent = false): SunoLocalRecoveryEvent[] {
    this.expireDue();
    const all = [...this.events.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const active = all.filter((event) => event.status === 'pending' || event.status === 'claimed');
    const recent = includeRecent ? all.filter((event) => event.status !== 'pending' && event.status !== 'claimed').slice(0, 50) : [];
    return [...active, ...recent].map(publicEvent);
  }

  claim(id: unknown, ownerValue: unknown): SunoLocalRecoveryEvent & { leaseToken: string } {
    const event = this.requireEvent(id);
    this.assertLive(event);
    const owner = validIdentifier(ownerValue, 'owner');
    if (event.status === 'claimed') {
      if (event.owner !== owner) throw new SunoLocalRecoveryProtocolError(409, 'Recovery event is already claimed');
      return { ...publicEvent(event), leaseToken: event.leaseToken! };
    }
    const now = this.now();
    const claimed: StoredEvent = {
      ...event, status: 'claimed', owner, leaseToken: randomBytes(32).toString('hex'),
      claimedAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(Math.min(now + this.leaseTimeoutMs, Date.parse(event.expiresAt))).toISOString(),
    };
    this.persist(claimed);
    this.events.set(claimed.id, claimed);
    this.scheduleExpiry(claimed);
    return { ...publicEvent(claimed), leaseToken: claimed.leaseToken! };
  }

  complete(id: unknown, leaseToken: unknown, clipIdsValue: unknown): SunoLocalRecoveryEvent {
    const event = this.requireEvent(id);
    this.assertLease(event, leaseToken);
    if (!Array.isArray(clipIdsValue) || clipIdsValue.length < 1 || clipIdsValue.length > 20 ||
      !clipIdsValue.every((value) => typeof value === 'string' && UUID_RE.test(value))) {
      throw new SunoLocalRecoveryProtocolError(400, 'clipIds must contain valid clip UUIDs');
    }
    const clipIds = [...new Set(clipIdsValue.map((value: string) => value.toLowerCase()))];
    if (event.status === 'completed') {
      if (JSON.stringify(clipIds) !== JSON.stringify(event.clipIds)) {
        throw new SunoLocalRecoveryProtocolError(409, 'Recovery completion does not match the completed event');
      }
      return publicEvent(event);
    }
    this.assertLive(event);
    const completed: StoredEvent = {
      ...event, status: 'completed', clipIds, finishedAt: new Date(this.now()).toISOString(),
    };
    this.persist(completed);
    this.events.set(completed.id, completed);
    const waiter = this.removeWaiter(completed);
    waiter!.resolve({ clipIds: [...clipIds], eventId: event.id });
    return publicEvent(completed);
  }

  fail(id: unknown, leaseToken: unknown, reason?: unknown): SunoLocalRecoveryEvent {
    const event = this.requireEvent(id);
    this.assertLease(event, leaseToken);
    if (event.status === 'failed') return publicEvent(event);
    this.assertLive(event);
    return publicEvent(this.terminate(event, 'failed', safeReason(reason, 'local_recovery_failed')));
  }

  dispose(): void {
    for (const id of [...this.waiters.keys()]) this.terminate(this.events.get(id)!, 'expired', 'interrupted');
  }

  private requireEvent(id: unknown): StoredEvent {
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw new SunoLocalRecoveryProtocolError(400, 'Invalid recovery id');
    this.expireDue();
    const event = this.events.get(id);
    if (!event) throw new SunoLocalRecoveryProtocolError(404, 'Recovery event not found');
    return event;
  }

  private assertLive(event: StoredEvent): void {
    if (event.status !== 'pending' && event.status !== 'claimed') {
      throw new SunoLocalRecoveryProtocolError(410, 'Recovery event is no longer active');
    }
    if (!this.waiters.has(event.id)) {
      this.terminate(event, 'expired', 'interrupted');
      throw new SunoLocalRecoveryProtocolError(410, 'The original request is no longer waiting');
    }
    const deadline = Math.min(Date.parse(event.expiresAt), event.leaseExpiresAt ? Date.parse(event.leaseExpiresAt) : Infinity);
    if (deadline <= this.now()) {
      this.terminate(event, 'expired', 'expired');
      throw new SunoLocalRecoveryProtocolError(410, 'Recovery event has expired');
    }
  }

  private assertLease(event: StoredEvent, token: unknown): void {
    if (event.status === 'expired') throw new SunoLocalRecoveryProtocolError(410, 'Recovery event has expired');
    if (!sameSecret(event.leaseToken, token)) throw new SunoLocalRecoveryProtocolError(403, 'Invalid recovery lease');
  }

  private expireDue(): void {
    const now = this.now();
    for (const id of [...this.waiters.keys()]) {
      const event = this.events.get(id)!;
      if (Date.parse(event.expiresAt) <= now) this.terminate(event, 'expired', 'expired');
      else if (event.leaseExpiresAt && Date.parse(event.leaseExpiresAt) <= now) this.terminate(event, 'expired', 'lease_expired');
    }
  }

  private scheduleExpiry(event: StoredEvent): void {
    const waiter = this.waiters.get(event.id)!;
    clearTimeout(waiter.timer);
    const due = Math.min(Date.parse(event.expiresAt), event.leaseExpiresAt ? Date.parse(event.leaseExpiresAt) : Infinity);
    waiter.timer = setTimeout(() => this.expireDue(), Math.max(1, due - this.now()));
  }

  private terminate(event: StoredEvent, status: 'expired' | 'failed', reason: string): StoredEvent {
    const terminal: StoredEvent = { ...event, status, reason, finishedAt: new Date(this.now()).toISOString() };
    let storedReason = reason;
    try { this.persist(terminal); } catch { storedReason = 'storage_error'; }
    this.events.set(event.id, terminal);
    this.removeWaiter(event)?.reject(new SunoLocalRecoveryRequiredError(event.id, storedReason));
    return terminal;
  }

  private removeWaiter(event: StoredEvent): Waiter | undefined {
    const waiter = this.waiters.get(event.id);
    if (waiter) clearTimeout(waiter.timer);
    waiter?.removeAbortListener?.();
    this.waiters.delete(event.id);
    if (this.activeAccounts.get(event.accountId) === event.id) this.activeAccounts.delete(event.accountId);
    return waiter;
  }

  private persist(event: StoredEvent): void {
    const filename = path.join(this.directory, `${event.id}.json`);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(event)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, filename);
    } finally {
      try { unlinkSync(temporary); } catch { /* Renamed files no longer have a temporary path. */ }
    }
  }

  private restore(): void {
    for (const filename of readdirSync(this.directory)) {
      if (!filename.endsWith('.json') || !UUID_RE.test(filename.slice(0, -5))) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(path.join(this.directory, filename), 'utf8')); } catch { continue; }
      const value = parsed as Partial<StoredEvent> | null;
      if (!value || typeof value !== 'object' || value.id !== filename.slice(0, -5) ||
        typeof value.accountId !== 'string' || typeof value.browserHandle !== 'string' ||
        !Number.isFinite(Date.parse(value.createdAt ?? '')) || !Number.isFinite(Date.parse(value.expiresAt ?? '')) ||
        !['pending', 'claimed', 'completed', 'failed', 'expired'].includes(value.status ?? '')) continue;
      // Explicit fields prevent unrelated or sensitive payload fields from entering API output.
      const event: StoredEvent = {
        id: value.id!, accountId: value.accountId,
        requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        browserHandle: value.browserHandle,
        createdAt: value.createdAt!, expiresAt: value.expiresAt!, status: value.status!,
        reason: safeReason(value.reason, 'captcha_required'),
        claimedAt: value.claimedAt, leaseExpiresAt: value.leaseExpiresAt,
        finishedAt: value.finishedAt, owner: value.owner, leaseToken: value.leaseToken,
        clipIds: Array.isArray(value.clipIds) ? value.clipIds.filter((id) => typeof id === 'string' && UUID_RE.test(id)) : undefined,
      };
      if (event.status === 'pending' || event.status === 'claimed') {
        event.status = 'expired';
        event.reason = 'interrupted';
        event.finishedAt = new Date(this.now()).toISOString();
        this.persist(event);
      }
      this.events.set(event.id, event);
    }
  }
}

const processState = globalThis as typeof globalThis & {
  __sunoLocalRecoveryStores?: Map<string, SunoLocalRecoveryStore>;
};

export function getLocalSunoRecoveryStore(): SunoLocalRecoveryStore {
  const directory = path.resolve(process.cwd(), 'data', 'captcha-recoveries');
  const stores = processState.__sunoLocalRecoveryStores ??= new Map();
  let store = stores.get(directory);
  if (!store) {
    store = new SunoLocalRecoveryStore({
      directory,
      browserHandle: process.env.SUNO_LOCAL_BROWSER_HANDLE || 'craftyonehitwonder742',
    });
    stores.set(directory, store);
  }
  return store;
}

export function waitForLocalSunoRecovery(
  accountId: string,
  options?: SunoLocalRecoveryOptions,
): Promise<SunoLocalRecoveryResult> {
  return getLocalSunoRecoveryStore().wait(accountId, options);
}

export function authenticateLocalSunoRecovery(request: Request, secretPath?: string): void {
  let secret: string;
  try {
    secret = readFileSync(secretPath || process.env.SUNO_LOCAL_RECOVERY_SECRET_FILE || '/root/suno-api/data/local-recovery-secret', 'utf8').trim();
    if (!/^(?:[a-fA-F0-9]{64}|[a-zA-Z0-9+/_-]{43}=?)$/.test(secret)) throw new Error('Invalid secret');
  } catch {
    throw new SunoLocalRecoveryProtocolError(503, 'Local recovery authentication is not configured');
  }
  const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!sameSecret(secret, token)) throw new SunoLocalRecoveryProtocolError(401, 'Unauthorized');
}

async function readAction(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new SunoLocalRecoveryProtocolError(400, 'Missing action');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) {
        await reader.cancel();
        throw new SunoLocalRecoveryProtocolError(413, 'Recovery action is too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new SunoLocalRecoveryProtocolError(400, 'Invalid JSON action');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SunoLocalRecoveryProtocolError(400, 'Invalid action');
  return body as Record<string, unknown>;
}

export async function handleLocalSunoRecoveryRequest(
  request: Request,
  dependencies?: { store?: SunoLocalRecoveryStore; secretPath?: string },
): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  try {
    authenticateLocalSunoRecovery(request, dependencies?.secretPath);
    const store = dependencies?.store ?? getLocalSunoRecoveryStore();
    if (request.method === 'GET') {
      return json({ events: store.list(new URL(request.url).searchParams.get('include') === 'recent') });
    }
    if (request.method !== 'POST') throw new SunoLocalRecoveryProtocolError(405, 'Method not allowed');
    const body = await readAction(request);
    if (body.action === 'claim') return json({ event: store.claim(body.id, body.owner) });
    if (body.action === 'complete') return json({ event: store.complete(body.id, body.leaseToken, body.clipIds) });
    if (body.action === 'fail') return json({ event: store.fail(body.id, body.leaseToken, body.reason) });
    throw new SunoLocalRecoveryProtocolError(400, 'Unknown recovery action');
  } catch (error) {
    // Next route bundles can share a store while holding different Error constructors.
    const protocolError = error as Partial<SunoLocalRecoveryProtocolError> | null;
    if (protocolError?.code === 'SUNO_LOCAL_RECOVERY_PROTOCOL' &&
      typeof protocolError.message === 'string' &&
      typeof protocolError.statusCode === 'number' &&
      [400, 401, 403, 404, 405, 409, 410, 413, 503].includes(protocolError.statusCode)) {
      return json({ error: protocolError.message }, protocolError.statusCode);
    }
    return json({ error: 'Local recovery is unavailable' }, 503);
  }
}
