import axios, { AxiosInstance } from 'axios';
import pino from 'pino';
import { sleep } from '@/lib/utils';
import * as cookie from 'cookie';
import { randomUUID } from 'node:crypto';
import { ensureLoaded, getAccountById, pickAccount, updateAccountCookie } from '@/lib/accountStore';
import { recordRequest } from '@/lib/requestMonitor';
import {
  SunoGenerateClip,
  SunoGeneratePayload,
  validateSunoGenerateClips
} from '@/lib/sunoCaptchaGenerateCapture';
import {
  createBrowserUserAgent,
  createDesktopChromiumClientHints
} from '@/lib/browserFingerprint';
import { SunoCaptchaManualInterventionError } from '@/lib/sunoCaptchaErrors';
import {
  clearCaptchaCooldown,
  generationMinIntervalMs,
  markCaptchaRequired,
  runAccountGeneration
} from '@/lib/sunoGenerationGuard';
import { waitForLocalSunoRecovery } from '@/lib/sunoLocalRecovery';
import { isSunoCaptchaRejection, submitWithCaptchaRecovery } from '@/lib/sunoCaptchaRecovery';
import { generateWithServerCaptchaSolver } from '@/lib/sunoServerCaptchaRecovery';
import {
  getCurrentSunoGenerationJob,
  markSunoGenerationAccepted,
  markSunoGenerationRejected,
  markSunoGenerationSubmitted
} from '@/lib/sunoGenerationJobs';
import { notifyCaptchaFailure } from '@/lib/sunoCaptchaFailureNotifier';
import { FeishuNotifier } from '@/lib/feishuNotifier';
import { audioContentType, decryptSunoAudio, decryptSunoAudioStream } from '@/lib/sunoAudio';
import { applySunoSessionToken } from '@/lib/sunoAuthCookies';
import {
  isRetryableSunoRequest,
  runSunoStatusRequest,
  suno429DelayMs,
  suno429MaxRetries
} from '@/lib/sunoRateLimit';
import { generateWithSunoWebsite } from '@/lib/sunoWebsiteGenerate';
import {
  isEgressConnectFailure,
  reportSunoEgressFailure,
  sunoEgressAgentFor,
  sunoEgressExtraTimeoutMs,
} from '@/lib/sunoEgress';
import { validateMutationResponse } from '@/lib/sunoUpstreamResponse';
import type { CaptchaBrowserIdentity } from '@/lib/sunoCaptchaGenerateCapture';
import {
  apiSubmitJitterMs,
  apiSubmitTimeoutMs,
  loadSunoApiIdentity,
  mergeBrowserIdentity,
  recordApiSubmitOutcome,
  resolveDeviceId,
  saveSunoApiIdentity
} from '@/lib/sunoApiIdentity';
import { setTimeout as delay } from 'node:timers/promises';

// sunoApi instance caching
interface AudioStatusCacheEntry {
  expiresAt: number;
  value: AudioInfo[];
}

const globalForSunoApi = global as unknown as {
  sunoApiCache?: Map<string, SunoApi>;
  sunoAudioStatusCache?: Map<string, AudioStatusCacheEntry>;
  sunoAudioStatusInflight?: Map<string, Promise<AudioInfo[]>>;
};
export const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;
const audioStatusCache = globalForSunoApi.sunoAudioStatusCache || new Map<string, AudioStatusCacheEntry>();
const audioStatusInflight = globalForSunoApi.sunoAudioStatusInflight || new Map<string, Promise<AudioInfo[]>>();
globalForSunoApi.sunoAudioStatusCache = audioStatusCache;
globalForSunoApi.sunoAudioStatusInflight = audioStatusInflight;

function audioStatusCacheTtlMs(): number {
  const configured = Number.parseInt(process.env.SUNO_STATUS_CACHE_TTL_MS ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 10_000;
}

const logger = pino();
export const DEFAULT_MODEL = 'chirp-hawk';

function invalidSunoResponse(operation: string, detail: string): Error & { code: string; statusCode: number } {
  const error = new Error(`${operation}: invalid upstream response (${detail})`) as Error & { code: string; statusCode: number };
  error.code = 'SUNO_INVALID_RESPONSE';
  error.statusCode = 502;
  return error;
}

function requireObject(value: unknown, operation: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidSunoResponse(operation, 'expected an object');
  }
  return value as Record<string, any>;
}

function requireArray(value: unknown, field: string, operation: string): any[] {
  if (!Array.isArray(value)) throw invalidSunoResponse(operation, `missing ${field} array`);
  return value;
}

function requireId(value: unknown, operation: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidSunoResponse(operation, 'missing id');
  }
  return value;
}

function redactAxiosError(error: any): any {
  const config = error?.config;
  if (config && typeof config === 'object') {
    const headers = config.headers && typeof config.headers === 'object'
      ? { ...config.headers }
      : undefined;
    if (headers) {
      for (const key of Object.keys(headers)) {
        if (/^(authorization|cookie|set-cookie|proxy-authorization)$/i.test(key)) {
          headers[key] = '[REDACTED]';
        }
      }
      config.headers = headers;
    }
    if (config.auth) config.auth = '[REDACTED]';
  }
  return error;
}

export const DEFAULT_SOUND_MODEL = DEFAULT_MODEL;

export interface AudioInfo {
  id: string; // Unique identifier for the audio
  title?: string; // Title of the audio
  image_url?: string; // URL of the image associated with the audio
  lyric?: string; // Lyrics of the audio
  audio_url?: string; // URL of the audio file
  video_url?: string; // URL of the video associated with the audio
  created_at: string; // Date and time when the audio was created
  model_name: string; // Name of the model used for audio generation
  gpt_description_prompt?: string; // Prompt for GPT description
  prompt?: string; // Prompt for audio generation
  status: string; // Status
  type?: string;
  tags?: string; // Genre of music.
  negative_tags?: string; // Negative tags of music.
  duration?: string; // Duration of the audio
  error_message?: string; // Error message if any
  // Public, decoded media candidates. Upstream encrypted URLs stay server-side.
  media_urls?: Array<{ url: string; content_type?: string; delivery?: string; encoding?: string }>;
}

export interface SunoControlSliders {
  weirdness_constraint?: number;
  style_weight?: number;
}

export interface SunoSoundConfigs {
  user_tempo?: number;
  user_key?: string;
  user_loop?: boolean;
}

export interface SunoGenerateMetadata {
  web_client_pathname?: string;
  is_max_mode?: boolean;
  is_mumble?: boolean;
  is_remix?: boolean;
  create_mode?: string;
  user_tier?: string;
  create_session_token?: string;
  disable_volume_normalization?: boolean;
  control_sliders?: SunoControlSliders;
  sound_configs?: SunoSoundConfigs;
  vocal_gender?: string;
  lyrics_model?: string;
  infill_lyrics?: string;
  lyrics_updated?: boolean;
}

export interface SunoGenerateOptions {
  task?: string;
  generation_type?: string;
  gpt_description_prompt?: string;
  user_uploaded_images_b64?: string[] | string | null;
  override_fields?: string[];
  cover_clip_id?: string | null;
  cover_start_s?: number | null;
  cover_end_s?: number | null;
  persona_id?: string | null;
  artist_clip_id?: string | null;
  artist_start_s?: number | null;
  artist_end_s?: number | null;
  continue_clip_id?: string | null;
  continued_aligned_prompt?: string | null;
  continue_at?: number | null;
  transaction_uuid?: string;
  token_provider?: number | null;
  mashup_clip_ids?: string[] | null;
  chop_sample_clip_id?: string | null;
  chop_sample_start_s?: number | null;
  chop_sample_end_s?: number | null;
  overpainting_clip_id?: string | null;
  infill_context_start_s?: number | null;
  infill_context_end_s?: number | null;
  infill_start_s?: number | null;
  infill_end_s?: number | null;
  infill_dur_s?: number | null;
  metadata?: SunoGenerateMetadata;
}

export interface SunoUploadAudioRequest {
  extension: string;
  upload_type?: string;
}

export interface SunoUploadAudioResponse {
  id: string;
  url: string;
  fields: Record<string, string>;
  is_file_uploaded: boolean;
}

export interface SunoUploadFinishRequest {
  upload_type?: string;
  upload_filename: string;
}

export interface PromptSuggestionsResponse {
  prompts: string[];
  lyrics_prompts: string[];
  tags: string[];
  is_pending_personalization: boolean;
}

export interface PromptUpsampleRequest {
  original_tags: string;
  is_instrumental: boolean;
}

export interface PromptUpsampleResponse {
  upsampled: string;
  request_id: string;
}

const OPTIONAL_METADATA_KEYS: Array<keyof SunoGenerateMetadata> = [
  'web_client_pathname',
  'is_max_mode',
  'is_mumble',
  'is_remix',
  'create_mode',
  'user_tier',
  'create_session_token',
  'disable_volume_normalization',
  'control_sliders',
  'sound_configs',
  'vocal_gender',
  'lyrics_model'
];

