export const MINIMAX_MUSIC_COVER_LIMITS = {
  minimumDurationSeconds: 6,
  maximumDurationSeconds: 360,
  maximumInputBytes: 50 * 1024 * 1024
} as const;

export type MiniMaxMusicRegion = 'global' | 'china';
export type MiniMaxMusicCoverModel = 'music-cover' | 'music-cover-free';
export type MiniMaxMusicOutputFormat = 'url' | 'hex';
export type MiniMaxMusicAudioFormat = 'mp3' | 'wav' | 'pcm';

export interface MiniMaxMusicAudioSetting {
  sample_rate?: number;
  bitrate?: number;
  format?: MiniMaxMusicAudioFormat;
  channel?: number;
}

export interface MiniMaxMusicCoverRequest {
  model: MiniMaxMusicCoverModel;
  prompt?: string;
  lyrics?: string;
  stream?: boolean;
  output_format?: MiniMaxMusicOutputFormat;
  audio_setting?: MiniMaxMusicAudioSetting;
  lyrics_optimizer?: boolean;
  is_instrumental?: boolean;
  audio_url?: string;
  audio_base64?: string;
  cover_feature_id?: string;
  aigc_watermark?: boolean;
}

export interface MiniMaxMusicCoverResponse {
  data: {
    status: 1 | 2;
    audio?: string;
    [key: string]: unknown;
  };
  base_resp: {
    status_code: number;
    status_msg?: string;
  };
}

export class MiniMaxMusicApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'MiniMaxMusicApiError';
  }
}

const endpoints: Record<MiniMaxMusicRegion, string> = {
  global: 'https://api.minimax.io/v1/music_generation',
  china: 'https://api.minimaxi.com/v1/music_generation'
};

const coverModels = new Set<MiniMaxMusicCoverModel>([
  'music-cover',
  'music-cover-free'
]);
const audioFormats = new Set<MiniMaxMusicAudioFormat>(['mp3', 'wav', 'pcm']);

function base64ByteLength(value: string): number {
  const normalized = value.replace(/\s/g, '');
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new MiniMaxMusicApiError('audio_base64 must be valid base64', 400);
  }

  const padding = normalized.endsWith('==')
    ? 2
    : normalized.endsWith('=')
      ? 1
      : 0;
  return (normalized.length * 3) / 4 - padding;
}

export function validateMiniMaxMusicCoverRequest(
  request: MiniMaxMusicCoverRequest,
  region: MiniMaxMusicRegion
): void {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new MiniMaxMusicApiError('Request body must be a JSON object', 400);
  }

  if (!coverModels.has(request.model)) {
    throw new MiniMaxMusicApiError(
      'model must be music-cover or music-cover-free',
      400
    );
  }

  const hasAudioUrl =
    typeof request.audio_url === 'string' &&
    request.audio_url.trim().length > 0;
  const hasAudioBase64 =
    typeof request.audio_base64 === 'string' &&
    request.audio_base64.trim().length > 0;
  if (hasAudioUrl === hasAudioBase64) {
    throw new MiniMaxMusicApiError(
      'Provide exactly one of audio_url or audio_base64',
      400
    );
  }

  if (hasAudioBase64) {
    const inputBytes = base64ByteLength(request.audio_base64!);
    if (inputBytes > MINIMAX_MUSIC_COVER_LIMITS.maximumInputBytes) {
      throw new MiniMaxMusicApiError('Cover audio must not exceed 50 MB', 400);
    }
  }

  if (request.stream && request.output_format === 'url') {
    throw new MiniMaxMusicApiError(
      'Streaming cover output must use the hex output format',
      400
    );
  }

  const audioFormat = request.audio_setting?.format;
  if (audioFormat && !audioFormats.has(audioFormat)) {
    throw new MiniMaxMusicApiError(
      'audio_setting.format must be mp3, wav, or pcm',
      400
    );
  }

  if (region !== 'china' && request.aigc_watermark !== undefined) {
    throw new MiniMaxMusicApiError(
      'aigc_watermark is available only with the China endpoint',
      400
    );
  }
}

function getRegion(value: string | undefined): MiniMaxMusicRegion {
  const region = value || 'global';
  if (region !== 'global' && region !== 'china') {
    throw new MiniMaxMusicApiError(
      'MINIMAX_REGION must be global or china',
      500
    );
  }
  return region;
}

function isMiniMaxMusicCoverResponse(
  value: unknown
): value is MiniMaxMusicCoverResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<MiniMaxMusicCoverResponse>;
  return (
    !!response.base_resp &&
    typeof response.base_resp.status_code === 'number' &&
    !!response.data &&
    (response.data.status === 1 || response.data.status === 2)
  );
}

export interface MiniMaxMusicClientOptions {
  apiKey?: string;
  region?: MiniMaxMusicRegion;
  fetch?: typeof fetch;
}

export async function generateMiniMaxMusicCover(
  request: MiniMaxMusicCoverRequest,
  options: MiniMaxMusicClientOptions = {}
): Promise<MiniMaxMusicCoverResponse> {
  const apiKey = options.apiKey || process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    throw new MiniMaxMusicApiError('MINIMAX_API_KEY is not configured', 500);
  }

  const region = options.region || getRegion(process.env.MINIMAX_REGION);
  validateMiniMaxMusicCoverRequest(request, region);

  const fetchImpl = options.fetch || fetch;
  const response = await fetchImpl(endpoints[region], {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(request)
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new MiniMaxMusicApiError(
      'MiniMax returned an invalid JSON response',
      response.ok ? 502 : response.status
    );
  }

  if (!response.ok) {
    throw new MiniMaxMusicApiError(
      'MiniMax music cover request failed',
      response.status
    );
  }
  if (!isMiniMaxMusicCoverResponse(payload)) {
    throw new MiniMaxMusicApiError(
      'MiniMax returned an invalid music cover response',
      502
    );
  }
  if (payload.base_resp.status_code !== 0) {
    throw new MiniMaxMusicApiError(
      payload.base_resp.status_msg || 'MiniMax music cover request failed',
      502
    );
  }

  return payload;
}
