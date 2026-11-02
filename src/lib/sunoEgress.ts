import * as net from 'node:net';
import pino from 'pino';
import { SocksProxyAgent } from 'socks-proxy-agent';

/**
 * Optional residential/operator egress for Suno traffic.
 *
 * The operator Mac keeps a reverse dynamic SSH forward open
 * (`ssh -R 127.0.0.1:1080 sunotunnel@server`), which exposes a SOCKS5 proxy on
 * the server loopback that exits through the Mac's network. When that tunnel is
 * healthy, all Suno control-plane traffic uses it so API calls share the same
 * egress IP as the Mac browser used for captcha recovery. When the Mac is
 * offline the probe fails and traffic silently falls back to the server's
 * direct connection.
 *
 * Env:
 *   SUNO_EGRESS_PROXY_URL        e.g. socks5h://127.0.0.1:1080 (unset = disabled)
 *   SUNO_EGRESS_PROBE_INTERVAL_MS default 30000
 *   SUNO_EGRESS_PROBE_TARGET      default studio-api-prod.suno.com:443
 *   SUNO_EGRESS_BROWSER           'false' keeps server Playwright on direct egress
 */

const logger = pino();

type EgressState = 'disabled' | 'unknown' | 'up' | 'down';

const proxyUrl = (process.env.SUNO_EGRESS_PROXY_URL || '').trim();
const probeIntervalMs = Math.max(5_000, Number(process.env.SUNO_EGRESS_PROBE_INTERVAL_MS) || 30_000);
const probeTimeoutMs = 10_000;
const [probeHost, probePortRaw] = (process.env.SUNO_EGRESS_PROBE_TARGET || 'studio-api-prod.suno.com:443').split(':');
const probePort = Number(probePortRaw) || 443;

let state: EgressState = proxyUrl ? 'unknown' : 'disabled';
let consecutiveFailures = 0;
let lastChange = Date.now();
let lastError: string | undefined;
let agent: SocksProxyAgent | undefined;
let timer: NodeJS.Timeout | undefined;
let probing: Promise<void> | undefined;

function parsedProxy(): { host: string; port: number } | undefined {
  if (!proxyUrl) return undefined;
  try {
    const url = new URL(proxyUrl);
    return { host: url.hostname, port: Number(url.port) || 1080 };
  } catch {
    return undefined;
  }
}

function getAgent(): SocksProxyAgent {
  if (!agent) {
    agent = new SocksProxyAgent(proxyUrl, {
      keepAlive: true,
      keepAliveMsecs: 15_000,
      maxSockets: 16,
      maxFreeSockets: 4,
      timeout: 60_000,
    });
  }
  return agent;
}

function resetAgent() {
  const old = agent;
  agent = undefined;
  try { old?.destroy(); } catch { /* ignore */ }
}

function setState(next: EgressState, reason?: string) {
  if (next === state) return;
  const previous = state;
  state = next;
  lastChange = Date.now();
  if (next === 'down') resetAgent();
  logger.info({ previous, next, reason }, next === 'up'
    ? 'Suno egress tunnel is up; routing Suno traffic through operator network'
    : 'Suno egress tunnel unavailable; using direct server egress');
}

/**
 * End-to-end SOCKS5 CONNECT probe. A reverse dynamic forward keeps the local
 * listener open while the SSH session lingers, so only a successful CONNECT
 * reply proves the Mac side is actually reachable.
 */
function probeOnce(): Promise<void> {
  const proxy = parsedProxy();
  if (!proxy) return Promise.reject(new Error('invalid SUNO_EGRESS_PROXY_URL'));
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    let stage: 'greet' | 'connect' = 'greet';
    let buffer = Buffer.alloc(0);
    const done = (error?: Error) => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timeout = setTimeout(() => done(new Error(`probe timeout at ${stage}`)), probeTimeoutMs);
    socket.on('error', error => done(error));
    socket.on('close', () => done(new Error(`probe closed at ${stage}`)));
    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greet') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) return done(new Error('socks auth rejected'));
        buffer = buffer.subarray(2);
        stage = 'connect';
        const host = Buffer.from(probeHost, 'utf8');
        const port = Buffer.alloc(2);
        port.writeUInt16BE(probePort);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]));
        return;
      }
      if (buffer.length < 2) return;
      if (buffer[1] !== 0x00) return done(new Error(`socks connect failed (reply ${buffer[1]})`));
      done();
    });
  });
}