const OPTIONAL_GENERATE_KEYS: Array<keyof SunoGenerateOptions> = [
  'task',
  'generation_type',
  'gpt_description_prompt',
  'user_uploaded_images_b64',
  'override_fields',
  'cover_clip_id',
  'cover_start_s',
  'cover_end_s',
  'persona_id',
  'artist_clip_id',
  'artist_start_s',
  'artist_end_s',
  'continue_clip_id',
  'continued_aligned_prompt',
  'continue_at',
  'transaction_uuid',
  'token_provider',
  'mashup_clip_ids',
  'chop_sample_clip_id',
  'chop_sample_start_s',
  'chop_sample_end_s',
  'overpainting_clip_id',
  'infill_context_start_s',
  'infill_context_end_s',
  'infill_start_s',
  'infill_end_s',
  'infill_dur_s'
];

function mergeDefinedMetadata(
  target: Record<string, unknown>,
  source?: SunoGenerateMetadata
) {
  if (!source) {
    return;
  }

  for (const key of OPTIONAL_METADATA_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      target[key] = value;
    }
  }
}

function mergeDefinedGenerateOptions(
  target: Record<string, unknown>,
  source?: SunoGenerateOptions
) {
  if (!source) {
    return;
  }

  for (const key of OPTIONAL_GENERATE_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== null) {
      target[key] = value;
    }
  }
}

interface PersonaResponse {
  persona: {
    id: string;
    name: string;
    description: string;
    image_s3_id: string;
    root_clip_id: string;
    clip: any; // You can define a more specific type if needed
    user_display_name: string;
    user_handle: string;
    user_image_url: string;
    persona_clips: Array<{
      clip: any; // You can define a more specific type if needed
    }>;
    is_suno_persona: boolean;
    is_trashed: boolean;
    is_owned: boolean;
    is_public: boolean;
    is_public_approved: boolean;
    is_loved: boolean;
    upvote_count: number;
    clip_count: number;
  };
  total_results: number;
  current_page: number;
  is_following: boolean;
}

export class SunoApi {
  private static BASE_URL: string = 'https://studio-api-prod.suno.com';
  private static CLERK_BASE_URL: string = 'https://auth.suno.com';
  private static CLERK_VERSION = '5.117.0';

  private readonly client: AxiosInstance;
  private sid?: string;
  private currentToken?: string;
  private deviceId?: string;
  private userAgent?: string;
  /** Real Chromium identity learned from the persistent browser profile. */
  private browserIdentity?: CaptchaBrowserIdentity;
  private cookies: Record<string, string | undefined>;
  private accountId?: string;
  private authRefreshPromise?: Promise<void>;

