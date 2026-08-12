import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  generateMiniMaxMusicCover,
  MiniMaxMusicApiError,
  validateMiniMaxMusicCoverRequest
} from './MiniMaxMusicApi';

describe('MiniMax music cover', () => {
  it('accepts each cover input source independently', () => {
    assert.doesNotThrow(() =>
      validateMiniMaxMusicCoverRequest(
        { model: 'music-cover', audio_url: 'https://example.com/audio.mp3' },
        'global'
      )
    );
    assert.doesNotThrow(() =>
      validateMiniMaxMusicCoverRequest(
        { model: 'music-cover-free', audio_base64: 'dGVzdA==' },
        'global'
      )
    );
  });

  it('requires exactly one cover input source', () => {
    for (const request of [
      { model: 'music-cover' as const },
      {
        model: 'music-cover' as const,
        audio_url: 'https://example.com/audio.mp3',
        audio_base64: 'dGVzdA=='
      }
    ]) {
      assert.throws(
        () => validateMiniMaxMusicCoverRequest(request, 'global'),
        MiniMaxMusicApiError
      );
    }
  });

  it('enforces streaming and regional fields', () => {
    assert.throws(
      () =>
        validateMiniMaxMusicCoverRequest(
          {
            model: 'music-cover',
            audio_url: 'https://example.com/audio.mp3',
            stream: true,
            output_format: 'url'
          },
          'global'
        ),
      /hex/
    );
    assert.throws(
      () =>
        validateMiniMaxMusicCoverRequest(
          {
            model: 'music-cover',
            audio_url: 'https://example.com/audio.mp3',
            aigc_watermark: true
          },
          'global'
        ),
      /China/
    );
  });

  it('posts to the selected endpoint and handles a successful response', async () => {
    let requestedUrl = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      requestedUrl = input.toString();
      assert.equal(init?.method, 'POST');
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        'Bearer test-key'
      );
      return Response.json({
        data: { status: 2, audio: 'abc123' },
        base_resp: { status_code: 0 }
      });
    };

    const result = await generateMiniMaxMusicCover(
      {
        model: 'music-cover',
        audio_url: 'https://example.com/audio.mp3',
        output_format: 'hex'
      },
      { apiKey: 'test-key', region: 'china', fetch: fetchImpl }
    );

    assert.equal(requestedUrl, 'https://api.minimaxi.com/v1/music_generation');
    assert.equal(result.data.audio, 'abc123');
  });

  it('rejects an unsuccessful provider response', async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({
        data: { status: 1 },
        base_resp: { status_code: 1001, status_msg: 'Invalid request' }
      });

    await assert.rejects(
      generateMiniMaxMusicCover(
        {
          model: 'music-cover',
          audio_url: 'https://example.com/audio.mp3'
        },
        { apiKey: 'test-key', fetch: fetchImpl }
      ),
      /Invalid request/
    );
  });
});
