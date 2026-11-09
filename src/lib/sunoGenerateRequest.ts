import type {
  SunoGenerateMetadata,
  SunoGenerateOptions
} from '@/lib/SunoApi';
import { DEFAULT_MODEL, DEFAULT_SOUND_MODEL } from '@/lib/SunoApi';

type MetadataKey = keyof SunoGenerateMetadata;
type GenerateOptionKey = keyof Omit<SunoGenerateOptions, 'metadata'>;

const METADATA_KEYS: MetadataKey[] = [
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
  'lyrics_model',
  'infill_lyrics',
  'lyrics_updated'
];

const GENERATE_OPTION_KEYS: GenerateOptionKey[] = [
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

function copyDefinedMetadata(
  target: SunoGenerateMetadata,
  source: Record<string, unknown>
) {
  for (const key of METADATA_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      target[key] = value as never;
    }
  }
}

export function getSunoGenerateOptions(
  body: Record<string, unknown>
): SunoGenerateOptions | undefined {
  const metadata: SunoGenerateMetadata = {};
  const options: SunoGenerateOptions = {};
  const requestMetadata = body.metadata;

  if (requestMetadata && typeof requestMetadata === 'object') {
    copyDefinedMetadata(metadata, requestMetadata as Record<string, unknown>);
  }

  copyDefinedMetadata(metadata, body);

  for (const key of GENERATE_OPTION_KEYS) {
    const value = body[key];
    if (value !== undefined) {
      options[key] = value as never;
    }
  }

  if (Object.keys(metadata).length > 0) {
    options.metadata = metadata;
  }

  if (Object.keys(options).length === 0) {
    return undefined;
  }

  return options;
}

export interface SunoGenerateModeRequest {
  prompt: string;
  tags?: string;
  title?: string;
  make_instrumental: boolean;
  model: string;
  wait_audio: boolean;
  negative_tags?: string;
  options?: SunoGenerateOptions;
  isCustom: boolean;
}

function applySoundConfigShortcuts(
  metadata: SunoGenerateMetadata,
  body: Record<string, unknown>
) {
  const soundConfigs = {
    ...(metadata.sound_configs ?? {})
  };

  if (body.tempo !== undefined) {
    soundConfigs.user_tempo = Number(body.tempo);
  }
  if (body.user_tempo !== undefined) {
    soundConfigs.user_tempo = Number(body.user_tempo);
  }
  if (body.key !== undefined) {
    soundConfigs.user_key = String(body.key);
  }
  if (body.user_key !== undefined) {
    soundConfigs.user_key = String(body.user_key);
  }
  if (body.loop !== undefined) {
    soundConfigs.user_loop = Boolean(body.loop);
  }
  if (body.user_loop !== undefined) {
    soundConfigs.user_loop = Boolean(body.user_loop);
  }
  if (Object.keys(soundConfigs).length > 0) {
    metadata.sound_configs = soundConfigs;
  }
}

function normalizeGenerateOptions(
  body: Record<string, unknown>,
  options: SunoGenerateOptions
) {
  const metadata = { ...(options.metadata ?? {}) };
  applySoundConfigShortcuts(metadata, body);
  const hasCoverClipId = isNonEmptyString(body.cover_clip_id);

  if (body.task === 'sound') {
    options.task = 'sound';
    metadata.create_mode = metadata.create_mode ?? 'custom';
  }
  if (body.task === 'cover' || hasCoverClipId) {
    options.task = 'cover';
    options.generation_type = options.generation_type ?? 'SIMPLE_REMIX';
    options.override_fields = options.override_fields ?? ['prompt'];
    metadata.is_remix = metadata.is_remix ?? true;
    metadata.create_mode = metadata.create_mode ?? 'simple';
  }
  if (body.task === 'mashup_condition' || hasMashupClipIds(body)) {
    options.task = 'mashup_condition';
    options.generation_type = options.generation_type ?? 'TEXT';
    options.override_fields = options.override_fields ?? [];
    metadata.create_mode = metadata.create_mode ?? 'custom';
  }
  if (body.task === 'chop_sample_condition' || isNonEmptyString(body.chop_sample_clip_id)) {
    options.task = 'chop_sample_condition';
    options.generation_type = options.generation_type ?? 'TEXT';
    options.override_fields = options.override_fields ?? [];
    metadata.create_mode = metadata.create_mode ?? 'custom';
    delete metadata.is_remix;
    delete metadata.lyrics_model;
    delete metadata.vocal_gender;
  }
  if (Object.keys(metadata).length > 0) {
    options.metadata = metadata;
  }
}

export function getSunoGenerateModeRequest(
  body: Record<string, unknown>
): SunoGenerateModeRequest {
  const options = getSunoGenerateOptions(body) ?? {};
  normalizeGenerateOptions(body, options);

  const task = options.task ?? body.task;
  const isSound = task === 'sound';
  const isCover = task === 'cover' || isNonEmptyString(body.cover_clip_id);
  const isMashup = task === 'mashup_condition' || hasMashupClipIds(body);
  const isSample = task === 'chop_sample_condition' || isNonEmptyString(body.chop_sample_clip_id);
  const isCustom =
    isSound || isCover || isMashup || isSample || body.tags !== undefined || body.title !== undefined;

  return {
    prompt: String(body.prompt ?? ''),
    tags: body.tags === undefined ? undefined : String(body.tags),
    title: body.title === undefined ? undefined : String(body.title),
    make_instrumental: isSound ? true : Boolean(body.make_instrumental),
    model: String(body.mv ?? body.model ?? (isSound || isCover || isSample ? DEFAULT_SOUND_MODEL : DEFAULT_MODEL)),
    wait_audio: Boolean(body.wait_audio),
    negative_tags: body.negative_tags === undefined ? undefined : String(body.negative_tags),
    options,
    isCustom
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasMashupClipIds(body: Record<string, unknown>): boolean {
  return Array.isArray(body.mashup_clip_ids) && body.mashup_clip_ids.length > 0;
}