  constructor(cookies: string, accountId?: string) {
    this.accountId = accountId;
    this.userAgent = createBrowserUserAgent();
    const clientHints = createDesktopChromiumClientHints(this.userAgent);
    this.cookies = cookie.parse(cookies);
    this.deviceId = resolveDeviceId(this.cookies);
    this.client = axios.create({
      withCredentials: true,
      // Keep control-plane requests from hanging indefinitely and occupying
      // the account lock. Long media transfers use their own client/timeouts.
      timeout: 15_000,
      headers: {
        'Affiliate-Id': 'undefined',
        'Device-Id': `"${this.deviceId}"`,
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://suno.com',
        Referer: 'https://suno.com/',
        'Accept-Language': process.env.BROWSER_ACCEPT_LANGUAGE || 'en-US,en;q=0.9',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        ...clientHints,
        'User-Agent': this.userAgent
      }
    });
    this.client.interceptors.request.use(config => {
      if (this.currentToken && !config.headers.Authorization && !this.isClerkRequest(config.url))
        config.headers.Authorization = `Bearer ${this.currentToken}`;
      config.headers.Cookie = this.serializeCookies();
      this.applyIdentityHeaders(config.headers as unknown as Record<string, unknown>);
      this.applyEgress(config as any);
      return config;
    });
    this.client.interceptors.response.use(async resp => {
      const setCookieHeader = resp.headers['set-cookie'];
      if (Array.isArray(setCookieHeader)) {
        const changed = this.mergeSetCookies(setCookieHeader);
        // Persist every Suno-issued cookie (Clerk and studio-api, e.g. edge
        // bot-management cookies) so a restart resumes the same client state.
        if (changed && this.accountId && this.isSunoUrl(resp.config.url)) {
          await updateAccountCookie(this.accountId, this.serializeCookies())
            .catch(() => logger.warn('Failed to persist refreshed Suno cookies'));
        }
      }
      return resp;
    }, async (error: any) => {
      const config = error?.config;
      if (config?._egressTunnel && !config._egressDirect) {
        const method = String(config.method || 'get').toLowerCase();
        const connectFailure = isEgressConnectFailure(error);
        const idempotentTimeout = !error?.response && method === 'get' &&
          (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT');
        if (connectFailure || idempotentTimeout) {
          // SOCKS setup failures happen before any request byte reaches Suno,
          // so a direct retry is safe even for POST; timeouts only for GET.
          if (connectFailure) reportSunoEgressFailure(error);
          config._egressDirect = true;
          logger.warn({ method, connectFailure }, 'Suno egress tunnel request failed; retrying once on direct egress');
          return this.client.request(config);
        }
      }
      const status = error?.response?.status;
      const retried = (config as any)?._retry429 ?? 0;
      if (
        status === 429 &&
        config &&
        !config.skipSuno429Retry &&
        isRetryableSunoRequest(config) &&
        retried < suno429MaxRetries()
      ) {
        (config as any)._retry429 = retried + 1;
        const delayMs = suno429DelayMs(retried + 1, error.response?.headers);
        const pathname = (() => {
          try {
            return new URL(config.url ?? '', SunoApi.BASE_URL).pathname;
          } catch {
            return 'Suno request';
          }
        })();
        logger.warn(
          `${pathname} returned 429; retry ${retried + 1}/${suno429MaxRetries()} ` +
          `in ${Math.round(delayMs)}ms`
        );
        await new Promise(r => setTimeout(r, delayMs));
        return this.client.request(config);
      }
      throw redactAxiosError(error);
    })
  }

  public async init(): Promise<SunoApi> {
    //await this.getClerkLatestVersion();
    await this.loadIdentity();
    await this.refreshAuth();
    await this.keepAlive();
    return this;
  }

  /**
   * Get the clerk package latest version id.
   * This method is commented because we are now using a hard-coded Clerk version, hence this method is not needed.
   
  private async getClerkLatestVersion() {
    // URL to get clerk version ID
    const getClerkVersionUrl = `${SunoApi.JSDELIVR_BASE_URL}/v1/package/npm/@clerk/clerk-js`;
    // Get clerk version ID
    const versionListResponse = await this.client.get(getClerkVersionUrl);
    if (!versionListResponse?.data?.['tags']['latest']) {
      throw new Error(
        'Failed to get clerk version info, Please try again later'
      );
    }
    // Save clerk version ID for auth
    SunoApi.clerkVersion = versionListResponse?.data?.['tags']['latest'];
  }
  */

  /**
   * Get the session ID and save it for later use.
   */
  public async refreshAuth(): Promise<void> {
    if (this.authRefreshPromise) return this.authRefreshPromise;
    const refresh = this.refreshAuthInternal();
    const shared = refresh.finally(() => {
      if (this.authRefreshPromise === shared) this.authRefreshPromise = undefined;
    });
    this.authRefreshPromise = shared;
    return shared;
  }

  private async refreshAuthInternal(): Promise<void> {
    logger.info('Getting the session ID');
    const getSessionUrl = this.buildClerkUrl('/v1/client');
    const sessionResponse = await this.client.get(getSessionUrl, {
      timeout: 10_000,
      headers: { Authorization: this.cookies.__client }
    });
    if (!sessionResponse?.data?.response?.last_active_session_id) {
      throw new Error(
        'Failed to get session id, you may need to update the SUNO_COOKIE'
      );
    }
    const sessionId = sessionResponse.data.response.last_active_session_id;
    this.sid = sessionId;
    const sessionToken = this.extractSessionJwt(sessionResponse.data, sessionId);
    if (!sessionToken) {
      throw new Error('Failed to get auth token, you may need to update the SUNO_COOKIE');
    }
    await this.setCurrentSessionToken(sessionToken);
    logger.info('Initial token extracted from /v1/client response');
  }

  /**
   * Keep the session alive.
   * @param isWait Indicates if the method should wait for the session to be fully renewed before returning.
   */
  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }
    // Token 未临近过期时跳过 Clerk /touch（此前每次轮询都刷新，上游请求被放大 3 倍）
    if (this.currentToken) {
      try {
        const payload = JSON.parse(
          Buffer.from(this.currentToken.split('.')[1], 'base64url').toString()
        );
        if (payload.exp && payload.exp * 1000 - Date.now() > 30_000) {
          return;
        }
      } catch {}
    }
    logger.info('KeepAlive...\n');
    const touchUrl = this.buildClerkUrl(`/v1/client/sessions/${this.sid}/touch`);
    const touchResponse = await this.client.post(touchUrl, undefined, {
      timeout: 10_000,
      headers: {
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://suno.com',
        referer: 'https://suno.com/'
      }
    });
    const newToken = this.extractSessionJwt(touchResponse.data, this.sid);
    if (!newToken) {
      throw new Error('Failed to refresh token');
    }
    if (isWait) {
      await sleep(1, 2);
    }
    // Update Authorization field in request header with the new JWT token
    await this.setCurrentSessionToken(newToken);
  }

  private async setCurrentSessionToken(sessionToken: string): Promise<void> {
    this.currentToken = sessionToken;
    const changed = applySunoSessionToken(this.cookies, sessionToken);
    if (changed && this.accountId) {
      await updateAccountCookie(this.accountId, this.serializeCookies());
    }
  }

  private buildClerkUrl(pathname: string): string {
    const url = new URL(pathname, SunoApi.CLERK_BASE_URL);
    url.searchParams.set('__clerk_api_version', '2025-11-10');
    url.searchParams.set('_clerk_js_version', SunoApi.CLERK_VERSION);
    return url.toString();
  }

  private serializeCookies(): string {
    return Object.entries(this.cookies)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => cookie.serialize(key, value as string))
      .join('; ');
  }

  private mergeSetCookies(setCookieHeaders: string[]): boolean {
    let changed = false;
    for (const header of setCookieHeaders) {
      const pair = this.parseSetCookiePair(header);
      if (!pair) continue;
      if (this.cookies[pair.name] !== pair.value) {
        this.cookies[pair.name] = pair.value;
        changed = true;
      }
    }
    return changed;
  }

  private parseSetCookiePair(setCookieHeader: string): { name: string; value: string } | undefined {
    const firstPart = setCookieHeader.split(';', 1)[0];
    const separatorIndex = firstPart.indexOf('=');
    if (separatorIndex <= 0) {
      return undefined;
    }
    return {
      name: firstPart.slice(0, separatorIndex),
      value: firstPart.slice(separatorIndex + 1)
    };
  }

  /**
   * Suno now returns an encrypted media URL and a forbidden placeholder in
   * `audio_url`. The public audio URL points to our decoder proxy, which uses
   * the authenticated Mango rights response to produce playable M4A bytes.
   */
  private static audioProxyBase(): string {
    return (process.env.SUNO_AUDIO_PROXY_BASE_URL ?? 'http://207.180.218.216:8005').replace(/\/$/, '');
  }

  /**
   * 取音频地址。音频尚未产生时返回空串。
   *
   * 不能无条件返回 audiopipe 地址：下游用 `所有 audio_url 非空` 判定任务完成，
   * submitted 阶段就给地址会让任务被判为提前完成（标题、歌词都还没生成）。
   * 所以严格对齐 Suno 自己的时序——它给了信号（media_urls 有内容，
   * 或 audio_url 非空，哪怕只是 forbidden 占位符）我们才给地址。
   *
   * The proxy keeps the session token server-side, so callers never need to
   * understand Suno's encrypted media format.
   */
  public static pickAudioUrl(audio: any): string {
    const id = audio?.id;
    if (!id) return '';
    const hasMedia = Array.isArray(audio?.media_urls) && audio.media_urls.length > 0;
    const hasLegacy = typeof audio?.audio_url === 'string' && audio.audio_url.length > 0;
    if (!hasMedia && !hasLegacy) return '';
    const status = typeof audio?.status === 'string' && audio.status
      ? audio.status
      : 'available';
    // The endpoint changes from a live WebM stream to a seekable completed
    // file. A versioned URL makes browsers reload instead of retaining a
    // failed/ended streaming media element when the clip becomes complete.
    return `${SunoApi.audioProxyBase()}/api/audio/${encodeURIComponent(String(id))}` +
      `?v=${encodeURIComponent(status)}`;
  }

  public static pickAudioMediaUrls(audio: any): AudioInfo['media_urls'] {
    const url = SunoApi.pickAudioUrl(audio);
    if (!url) return [];
    const source = Array.isArray(audio?.media_urls)
      ? audio.media_urls.find((item: any) => item?.url)
      : undefined;
    return [{
      url,
      content_type: source?.content_type ?? 'm4a-opus',
      delivery: source?.delivery === 'streaming' ? 'streaming' : 'progressive'
    }];
  }

  public async getDecodedAudio(clipId: string): Promise<{ body: Buffer; contentType: string }> {
    const clip: any = await this.getClip(clipId);
    const media = Array.isArray(clip?.media_urls) ? clip.media_urls : [];
    const encrypted = media.find((item: any) => item?.url && item?.encoding);
    const progressive = media.find((item: any) => item?.url && !item?.encoding && item?.delivery === 'progressive')
      ?? media.find((item: any) => item?.url && !item?.encoding);
    const source = encrypted ?? progressive ?? (clip?.audio_url && !String(clip.audio_url).includes('/api/forbidden')
      ? { url: clip.audio_url, content_type: 'mp3' }
      : undefined);
    if (!source?.url) throw new Error('Suno clip has no playable media URL');

    const response = await this.client.get<ArrayBuffer>(source.url, {
      responseType: 'arraybuffer',
      timeout: 180_000
    });
    const encryptedBytes = new Uint8Array(response.data);
    if (!encrypted) {
      const body = Buffer.from(encryptedBytes);
      return { body, contentType: audioContentType(body, source.content_type === 'mp3' ? 'audio/mpeg' : 'audio/mp4') };
    }

    if (!this.currentToken) throw new Error('Suno session token is unavailable');
    const rights = await this.client.post<{ key?: string; iv?: string }>(
      `${SunoApi.BASE_URL}/api/mango/rights`,
      { content_params: { content_id: clipId, content_type: 'clip' } },
      { timeout: 30_000 }
    );
    if (!rights.data?.key || !rights.data?.iv) throw new Error('Suno did not return audio decryption rights');
    const body = await decryptSunoAudio(encryptedBytes, rights.data.key, rights.data.iv, clipId, this.currentToken);
    return { body, contentType: audioContentType(body, 'audio/mp4') };
  }

  /**
   * Resolve Suno's live preview source. New streaming media can use Suno's
   * wrapped AES-CTR encoding, so decrypt it incrementally instead of buffering
   * the response and delaying the first playable WebM frame.
   */
  public async getStreamingAudio(clipId: string): Promise<{
    body: ReadableStream<Uint8Array>;
    contentType: string;
  } | undefined> {
    const clip: any = await this.getClip(clipId);
    // Completed clips must use the progressive source below getDecodedAudio().
    // It supports byte ranges and remains playable after the live stream ends.
    if (clip?.status === 'complete') return undefined;
    const media = Array.isArray(clip?.media_urls) ? clip.media_urls : [];
    const mediaSource = media.find((item: any) => item?.url && item?.delivery === 'streaming');
    let source = mediaSource?.url;
    if (!source && typeof clip?.audio_url === 'string' && /^https?:\/\/audiopipe(?:-dev)?\.suno\.ai\//.test(clip.audio_url)) {
      source = clip.audio_url;
    }
    if (!source) return undefined;

    const sourceUrl = new URL(source);
    if (/^audiopipe(?:-dev)?\.suno\.ai$/.test(sourceUrl.hostname)) {
      sourceUrl.searchParams.set('format', 'webm');
    }
    const rightsPromise = mediaSource?.encoding
      ? this.client.post<{ key?: string; iv?: string }>(
          `${SunoApi.BASE_URL}/api/mango/rights`,
          { content_params: { content_id: clipId, content_type: 'clip' } },
          { timeout: 30_000 }
        )
      : undefined;
    const response = await fetch(sourceUrl, {
      headers: { Accept: 'audio/webm, audio/*;q=0.9, */*' },
      cache: 'no-store'
    });
    if (!response.ok || !response.body) {
      throw new Error(`Suno streaming source returned HTTP ${response.status}`);
    }
    if (!rightsPromise) {
      return {
        body: response.body,
        contentType: response.headers.get('content-type')?.split(';', 1)[0] || 'audio/webm'
      };
    }
    if (!this.currentToken) throw new Error('Suno session token is unavailable');
    const rights = await rightsPromise;
    if (!rights.data?.key || !rights.data?.iv) throw new Error('Suno did not return streaming decryption rights');
    return {
      body: await decryptSunoAudioStream(
        response.body,
        rights.data.key,
        rights.data.iv,
        clipId,
        this.currentToken
      ),
      contentType: mediaSource?.content_type === 'webm-opus' ? 'audio/webm' : 'audio/mp4'
    };
  }

  private applyEgress(config: any) {
    if (config._egressDirect) {
      config._egressTunnel = false;
      config.httpAgent = undefined;
      config.httpsAgent = undefined;
      return;
    }
    let target: string | undefined;
    try {
      target = new URL(config.url ?? '', config.baseURL || SunoApi.BASE_URL).toString();
    } catch {
      target = undefined;
    }
    const egress = sunoEgressAgentFor(target);
    if (!egress) {
      config._egressTunnel = false;
      return;
    }
    config._egressTunnel = true;
    config.httpAgent = egress;
    config.httpsAgent = egress;
    config.proxy = false;
    // The operator tunnel adds several seconds per fresh TLS handshake.
    if (!config._egressTimeoutAdjusted && typeof config.timeout === 'number' && config.timeout > 0) {
      config._egressTimeoutAdjusted = true;
      config.timeout += sunoEgressExtraTimeoutMs();
    }
  }

  private isSunoUrl(url?: string): boolean {
    try {
      const hostname = new URL(url ?? '', SunoApi.BASE_URL).hostname;
      return hostname === 'suno.com' || hostname.endsWith('.suno.com');
    } catch {
      return false;
    }
  }

  /**
   * One account = one stable client: identical Device-Id, User-Agent and
   * client hints on every request and across restarts.
   */
  private applyIdentityHeaders(headers: Record<string, unknown>): void {
    const identity = this.browserIdentity;
    const userAgent = identity?.userAgent ?? this.userAgent ?? createBrowserUserAgent();
    const hints = createDesktopChromiumClientHints(userAgent);
    headers['User-Agent'] = userAgent;
    headers['sec-ch-ua'] = identity?.secChUa ?? hints['sec-ch-ua'];
    headers['sec-ch-ua-mobile'] = identity?.secChUaMobile ?? hints['sec-ch-ua-mobile'];
    headers['sec-ch-ua-platform'] = identity?.secChUaPlatform ?? hints['sec-ch-ua-platform'];
    headers['Device-Id'] = `"${this.syncDeviceId()}"`;
  }

  /** Follow the website's analytics id when the browser profile provides one. */
  private syncDeviceId(): string {
    const next = resolveDeviceId(this.cookies, this.deviceId ? { deviceId: this.deviceId } : undefined);
    if (next !== this.deviceId) {
      this.deviceId = next;
      void this.persistIdentity();
    }
    return next;
  }

  private async loadIdentity(): Promise<void> {
    if (!this.accountId) return;
    const stored = await loadSunoApiIdentity(this.accountId);
    this.browserIdentity = stored?.browser;
    const deviceId = resolveDeviceId(this.cookies, stored);
    const changed = deviceId !== stored?.deviceId;
    this.deviceId = deviceId;
    if (changed) await this.persistIdentity();
    logger.info({
      accountId: this.accountId,
      deviceIdSource: this.cookies.ajs_anonymous_id ? 'cookie' : stored ? 'persisted' : 'new',
      browserIdentity: Boolean(this.browserIdentity)
    }, 'Suno API client identity loaded');
  }

  private async persistIdentity(): Promise<void> {
    if (!this.accountId || !this.deviceId) return;
    await saveSunoApiIdentity(this.accountId, {
      deviceId: this.deviceId,
      browser: this.browserIdentity
    }).catch(() => logger.warn('Failed to persist Suno API identity'));
  }

  /** Adopt cookies and the real Chromium identity after a browser generation. */
  private async adoptBrowserResult(result: {
    cookies: Record<string, string>;
    browserIdentity?: CaptchaBrowserIdentity;
  }): Promise<void> {
    for (const [name, value] of Object.entries(result.cookies)) this.cookies[name] = value;
    this.browserIdentity = mergeBrowserIdentity(this.browserIdentity, result.browserIdentity);
    this.syncDeviceId();
    await updateAccountCookie(this.accountId!, this.serializeCookies());
    await this.persistIdentity();
  }

  private isClerkRequest(url?: string): boolean {
    return Boolean(url?.startsWith(SunoApi.CLERK_BASE_URL));
  }

  private isClerkClientRequest(url?: string): boolean {
    if (!url?.startsWith(SunoApi.CLERK_BASE_URL)) {
      return false;
    }
    return new URL(url).pathname === '/v1/client';
  }

  private extractSessionJwt(data: any, sessionId: string): string | undefined {
    const activeSession = data?.response?.id === sessionId
      ? data.response
      : this.findSessionById(data?.response?.sessions ?? data?.client?.sessions, sessionId);
    return activeSession?.last_active_token?.jwt;
  }

  private findSessionById(sessions: any, sessionId: string): any {
    if (!Array.isArray(sessions)) {
      return undefined;
    }
    return sessions.find((session: any) => session?.id === sessionId);
  }

  /**
   * Get the session token (not to be confused with session ID) and save it for later use.
   */
  private async getSessionToken() {
    const tokenResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/user/create_session_id/`,
      {
        session_properties: JSON.stringify({ deviceId: this.deviceId }),
        session_type: 1
      }
    );
    return tokenResponse.data.session_id;
  }

  private async getPrecheckedCaptchaToken(
    browserToken: string
  ): Promise<string | null | undefined> {
    try {
      const checkResp = await this.client.post(
        `${SunoApi.BASE_URL}/api/c/check`,
        { ctype: 'generation' },
        { timeout: 10_000, headers: { 'browser-token': browserToken } }
      );
      const checkToken = checkResp.data?.token ?? null;
      if (checkToken) {
        logger.info('Generation captcha pre-check returned a token');
        return checkToken;
      }
      if (!checkResp.data?.required) {
        return null;
      }
    } catch (error) {
      logger.warn('Captcha pre-check failed');
      throw redactAxiosError(error);
    }
    return undefined;
  }

  private async submitGenerateRequest(
    payload: SunoGeneratePayload
  ): Promise<SunoGenerateClip[]> {
    const accountKey = this.accountId || 'default';
    const browserCompatible = !payload.task && !payload.continue_clip_id &&
      !payload.cover_clip_id && !payload.audio_id;
    const createMode = payload.metadata && typeof payload.metadata === 'object'
      ? (payload.metadata as Record<string, unknown>).create_mode : undefined;
    const customPromptLength = typeof payload.prompt === 'string' ? payload.prompt.length : 0;
    const customTagsLength = typeof payload.tags === 'string' ? payload.tags.length : 0;
    const serverBrowserFallbackCompatible = browserCompatible &&
      payload.generation_type === 'TEXT' &&
      (createMode === 'simple' || createMode === 'custom') &&
      (typeof payload.gpt_description_prompt === 'string' || typeof payload.prompt === 'string') &&
      customPromptLength <= 5_000 && customTagsLength <= 1_000 &&
      !payload.user_uploaded_images_b64 &&
      (!payload.mv || payload.mv === 'chirp-hawk');
    if (process.env.SUNO_GENERATION_TRANSPORT === 'browser' && browserCompatible) {
      if (!this.accountId) throw new Error('Browser generation requires an account id');
      return runAccountGeneration(accountKey, async () => {
        const result = await generateWithSunoWebsite({
          accountId: this.accountId!,
          cookies: this.cookies,
          currentToken: this.currentToken,
          payload,
          signal: getCurrentSunoGenerationJob()?.signal,
          onSubmitted: () => markSunoGenerationSubmitted(),
          onAccepted: (clips) => markSunoGenerationAccepted(clips.map((clip) => clip.id)),
        });
        await this.adoptBrowserResult(result);
        // The official page already received and accepted the generation. Keep
        // the durable job checkpoint in sync so a process restart cannot replay
        // an already submitted browser generation.
        return result.clips;
      }, getCurrentSunoGenerationJob()?.signal);
    }
    return runAccountGeneration(accountKey, async () => {
      let browserToken = this.createBrowserToken();
      // Human-like spacing on top of the fixed minimum interval.
      const jitterMs = apiSubmitJitterMs();
      if (jitterMs > 0) {
        const signal = getCurrentSunoGenerationJob()?.signal;
        try {
          await delay(jitterMs, undefined, { signal });
        } catch (error) {
          signal?.throwIfAborted();
          throw error;
        }
      }
      // Set when Suno's own pre-check demands a captcha. In that state the server
      // browser shares the same datacenter IP/session risk and has always hit the
      // same challenge, so go straight to local browser recovery instead.
      let precheckCaptcha = false;
      const skipBrowserOnPrecheck = process.env.SUNO_SKIP_BROWSER_FALLBACK_ON_PRECHECK !== 'false';
      return submitWithCaptchaRecovery({
        enabled: process.env.SUNO_CAPTCHA_AUTO_RECOVER !== 'false',
        precheck: async () => {
          precheckCaptcha = false;
          getCurrentSunoGenerationJob()?.signal.throwIfAborted();
          await this.keepAlive();
          browserToken = this.createBrowserToken();
          try {
            const token = await this.getPrecheckedCaptchaToken(browserToken);
            if (token === undefined) {
              precheckCaptcha = true;
              logger.info({ accountId: accountKey, stats: recordApiSubmitOutcome('captcha') },
                'Suno API pre-check requires captcha');
            } else if (token) {
              recordApiSubmitOutcome('precheck_token');
            }
            return token;
          } catch (error) {
            if (isSunoCaptchaRejection(error)) {
              precheckCaptcha = true;
              logger.info({ accountId: accountKey, stats: recordApiSubmitOutcome('captcha') },
                'Suno API pre-check rejected with captcha');
            }
            throw error;
          }
        },
        submit: async (captchaToken) => {
          const job = getCurrentSunoGenerationJob();
          job?.signal.throwIfAborted();
          await markSunoGenerationSubmitted();
          const response = await this.client.post(
            `${SunoApi.BASE_URL}/api/generate/v2-web/`,
            { ...payload, token: captchaToken },
            // A short timeout can abandon a request Suno already accepted, which
            // later looks like a failure and invites a duplicate submission.
            { timeout: apiSubmitTimeoutMs(), signal: job?.signal, headers: { 'browser-token': browserToken }, skipSuno429Retry: true } as any
          ).catch(async (error) => {
            const captcha = isSunoCaptchaRejection(error);
            logger.info({
              accountId: accountKey,
              status: error?.response?.status,
              stats: recordApiSubmitOutcome(captcha ? 'captcha' : 'error')
            }, captcha ? 'Suno API submit rejected with captcha' : 'Suno API submit failed');
            if (captcha || (error?.response?.status >= 400 && error?.response?.status < 500)) {
              await markSunoGenerationRejected();
            }
            throw error;
          });
          const clips = validateSunoGenerateClips(
            response.data,
            response.status,
            response.status >= 200 && response.status < 300,
            'Suno Generate request'
          );
          markSunoGenerationAccepted(clips.map((clip) => clip.id));
          logger.info({ accountId: accountKey, clipCount: clips.length, stats: recordApiSubmitOutcome('accepted') },
            'Suno API submit accepted');
          return clips;
        },
        recover: async () => {
          if (process.env.SUNO_LOCAL_RECOVERY_FALLBACK !== 'true') {
            // 服务端求解器已经失败过；再等一个可能永远不来的本地浏览器只会白白耗掉超时。
            throw new Error('Local browser recovery disabled; server captcha solver could not recover');
          }
          logger.warn({ accountId: accountKey }, 'Suno captcha detected; waiting for local browser recovery');
          const job = getCurrentSunoGenerationJob();
          job?.signal.throwIfAborted();
          const pendingRecovery = waitForLocalSunoRecovery(accountKey, {
            requestId: job?.id,
            signal: job?.signal
          });
          // Persist the wakeup event first. SMS delivery must not delay the Mac.
          const block = markCaptchaRequired(accountKey);
          if (block.newlyBlocked) {
            void notifyCaptchaFailure({
              error: new SunoCaptchaManualInterventionError(),
              feishuNotifier: new FeishuNotifier(),
              formatError: () => 'API and server browser unavailable; local browser recovery requested'
            }).catch(() => logger.warn('Failed to send captcha notification'));
          }
          const result = await pendingRecovery.catch((error) => {
            throw error;
          });
          job?.signal.throwIfAborted();
          await this.refreshAuth();
          clearCaptchaCooldown(accountKey);
          logger.info({ accountId: accountKey, eventId: result.eventId, warmupClipIds: result.clipIds },
            'Suno local browser completed; rechecking and retrying original generation');
          await new Promise((resolve) => setTimeout(resolve, Math.min(generationMinIntervalMs(), 15_000)));
        },
        manualRequired: async (cause) => {
          const block = markCaptchaRequired(accountKey);
          const error = new SunoCaptchaManualInterventionError(block.retryAfterSeconds);
          logger.warn({ accountId: accountKey, reason: cause instanceof Error ? cause.message : undefined },
            'Suno captcha recovery failed; manual verification required');
          if (block.newlyBlocked) {
            // Notification transport must not extend the caller's generation timeout.
            void notifyCaptchaFailure({
              error,
              feishuNotifier: new FeishuNotifier(),
              formatError: (value) => value instanceof Error ? value.message : String(value)
            }).catch(() => logger.warn('Failed to send captcha notification'));
          }
          return error;
        },
        fallback: process.env.SUNO_SERVER_BROWSER_FALLBACK === 'true' && serverBrowserFallbackCompatible
          ? async (cause) => {
              if (!this.accountId) throw new Error('Server browser fallback requires an account id');
              const solverEnabled = process.env.SUNO_SERVER_BROWSER_SOLVER === 'true';
              if (skipBrowserOnPrecheck && precheckCaptcha && !solverEnabled) {
                logger.warn({ accountId: accountKey },
                  'Suno pre-check requires captcha; skipping server browser, requesting local browser recovery');
                // Nothing was submitted, so replaying after recovery is safe.
                throw Object.assign(
                  new Error('Suno pre-check requires captcha; server browser fallback skipped'),
                  { browserReplaySafe: true }
                );
              }
              logger.warn({ accountId: accountKey, reason: cause instanceof Error ? cause.message : undefined },
                solverEnabled
                  ? 'Suno API captcha rejected; falling back to server captcha solver'
                  : 'Suno API captcha rejected; falling back to server browser generation');
              const jobSignal = getCurrentSunoGenerationJob()?.signal;
              const result = solverEnabled
                ? await generateWithServerCaptchaSolver({
                    accountId: this.accountId,
                    cookies: this.cookies,
                    currentToken: this.currentToken,
                    payload,
                    signal: jobSignal
                  })
                : await generateWithSunoWebsite({
                    accountId: this.accountId,
                    cookies: this.cookies,
                    currentToken: this.currentToken,
                    payload,
                    signal: jobSignal,
                    onSubmitted: () => markSunoGenerationSubmitted(),
                    onAccepted: (clips) => markSunoGenerationAccepted(clips.map((clip) => clip.id))
                  });
              await this.adoptBrowserResult(result);
              if (solverEnabled) markSunoGenerationAccepted(result.clips.map((clip) => clip.id));
              logger.info({ accountId: accountKey, clipCount: result.clips.length,
                transport: solverEnabled ? 'solver' : 'website' },
                'Server browser fallback generation completed');
              return result.clips;
            }
          : undefined
      });
    }, getCurrentSunoGenerationJob()?.signal);
  }

  private createBrowserToken(): string {
    const payload = Buffer.from(JSON.stringify({ timestamp: Date.now() })).toString('base64');
    return JSON.stringify({ token: payload });
  }

  private async requestRawSuno(
    action: string,
    method: 'GET' | 'POST',
    pathname: string,
    data?: object
  ): Promise<object> {
    await this.keepAlive(false);
    const startTime = Date.now();
    try {
      const response = await this.client.request({
        method,
        url: `${SunoApi.BASE_URL}${pathname}`,
        data,
        timeout: 10000,
        headers: { 'browser-token': this.createBrowserToken() }
      });
      const mutationActions = new Set([
        'edit_crop', 'edit_fade', 'reverse_clip', 'remaster_upsample',
        'adjust_speed', 'concatenate'
      ]);
      const responseData = mutationActions.has(action)
        ? validateMutationResponse(action, response.data)
        : response.data;
      await recordRequest(action, this.accountId, true, Date.now() - startTime);
      return responseData;
    } catch (e: any) {
      await recordRequest(action, this.accountId, false, Date.now() - startTime, e?.message);
      throw e;
    }
  }

  public async createAudioUpload(
    request: SunoUploadAudioRequest
  ): Promise<SunoUploadAudioResponse> {
    await this.keepAlive(false);
    const startTime = Date.now();
    try {
      const response = await this.client.post(
        `${SunoApi.BASE_URL}/api/uploads/audio/`,
        {
          extension: request.extension,
          upload_type: request.upload_type || 'file_upload'
        },
        {
          timeout: 10000,
          headers: { 'browser-token': this.createBrowserToken() }
        }
      );
      await recordRequest('create_audio_upload', this.accountId, true, Date.now() - startTime);
      return response.data;
    } catch (e: any) {
      await recordRequest('create_audio_upload', this.accountId, false, Date.now() - startTime, e?.message);
      throw e;
    }
  }

  public async finishAudioUpload(
    uploadId: string,
    request: SunoUploadFinishRequest
  ): Promise<object> {
    await this.keepAlive(false);
    const startTime = Date.now();
    try {
      const response = await this.client.post(
        `${SunoApi.BASE_URL}/api/uploads/audio/${uploadId}/upload-finish/`,
        {
          upload_type: request.upload_type || 'file_upload',
          upload_filename: request.upload_filename
        },
        {
          timeout: 10000,
          headers: { 'browser-token': this.createBrowserToken() }
        }
      );
      await recordRequest('finish_audio_upload', this.accountId, true, Date.now() - startTime);
      return response.data;
    } catch (e: any) {
      await recordRequest('finish_audio_upload', this.accountId, false, Date.now() - startTime, e?.message);
      throw e;
    }
  }

  public async getAudioUpload(uploadId: string): Promise<object> {
    return this.requestRawSuno('get_audio_upload', 'GET', `/api/uploads/audio/${uploadId}/`);
  }

  public async initializeUploadClip(uploadId: string, body: object): Promise<object> {
    return this.requestRawSuno(
      'initialize_upload_clip',
      'POST',
      `/api/uploads/audio/${uploadId}/initialize-clip/`,
      body
    );
  }

  public async setClipMetadata(clipId: string, body: object): Promise<object> {
    return this.requestRawSuno(
      'set_clip_metadata',
      'POST',
      `/api/gen/${clipId}/set_metadata/`,
      body
    );
  }

  public async setAudioDescription(clipId: string, body: object): Promise<object> {
    return this.requestRawSuno(
      'set_audio_description',
      'POST',
      `/api/gen/${clipId}/set_audio_description`,
      body
    );
  }

  public async getWaveformAggregates(clipId: string): Promise<object> {
    return this.requestRawSuno(
      'get_waveform_aggregates',
      'GET',
      `/api/gen/${clipId}/waveform-aggregates`
    );
  }

  public async getAlignedLyrics(clipId: string): Promise<object> {
    return this.requestRawSuno(
      'get_aligned_lyrics',
      'GET',
      `/api/gen/${clipId}/aligned_lyrics/v2/`
    );
  }

  /**
   * Crop（裁剪）：保留或移除指定区间。
   * POST /api/edit/crop/{clipId}/ → 拿 action_clip_id 后立即返回 { action_clip_id }；
   * 生成进度由调用方主动轮询 GET /api/edit/action/{action_clip_id}/。
   */
  public async crop(
    clipId: string,
    body: {
      crop_start_s: number;
      crop_end_s: number;
      is_crop_remove?: boolean;
      title?: string;
      ui_surface?: string;
    }
  ): Promise<object> {
    const cropResp = (await this.requestRawSuno(
      'edit_crop',
      'POST',
      `/api/edit/crop/${clipId}/`,
      {
        crop_start_s: body.crop_start_s,
        crop_end_s: body.crop_end_s,
        is_crop_remove: body.is_crop_remove ?? false,
        // 仅 Remove Section 会带 title（"... (Remove Section)"），Crop 不带
        ...(body.title ? { title: body.title } : {}),
        ui_surface: body.ui_surface ?? 'song_actions'
      }
    )) as { action_clip_id?: string };

    const actionClipId = cropResp?.action_clip_id;
    if (!actionClipId) {
      throw new Error('Crop failed: missing action_clip_id');
    }
    // 转发即返回，不在后端阻塞轮询；由调用方（前端）主动轮询 /api/edit/action/{id} 拿结果。
    return { action_clip_id: actionClipId };
  }

  /**
   * Fade（淡入/淡出）：POST /api/edit/fade/{clipId}/ → 拿 action_clip_id 后立即返回。
   * 传 fade_in_time（淡入结束秒）或 fade_out_time（淡出开始秒）。
   * 生成进度由调用方主动轮询 GET /api/edit/action/{action_clip_id}/。
   */
  public async fade(
    clipId: string,
    body: { fade_in_time?: number; fade_out_time?: number; title?: string }
  ): Promise<object> {
    const data: Record<string, unknown> = {};
    if (body.fade_in_time != null) data.fade_in_time = body.fade_in_time;
    if (body.fade_out_time != null) data.fade_out_time = body.fade_out_time;
    if (body.title) data.title = body.title;
    const resp = (await this.requestRawSuno(
      'edit_fade',
      'POST',
      `/api/edit/fade/${clipId}/`,
      data
    )) as { action_clip_id?: string };
    const actionClipId = resp?.action_clip_id;
    if (!actionClipId) {
      throw new Error('Fade failed: missing action_clip_id');
    }
    // 转发即返回，不在后端阻塞轮询。
    return { action_clip_id: actionClipId };
  }

  /**
   * 查询 edit action（fade/crop 等）的生成状态。供前端主动轮询。
   * GET /api/edit/action/{actionClipId}/ → 返回上游状态对象（含 status，完成时含 clip 信息）。
   */
  public async getEditAction(actionClipId: string): Promise<object> {
    return this.requestRawSuno(
      'edit_action',
      'GET',
      `/api/edit/action/${actionClipId}/`
    );
  }

  /**
   * Reverse（反转整首）：调用 reverse-clip 接口，直接返回新 clip（status=processing，无需轮询）。
   */
  public async reverse(clipId: string, title?: string): Promise<object> {
    return this.requestRawSuno('reverse_clip', 'POST', '/api/clips/reverse-clip/', {
      clip_id: clipId,
      ...(title ? { title } : {})
    });
  }

  /**
   * Remaster（重制/upsample）：用指定模型重新渲染，返回一批（通常 2 首）新 clip，
   * status=submitted/running，无需轮询（前端刷新作品库即可）。
   */
  public async remaster(
    clipId: string,
    body: { model_name: string; variation_category?: string }
  ): Promise<object> {
    return this.requestRawSuno('remaster_upsample', 'POST', '/api/generate/upsample', {
      clip_id: clipId,
      model_name: body.model_name,
      variation_category: body.variation_category ?? 'normal'
    });
  }

  /**
   * Adjust Speed（变速）：直接返回新 clip（status=processing，无需轮询）。
   */
  public async adjustSpeed(
    clipId: string,
    body: { speed_multiplier: number; keep_pitch?: boolean; title?: string }
  ): Promise<object> {
    return this.requestRawSuno('adjust_speed', 'POST', '/api/clips/adjust-speed/', {
      clip_id: clipId,
      speed_multiplier: body.speed_multiplier,
      keep_pitch: body.keep_pitch ?? false,
      ...(body.title ? { title: body.title } : {})
    });
  }

  public async getPromptSuggestions(): Promise<PromptSuggestionsResponse> {
    return this.requestRawSuno(
      'get_prompt_suggestions',
      'GET',
      '/api/prompts/suggestions'
    ) as Promise<PromptSuggestionsResponse>;
  }

  public async upsamplePrompt(
    request: PromptUpsampleRequest
  ): Promise<PromptUpsampleResponse> {
    return this.requestRawSuno(
      'upsample_prompt',
      'POST',
      '/api/prompts/upsample',
      request
    ) as Promise<PromptUpsampleResponse>;
  }

  /**
   * Generate a song based on the prompt.
   * @param prompt The text prompt to generate audio from.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @returns
   */
  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    options?: SunoGenerateOptions,
    custom?: {
      tags?: string;
      title?: string;
      negative_tags?: string;
    }
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const startTime = Date.now();
    try {
      const isCustom = custom !== undefined;
      const audios = await this.generateSongs(
        prompt,
        isCustom,
        custom?.tags,
        custom?.title,
        make_instrumental,
        model,
        wait_audio,
        custom?.negative_tags,
        options?.task,
        undefined,
        undefined,
        options
      );
      const costTime = Date.now() - startTime;
      logger.info({ accountId: this.accountId, clipCount: audios.length, elapsedMs: costTime }, 'Generate completed');
      await recordRequest('generate', this.accountId, true, costTime);
      return audios;
    } catch (e: any) {
      await recordRequest('generate', this.accountId, false, Date.now() - startTime, e?.message);
      throw e;
    }
  }

  /**
   * Calls the concatenate endpoint for a clip to generate the whole song.
   * @param clip_id The ID of the audio clip to concatenate.
   * @returns A promise that resolves to an AudioInfo object representing the concatenated audio.
   * @throws Error if the response status is not 200.
   */
  public async concatenate(clip_id: string): Promise<AudioInfo> {
    await this.keepAlive(false);
    const payload: any = { clip_id: clip_id };
    const startTime = Date.now();
    try {
      const response = await this.client.post(
        `${SunoApi.BASE_URL}/api/generate/concat/v2/`,
        payload,
        {
          timeout: 10_000 // 10 seconds timeout
        }
      );
      if (response.status !== 200) {
        throw new Error('Error response:' + response.statusText);
      }
      await recordRequest('concatenate', this.accountId, true, Date.now() - startTime);
      return validateMutationResponse('concatenate', response.data);
    } catch (e: any) {
      await recordRequest('concatenate', this.accountId, false, Date.now() - startTime, e?.message);
      throw e;
    }
  }

  /**
   * Generates custom audio based on provided parameters.
   *
   * @param prompt The text prompt to generate audio from.
   * @param tags Tags to categorize the generated audio.
   * @param title The title for the generated audio.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated audios.
   */
  public async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    options?: SunoGenerateOptions
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    try {
      const audios = await this.generateSongs(
        prompt,
        true,
        tags,
        title,
        make_instrumental,
        model,
        wait_audio,
        negative_tags,
        options?.task,
        undefined,
        undefined,
        options
      );
      const costTime = Date.now() - startTime;
      logger.info({ accountId: this.accountId, clipCount: audios.length, elapsedMs: costTime }, 'Custom generate completed');
      await recordRequest('custom_generate', this.accountId, true, costTime);
      return audios;
    } catch (e: any) {
      await recordRequest('custom_generate', this.accountId, false, Date.now() - startTime, e?.message);
      throw e;
    }
  }

  public async cover_generate(
    prompt: string,
    title: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    options?: SunoGenerateOptions
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    try {
      const audios = await this.generateSongs(
        prompt,
        true,
        undefined,
        title,
        make_instrumental,
        model,
        wait_audio,
        undefined,
        options?.task,
        undefined,
        undefined,
        options
      );
      const costTime = Date.now() - startTime;
      logger.info({ accountId: this.accountId, clipCount: audios.length, elapsedMs: costTime }, 'Cover generate completed');
      await recordRequest('cover_generate', this.accountId, true, costTime);
      return audios;
    } catch (e: any) {
      await recordRequest('cover_generate', this.accountId, false, Date.now() - startTime, e?.message);
      throw e;
    }
  }

  /**
   * Generates songs based on the provided parameters.
   *
   * @param prompt The text prompt to generate songs from.
   * @param isCustom Indicates if the generation should consider custom parameters like tags and title.
   * @param tags Optional tags to categorize the song, used only if isCustom is true.
   * @param title Optional title for the song, used only if isCustom is true.
   * @param make_instrumental Indicates if the generated song should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @param task Optional indication of what to do. Enter 'extend' if extending an audio, otherwise specify null.
   * @param continue_clip_id 
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated songs.
   */
  private async generateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    make_instrumental?: boolean,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    task?: string,
    continue_clip_id?: string,
    continue_at?: number,
    options?: SunoGenerateOptions
  ): Promise<AudioInfo[]> {
    await this.keepAlive();
    const payload: any = {
      make_instrumental: make_instrumental,
      mv: model || DEFAULT_MODEL,
      prompt: '',
      generation_type: options?.generation_type || 'TEXT',
      continue_at: continue_at,
      continue_clip_id: continue_clip_id,
      continued_aligned_prompt: null,
      task: task,
      token: null,
      token_provider: null,
      transaction_uuid: randomUUID(),
      user_uploaded_images_b64: null,
      cover_clip_id: null,
      cover_start_s: null,
      cover_end_s: null,
      persona_id: null,
      artist_clip_id: null,
      artist_start_s: null,
      artist_end_s: null,
      override_fields: [],
      metadata: {
        web_client_pathname: '/create',
        is_max_mode: false,
        create_mode: isCustom ? 'custom' : 'simple',
        disable_volume_normalization: false,
        lyrics_model: 'default'
      }
    };
    mergeDefinedGenerateOptions(payload, options);
    mergeDefinedMetadata(payload.metadata, options?.metadata);
    if (isCustom) {
      if (tags !== undefined) {
        payload.tags = tags;
      }
      if (title !== undefined) {
        payload.title = title;
      }
      if (negative_tags !== undefined) {
        payload.negative_tags = negative_tags;
      }
      payload.prompt = prompt;
      if (options?.gpt_description_prompt !== undefined) {
        payload.gpt_description_prompt = options.gpt_description_prompt;
      }
    } else if (
      options?.gpt_description_prompt === undefined &&
      prompt !== ''
    ) {
      payload.gpt_description_prompt = prompt;
    }
    const clips = await this.submitGenerateRequest(payload);
    const songIds = clips.map((audio) => audio.id);
    //Want to wait for music file generation
    if (wait_audio) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(5, 5);
      while (Date.now() - startTime < 100000) {
        const response = await this.get(songIds);
        const hasAllSongs = response.length === songIds.length && songIds.every((id) =>
          response.some((audio) => audio.id === id)
        );
        const allCompleted = hasAllSongs && response.every(
          (audio) => audio.status === 'streaming' || audio.status === 'complete'
        );
        const allError = hasAllSongs && response.every((audio) => audio.status === 'error');
        if (allCompleted || allError) {
          return response;
        }
        lastResponse = response;
        await sleep(3, 6);
        await this.keepAlive(true);
      }
      return lastResponse;
    } else {
      return clips.map((audio: any) => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt,
        audio_url: SunoApi.pickAudioUrl(audio),
        media_urls: SunoApi.pickAudioMediaUrls(audio),
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: audio.metadata.gpt_description_prompt,
        prompt: audio.metadata.prompt,
        type: audio.metadata.type,
        tags: audio.metadata.tags,
        negative_tags: audio.metadata.negative_tags,
        duration: audio.metadata.duration
      }));
    }
  }

  /**
   * Generates lyrics based on a given prompt.
   * @param prompt The prompt for generating lyrics.
   * @returns The generated lyrics text.
   */
  public async generateLyrics(prompt: string): Promise<string> {
    await this.keepAlive(false);
    const startTime = Date.now();
    try {
      // Initiate lyrics generation
      const generateResponse = await this.client.post(
        `${SunoApi.BASE_URL}/api/generate/lyrics/`,
        { prompt },
        { timeout: 10_000 }
      );
      const generateId = requireId(generateResponse?.data?.id, 'Lyrics generation');
      const lyricsData = await this.pollLyricsResult(generateId, 'Lyrics');

      await recordRequest('generate_lyrics', this.accountId, true, Date.now() - startTime);
      // Return the generated lyrics text
      return lyricsData;
    } catch (e: any) {
      await recordRequest('generate_lyrics', this.accountId, false, Date.now() - startTime, e?.message);
      throw e;
    }
  }

  /**
   * 将两首歌的歌词混合（Mashup）。
   * 调用 /api/generate/lyrics-mashup 创建任务，再轮询 /api/generate/lyrics/{mashup_id} 直到完成。
   * @param lyricsA 第一首歌词
   * @param lyricsB 第二首歌词
   * @param source 可选来源标识（透传给上游，默认 null）
   * @returns 最终的歌词对象（含 text/title/status 等）
   */
  public async generateLyricsMashup(
    lyricsA: string,
    lyricsB: string,
    source: string | null = null
  ): Promise<object> {
    await this.keepAlive(false);
    const startTime = Date.now();
    try {
      // 创建 mashup 歌词任务
      const createResponse = await this.client.post(
        `${SunoApi.BASE_URL}/api/generate/lyrics-mashup`,
        { lyrics_a: lyricsA, lyrics_b: lyricsB, source },
        { timeout: 10_000 }
      );
      const mashupId = requireId(createResponse?.data?.mashup_id, 'Lyrics mashup');
      const lyricsData = await this.pollLyricsResult(mashupId, 'Mashup lyrics');

      await recordRequest('generate_lyrics_mashup', this.accountId, true, Date.now() - startTime);
      return lyricsData;
    } catch (e: any) {
      await recordRequest(
        'generate_lyrics_mashup',
        this.accountId,
        false,
        Date.now() - startTime,
        e?.message
      );
      throw e;
    }
  }

  /** Poll a lyrics task with a bounded lifetime and validated envelopes. */
  private async pollLyricsResult(taskId: string, operation: string): Promise<any> {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        const error = new Error(`${operation} polling timed out after 120 seconds`) as Error & { code: string; statusCode: number };
        error.code = 'SUNO_POLL_TIMEOUT';
        error.statusCode = 504;
        throw error;
      }
      const response = await this.client.get(
        `${SunoApi.BASE_URL}/api/generate/lyrics/${encodeURIComponent(taskId)}`,
        { timeout: Math.min(10_000, remainingMs), signal: AbortSignal.timeout(remainingMs) }
      );
      const data = requireObject(response?.data, operation);
      const status = data.status;
      if (typeof status !== 'string' || status.trim() === '') {
        throw invalidSunoResponse(operation, 'missing status');
      }
      if (status === 'complete') return data;
      if (status === 'error' || status === 'failed' || status === 'cancelled') {
        const error = new Error(`${operation} generation failed (status=${status})`) as Error & { code: string; statusCode: number };
        error.code = 'SUNO_GENERATION_FAILED';
        error.statusCode = 502;
        throw error;
      }
      await sleep(Math.min(2, Math.max(0, deadline - Date.now()) / 1000));
    }
  }

  /**
   * Extends an existing audio clip by generating additional content based on the provided prompt.
   *
   * @param audioId The ID of the audio clip to extend.
   * @param prompt The prompt for generating additional content.
   * @param continueAt Extend a new clip from a song at mm:ss(e.g. 00:30). Default extends from the end of the song.
   * @param tags Style of Music.
   * @param title Title of the song.
   * @returns A promise that resolves to an AudioInfo object representing the extended audio clip.
   */
  public async extendAudio(
    audioId: string,
    prompt: string = '',
    continueAt: number | undefined,
    tags: string = '',
    negative_tags: string = '',
    title: string = '',
    model?: string,
    wait_audio?: boolean,
    options?: SunoGenerateOptions
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    try {
      const result = await this.generateSongs(prompt, true, tags, title, false, model, wait_audio, negative_tags, 'extend', audioId, continueAt, options);
      await recordRequest('extend_audio', this.accountId, true, Date.now() - startTime);
      return result;
    } catch (e: any) {
      await recordRequest('extend_audio', this.accountId, false, Date.now() - startTime, e?.message);
      throw e;
    }
  }

  /**
   * Generate stems for a song.
   * @param song_id The ID of the song to generate stems for.
   * @returns A promise that resolves to an AudioInfo object representing the generated stems.
   */
  public async generateStems(song_id: string): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const startTime = Date.now();
    try {
      const response = await this.client.post(
        `${SunoApi.BASE_URL}/api/edit/stems/${song_id}`, {}
      );
      const clips = requireArray(response?.data?.clips, 'clips', 'Generate stems');
      const result = clips.map((clip: any, index: number) => {
        const value = requireObject(clip, `Generate stems clips[${index}]`);
        const metadata = requireObject(value.metadata, `Generate stems clips[${index}].metadata`);
        return {
          id: requireId(value.id, `Generate stems clips[${index}]`),
          status: requireId(value.status, `Generate stems clips[${index}]`),
          created_at: requireId(value.created_at, `Generate stems clips[${index}]`),
          title: typeof value.title === 'string' ? value.title : undefined,
          stem_from_id: typeof metadata.stem_from_id === 'string' ? metadata.stem_from_id : undefined,
          duration: metadata.duration == null ? undefined : String(metadata.duration),
          model_name: typeof value.model_name === 'string' ? value.model_name : DEFAULT_SOUND_MODEL
        };
      });
      logger.info({ accountId: this.accountId, clipCount: result.length, elapsedMs: Date.now() - startTime }, 'Generate stems completed');
      await recordRequest('generate_stems', this.accountId, true, Date.now() - startTime);
      return result;
    } catch (e: any) {
      await recordRequest('generate_stems', this.accountId, false, Date.now() - startTime, e?.message);
      throw e;
    }
  }


  /**
   * Get the lyric alignment for a song.
   * @param song_id The ID of the song to get the lyric alignment for.
   * @returns A promise that resolves to an object containing the lyric alignment.
   */
  public async getLyricAlignment(song_id: string): Promise<object> {
    await this.keepAlive(false);
    const startTime = Date.now();
    try {
      const response = await this.client.get(`${SunoApi.BASE_URL}/api/gen/${song_id}/aligned_lyrics/v2/`);
      const alignedWords = requireArray(response?.data?.aligned_words, 'aligned_words', 'Get lyric alignment');
      const result = alignedWords.map((transcribedWord: any, index: number) => {
        const value = requireObject(transcribedWord, `Get lyric alignment aligned_words[${index}]`);
        const word = requireId(value.word, `Get lyric alignment aligned_words[${index}]`);
        const startS = value.start_s;
        const endS = value.end_s;
        if (typeof startS !== 'number' || typeof endS !== 'number' ||
            !Number.isFinite(startS) || !Number.isFinite(endS)) {
          throw new Error(`Get lyric alignment aligned_words[${index}]: invalid timing`);
        }
        return {
          word,
          start_s: startS,
          end_s: endS,
          success: Boolean(value.success),
          p_align: typeof value.p_align === 'number' ? value.p_align : undefined
        };
      });
      logger.info({ accountId: this.accountId, wordCount: result.length, elapsedMs: Date.now() - startTime }, 'Lyric alignment fetched');
      await recordRequest('get_aligned_lyrics', this.accountId, true, Date.now() - startTime);
      return result;
    } catch (e: any) {
      await recordRequest('get_aligned_lyrics', this.accountId, false, Date.now() - startTime, e?.message);
      throw e;
    }
  }

  /**
   * Processes the lyrics (prompt) from the audio metadata into a more readable format.
   * @param prompt The original lyrics text.
   * @returns The processed lyrics text.
   */
  private parseLyrics(prompt: string): string {
    // Assuming the original lyrics are separated by a specific delimiter (e.g., newline), we can convert it into a more readable format.
    // The implementation here can be adjusted according to the actual lyrics format.
    // For example, if the lyrics exist as continuous text, it might be necessary to split them based on specific markers (such as periods, commas, etc.).
    // The following implementation assumes that the lyrics are already separated by newlines.

    // Split the lyrics using newline and ensure to remove empty lines.
    const lines = prompt.split('\n').filter((line) => line.trim() !== '');

    // Reassemble the processed lyrics lines into a single string, separated by newlines between each line.
    // Additional formatting logic can be added here, such as adding specific markers or handling special lines.
    return lines.join('\n');
  }

  /**
   * Retrieves audio information for the given song IDs.
   * @param songIds An optional array of song IDs to retrieve information for.
   * @param page An optional page number to retrieve audio information from.
   * @returns A promise that resolves to an array of AudioInfo objects.
   */
  public async get(
    songIds?: string[],
    page?: string | null
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const cacheKey = [
      this.accountId || 'default',
      songIds?.slice().sort().join(',') || '',
      page || ''
    ].join('|');
    const cached = audioStatusCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const existing = audioStatusInflight.get(cacheKey);
    if (existing) return existing;

    const request = this.fetchAudioStatus(songIds, page)
      .then((value) => {
        audioStatusCache.set(cacheKey, {
          expiresAt: Date.now() + audioStatusCacheTtlMs(),
          value
        });
        if (audioStatusCache.size > 1_000) {
          const now = Date.now();
          for (const [key, entry] of audioStatusCache) {
            if (entry.expiresAt <= now || audioStatusCache.size > 1_000) {
              audioStatusCache.delete(key);
            }
          }
        }
        return value;
      })
      .catch((error) => {
        if (cached && Date.now() - cached.expiresAt <= 60_000) {
          logger.warn(`Returning stale audio status after upstream failure: ${String(error)}`);
          return cached.value;
        }
        throw error;
      });
    audioStatusInflight.set(cacheKey, request);
    try {
      return await request;
    } finally {
      if (audioStatusInflight.get(cacheKey) === request) {
        audioStatusInflight.delete(cacheKey);
      }
    }
  }

  private async fetchAudioStatus(
    songIds?: string[],
    page?: string | null
  ): Promise<AudioInfo[]> {
    const browserToken = JSON.stringify({ token: Buffer.from(JSON.stringify({ timestamp: Date.now() })).toString('base64') });
    const url = `${SunoApi.BASE_URL}/api/feed/v3`;
    const body: any = {};
    if (songIds && songIds.length > 0) {
      body.filters = { ids: { presence: 'True', clipIds: songIds } };
      body.limit = songIds.length;
    } else if (page) {
      body.page = page;
    }
    logger.debug({ accountId: this.accountId, hasSongFilter: Boolean(songIds?.length), page: page || undefined }, 'Fetching audio status');
    const _getStartTime = Date.now();
    let _getResponse: any;
    try {
      _getResponse = await runSunoStatusRequest(
        this.accountId || 'default',
        () => this.client.post(url, body, {
          timeout: 10000,
          headers: { 'browser-token': browserToken }
        })
      );
    } catch (e: any) {
      await recordRequest('get', this.accountId, false, Date.now() - _getStartTime, e?.message);
      throw e;
    }
    await recordRequest('get', this.accountId, true, Date.now() - _getStartTime);
    const response = _getResponse;
    const audios = requireArray(response?.data?.clips, 'clips', 'Get audio status');

    return audios.map((audio: any, index: number) => {
      const value = requireObject(audio, `Get audio status clips[${index}]`);
      const metadata = requireObject(value.metadata ?? {}, `Get audio status clips[${index}].metadata`);
      return ({
      id: requireId(value.id, `Get audio status clips[${index}]`),
      title: typeof value.title === 'string' ? value.title : undefined,
      image_url: typeof value.image_url === 'string' ? value.image_url : undefined,
      lyric: metadata.prompt
        ? this.parseLyrics(String(metadata.prompt))
        : '',
      audio_url: SunoApi.pickAudioUrl(value),
      media_urls: SunoApi.pickAudioMediaUrls(value),
      video_url: typeof value.video_url === 'string' ? value.video_url : undefined,
      created_at: typeof value.created_at === 'string' ? value.created_at : '',
      model_name: typeof value.model_name === 'string' ? value.model_name : DEFAULT_SOUND_MODEL,
      status: typeof value.status === 'string' ? value.status : 'unknown',
      gpt_description_prompt: typeof metadata.gpt_description_prompt === 'string' ? metadata.gpt_description_prompt : undefined,
      prompt: typeof metadata.prompt === 'string' ? metadata.prompt : undefined,
      type: typeof metadata.type === 'string' ? metadata.type : undefined,
      tags: typeof metadata.tags === 'string' ? metadata.tags : undefined,
      duration: metadata.duration,
      error_message: typeof metadata.error_message === 'string' ? metadata.error_message : undefined
    });
    });
  }

  /**
   * Retrieves information for a specific audio clip.
   * @param clipId The ID of the audio clip to retrieve information for.
   * @returns A promise that resolves to an object containing the audio clip information.
   */
  public async getClip(clipId: string): Promise<object> {
    await this.keepAlive(false);
    const startTime = Date.now();
    try {
      const response = await this.client.get(
        `${SunoApi.BASE_URL}/api/clip/${clipId}`
      );
      await recordRequest('get_clip', this.accountId, true, Date.now() - startTime);
      return response.data;
    } catch (e: any) {
      await recordRequest('get_clip', this.accountId, false, Date.now() - startTime, e?.message);
      throw e;
    }
  }

  public async get_credits(): Promise<object> {
    await this.keepAlive(false);
    const startTime = Date.now();
    try {
      const response = await this.client.get(
        `${SunoApi.BASE_URL}/api/billing/info/`
      );
      await recordRequest('get_credits', this.accountId, true, Date.now() - startTime);
      return {
        credits_left: response.data.total_credits_left,
        period: response.data.period,
        monthly_limit: response.data.monthly_limit,
        monthly_usage: response.data.monthly_usage
      };
    } catch (e: any) {
      await recordRequest('get_credits', this.accountId, false, Date.now() - startTime, e?.message);
      throw e;
    }
  }

  public async getModels(): Promise<any[]> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/billing/info/`
    );
    return response.data.models ?? [];
  }

  public async getPersonaPaginated(personaId: string, page: number = 1): Promise<PersonaResponse> {
    await this.keepAlive(false);
    
    const url = `${SunoApi.BASE_URL}/api/persona/get-persona-paginated/${personaId}/?page=${page}`;
    
    logger.info(`Fetching persona data: ${url}`);
    
    const response = await this.client.get(url, {
      timeout: 10000 // 10 seconds timeout
    });

    if (response.status !== 200) {
      throw new Error('Error response: ' + response.statusText);
    }

    return response.data;
  }
}

export const sunoApi = async (accountId?: string) => {
  await ensureLoaded();
  const account = accountId ? await getAccountById(accountId) : await pickAccount();
  if (!account) {
    throw new Error(
      accountId
        ? `账号 ${accountId} 不存在。`
        : '未配置账号，请先通过管理页面 /admin 或 POST /api/accounts 接口添加账号。'
    );
  }

  const cached = cache.get(account.id);
  if (cached) return cached;

  const instance = await new SunoApi(account.cookie, account.id).init();
  cache.set(account.id, instance);
  return instance;
};