export function probeSunoEgress(): Promise<void> {
  if (state === 'disabled') return Promise.resolve();
  if (probing) return probing;
  probing = probeOnce()
    .then(() => {
      consecutiveFailures = 0;
      lastError = undefined;
      setState('up', 'probe ok');
    })
    .catch(error => {
      consecutiveFailures += 1;
      lastError = error instanceof Error ? error.message : String(error);
      // Two misses before leaving 'up' avoids flapping on a single slow probe;
      // request-level SOCKS failures mark it down immediately instead.
      if (state !== 'up' || consecutiveFailures >= 2) setState('down', lastError);
    })
    .finally(() => { probing = undefined; });
  return probing;
}

function ensureMonitor() {
  if (timer || state === 'disabled') return;
  void probeSunoEgress();
  timer = setInterval(() => { void probeSunoEgress(); }, probeIntervalMs);
  timer.unref?.();
}

export function isSunoHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!(host === 'suno.com' || host.endsWith('.suno.com') || host === 'suno.ai' || host.endsWith('.suno.ai'))) return false;
  // Large media downloads stay on direct egress to avoid loading the tunnel.
  return !/^cdn\d*\./.test(host);
}

/** Agent for this URL, or undefined for direct egress. */
export function sunoEgressAgentFor(url: string | undefined): SocksProxyAgent | undefined {
  if (state === 'disabled' || !url) return undefined;
  ensureMonitor();
  if (state !== 'up') return undefined;
  try {
    if (!isSunoHost(new URL(url).hostname)) return undefined;
  } catch {
    return undefined;
  }
  return getAgent();
}

/** Playwright proxy option for the server browser, when the tunnel is up. */
export function sunoEgressBrowserProxy(): { server: string } | undefined {
  if (state === 'disabled' || process.env.SUNO_EGRESS_BROWSER === 'false') return undefined;
  ensureMonitor();
  const proxy = parsedProxy();
  if (state !== 'up' || !proxy) return undefined;
  return { server: `socks5://${proxy.host}:${proxy.port}` };
}

/**
 * True when a request failed while establishing the SOCKS tunnel, i.e. before
 * any byte of the HTTP request reached Suno, so a direct retry is safe even for
 * non-idempotent calls.
 */
export function isEgressConnectFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { name?: string; message?: string; code?: string; cause?: unknown };
  const ctor = (error as { constructor?: { name?: string } }).constructor?.name || '';
  const text = `${ctor} ${err.name || ''} ${err.message || ''}`;
  if (/Socks|SOCKS/.test(text)) return true;
  const proxy = parsedProxy();
  // Any socket error addressed to the proxy endpoint itself happened before a
  // request byte could reach Suno.
  if (proxy && text.includes(`${proxy.host}:${proxy.port}`)) return true;
  return err.cause ? isEgressConnectFailure(err.cause) : false;
}

export function reportSunoEgressFailure(error: unknown) {
  if (state === 'disabled') return;
  const message = error instanceof Error ? error.message : String(error);
  lastError = message;
  consecutiveFailures += 1;
  setState('down', `request failure: ${message}`);
  void probeSunoEgress();
}

export function sunoEgressExtraTimeoutMs(): number {
  const value = Number(process.env.SUNO_EGRESS_EXTRA_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 0 ? value : 15_000;
}

export function sunoEgressStatus() {
  return {
    state,
    proxy: proxyUrl ? proxyUrl.replace(/\/\/[^@]*@/, '//***@') : undefined,
    consecutiveFailures,
    lastChange: new Date(lastChange).toISOString(),
    lastError,
  };
}

// Start probing at module load so the first request after boot already knows
// whether the tunnel is available.
ensureMonitor();
