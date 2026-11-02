/**
 * Validation for responses returned by Suno mutation endpoints.
 *
 * These endpoints are private and occasionally return an HTML challenge page
 * or an otherwise valid JSON error envelope with a 2xx status.  Letting those
 * values flow into route handlers turns a useful upstream failure into a
 * TypeError (and can make callers submit the mutation again).  The validator
 * deliberately checks only the fields that the callers rely on and returns
 * the original value unchanged so additional fields/envelopes are preserved.
 */

export class SunoUpstreamResponseError extends Error {
  public readonly statusCode = 502;
  public readonly code = 'SUNO_UPSTREAM_INVALID_RESPONSE';

  constructor(public readonly action: string, reason: string) {
    super(`Suno ${action} returned an invalid response: ${reason}`);
    this.name = 'SunoUpstreamResponseError';
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasId(value: unknown): boolean {
  return isRecord(value) && nonEmptyString(value.id);
}

function hasActionClipId(value: unknown): boolean {
  return isRecord(value) && nonEmptyString(value.action_clip_id);
}

function isClipArray(value: unknown): value is RecordValue[] {
  return Array.isArray(value) && value.length > 0 && value.every(hasId);
}

/**
 * Validate a response from a state-changing Suno endpoint.
 *
 * The return value is the original object/array.  Callers can therefore keep
 * any fields added by Suno while still getting a typed, actionable error when
 * a challenge page or malformed envelope is returned with HTTP 2xx.
 */
export function validateMutationResponse<T>(action: string, data: T): T {
  const name = action.trim() || 'mutation';

  switch (name) {
    case 'edit_crop':
    case 'edit_fade':
      if (!hasActionClipId(data)) {
        throw new SunoUpstreamResponseError(name, 'missing action_clip_id');
      }
      break;

    case 'reverse_clip':
    case 'adjust_speed':
    case 'concat':
    case 'concatenate':
      if (!hasId(data)) {
        throw new SunoUpstreamResponseError(name, 'missing clip id');
      }
      break;

    case 'remaster_upsample': {
      const clips = Array.isArray(data)
        ? data
        : isRecord(data) ? data.clips : undefined;
      if (!isClipArray(clips)) {
        throw new SunoUpstreamResponseError(name, 'missing non-empty clips array');
      }
      break;
    }

    default:
      // requestRawSuno also handles reads and no-content mutations. Their
      // schemas are not covered here, so preserve their current behaviour.
      break;
  }

  return data;
}
