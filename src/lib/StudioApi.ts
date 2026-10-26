import { randomUUID } from 'node:crypto';

/** Experimental Studio wire API. Shares the caller's Suno session; never retries POSTs. */
export type StudioRequest = (path: string, method: 'GET' | 'POST', data?: unknown) => Promise<any>;
export class StudioError extends Error {
  constructor(public code: string, public status = 400, public submissionUnknown = false) {
    super(code);
  }
}

function requireInput(condition: unknown, code: string): asserts condition {
  if (!condition) throw new StudioError(code);
}
export function studioId(value: unknown): string {
  requireInput(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value), 'INVALID_ID');
  return value;
}
function text(value: unknown, name: string, required = false): string {
  requireInput(value === undefined || typeof value === 'string', `INVALID_${name}`);
  const result = (value as string | undefined) ?? '';
  requireInput(!required || result.trim().length > 0, `MISSING_${name}`);
  return result;
}
export interface StudioGenerateInput {
  project_id: string;
  prompt: string;
  tags: string;
  title?: string;
  model?: string;
}
export interface StudioExportInput {
  project_id: string;
  clip_id: string;
  duration_seconds: number;
  /** Current Studio state containing an audio track/clip to use as a schema template. */
  state: Record<string, any>;
  title?: string;
  lyrics?: string;
  tags?: string;
}

/** Clone a current schema template, strip other tracks/warping, and export the full source. */
export function fullSongState(input: StudioExportInput) {
  studioId(input.project_id); studioId(input.clip_id);
  requireInput(typeof input.duration_seconds === 'number' && Number.isFinite(input.duration_seconds) &&
    input.duration_seconds > 0 && input.duration_seconds <= 480, 'INVALID_DURATION');
  requireInput(input.state && Array.isArray(input.state.tracks), 'INVALID_STATE');
  const state = JSON.parse(JSON.stringify(input.state));
  const track = state.tracks.find((item: any) => item?.type === 'audio' && Array.isArray(item.clips) && item.clips.length);
  requireInput(track, 'AUDIO_CLIP_TEMPLATE_REQUIRED');
  const clip = track.clips[0];
  requireInput(clip && typeof clip === 'object' && !Array.isArray(clip), 'INVALID_CLIP_TEMPLATE');
  const end = input.duration_seconds * 2;
  Object.assign(clip, { id: randomUUID(), asset: { type: 'clip', id: input.clip_id }, clipId: input.clip_id,
    streaming: false, startBeats: 0, endBeats: end, readStartBeats: 0,
    mute: false, amplitude: 1, fadeInBeats: 0, fadeOutBeats: 0,
    generatedInPlace: false, awaitingContentAlignment: false,
    warp: { enabled: false, awaitingAnalysis: false }, loop: { enabled: false, startBeats: 0, endBeats: end } });
  Object.assign(track, { id: randomUUID(), clips: [clip], mute: false, solo: false, amplitude: 1,
    takeLanes: [], soloTakeLaneId: null });
  Object.assign(state, { tracks: [track], timing: { type: 'manual', bps: 2, bpsAutomation: [], firstBeatSeconds: 0 },
    actors: {}, lyricsCorrectionsByClipId: {}, takePreviews: {}, sections: [],
    songFadeInBeats: 0, songFadeOutBeats: 0 });
  return { state, end };
}

export class StudioApi {
  constructor(private request: StudioRequest, private userId: () => string) {}

  private async ownedProject(id: string) {
    const project = await this.request(`studio/project/${studioId(id)}`, 'GET');
    requireInput(project?.owner_user_id === this.userId(), 'PROJECT_OWNER_MISMATCH');
    return project;
  }

  public async getProject(id: string) { return this.ownedProject(id); }

  public async generate(input: StudioGenerateInput) {
    const projectId = studioId(input.project_id);
    const prompt = text(input.prompt, 'PROMPT', true);
    const tags = text(input.tags, 'TAGS', true);
    const title = text(input.title, 'TITLE');
    const model = text(input.model ?? 'chirp-hawk', 'MODEL', true);
    requireInput(tags.length <= 1000, 'STYLE_TOO_LONG');
    await this.ownedProject(projectId);
    const captcha = await this.request('c/check', 'POST', { ctype: 'generation' });
    // Fail closed; no browser or paid CAPTCHA solver is invoked by Studio methods.
    requireInput(captcha?.required === false, 'CAPTCHA_REQUIRED');
    return this.request('generate/v2-web/', 'POST', {
      token: null, token_provider: 2, task: 'agentic_instant', generation_type: 'TEXT', mv: model,
      prompt: '', gpt_description_prompt: `${title}. ${tags}`, make_instrumental: false,
      attached_lyrics: prompt, attached_styles: tags, transaction_uuid: randomUUID(),
      user_uploaded_images_b64: null, override_fields: [], cover_clip_id: null,
      cover_start_s: null, cover_end_s: null, persona_id: null, artist_clip_id: null,
      artist_start_s: null, artist_end_s: null, continue_clip_id: null,
      continued_aligned_prompt: null, continue_at: null,
      metadata: { from_studio_project_id: projectId, create_session_token: randomUUID(),
        web_client_pathname: '/studio', create_surface: 'studio', create_mode: 'simple',
        disable_volume_normalization: false, lyrics_model: 'default' }
    });
  }

  /** Poll both source and rendered clip IDs; return provider statuses/errors unchanged. */
  public async get(ids: string[]) {
    requireInput(Array.isArray(ids) && ids.length > 0 && ids.length <= 50, 'INVALID_IDS');
    ids.forEach(studioId);
    return this.request('feed/v3', 'POST', {
      filters: { ids: { presence: 'True', clipIds: ids } }, limit: ids.length
    });
  }

  public async export(input: StudioExportInput) {
    const { state, end } = fullSongState(input);
    const title = text(input.title, 'TITLE');
    const lyrics = text(input.lyrics, 'LYRICS');
    const tags = text(input.tags, 'TAGS');
    await this.ownedProject(input.project_id);
    const feed = await this.get([input.clip_id]);
    const clip = feed?.clips?.find((item: any) => item.id === input.clip_id);
    requireInput(clip?.status === 'complete', 'SOURCE_NOT_COMPLETE');
    requireInput(Math.abs(Number(clip.metadata?.duration) - input.duration_seconds) < 0.25, 'SOURCE_DURATION_MISMATCH');
    return this.request('studio/render-state', 'POST', {
      title, lyrics, tags, negative_tags: '', style_summary: '', caption: '', state,
      start_beats: 0, end_beats: end, project_id: null, studio_project_id: input.project_id,
      studio_project_version_id: null, web_client_pathname: '/studio',
      export_mode: 'fullsong_export', render_engine: 'v2'
    });
  }

  /** Return a prepared signed URL. Download it WITHOUT the Suno client's credentials. */
  public async getDownload(id: string) {
    studioId(id);
    const result = await this.request(`download/clip/${id}?format=m4a`, 'GET');
    if (result?.download_url) {
      let url: URL;
      try { url = new URL(result.download_url); } catch { throw new StudioError('INVALID_DOWNLOAD_URL', 502); }
      requireInput(url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        url.hostname === 'suno-data-uploads.s3.amazonaws.com' &&
        (url.pathname === `/studio/uploads/${id}_lyrics.m4a` || url.pathname.startsWith(`/studio/uploads/${id}/`)), 'UNEXPECTED_DOWNLOAD_DESTINATION');
    }
    return result;
  }
}
