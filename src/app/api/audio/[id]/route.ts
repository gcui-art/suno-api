import { NextRequest, NextResponse } from 'next/server';
import { sunoApi } from '@/lib/SunoApi';
import { audioContentType } from '@/lib/sunoAudio';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

interface AudioCacheEntry {
  expiresAt: number;
  body: Buffer;
  contentType: string;
}

const globalAudio = global as unknown as {
  sunoDecodedAudioCache?: Map<string, AudioCacheEntry>;
};
const audioCache = globalAudio.sunoDecodedAudioCache ?? new Map<string, AudioCacheEntry>();
globalAudio.sunoDecodedAudioCache = audioCache;

const CACHE_TTL_MS = 30 * 60 * 1000;

function parseRange(value: string | null, size: number): [number, number] | null {
  if (!value?.startsWith('bytes=') || value.includes(',')) return null;
  const [startText, endText] = value.slice(6).split('-', 2);
  if (!startText && !endText) return null;
  let start: number;
  let end: number;
  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(startText, 10);
    end = endText ? Number.parseInt(endText, 10) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return [start, end];
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  if (!/^[A-Za-z0-9-]{1,120}$/.test(params.id)) {
    return NextResponse.json({ error: 'Invalid clip id' }, { status: 400, headers: corsHeaders });
  }

  try {
    let entry = audioCache.get(params.id);
    if (entry && entry.expiresAt > Date.now()) {
      const range = parseRange(req.headers.get('range'), entry.body.length);
      const headers = {
        ...corsHeaders,
        'Content-Type': entry.contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=1800',
        'Content-Disposition': `inline; filename="${params.id}.m4a"`
      };
      if (!range) {
        return new NextResponse(entry.body, {
          status: 200,
          headers: { ...headers, 'Content-Length': String(entry.body.length) }
        });
      }
      const [start, end] = range;
      const body = entry.body.subarray(start, end + 1);
      return new NextResponse(body, {
        status: 206,
        headers: {
          ...headers,
          'Content-Length': String(body.length),
          'Content-Range': `bytes ${start}-${end}/${entry.body.length}`
        }
      });
    }

    const api = await sunoApi();
    const streaming = await api.getStreamingAudio(params.id);
    if (streaming) {
      return new Response(streaming.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': streaming.contentType,
          'Cache-Control': 'no-store'
        }
      });
    }

    {
      const result = await api.getDecodedAudio(params.id);
      entry = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        body: result.body,
        contentType: result.contentType || audioContentType(result.body)
      };
      audioCache.set(params.id, entry);
      if (audioCache.size > 256) {
        const now = Date.now();
        for (const [key, cached] of audioCache) {
          if (cached.expiresAt <= now || audioCache.size > 256) audioCache.delete(key);
        }
      }
    }

    const range = parseRange(req.headers.get('range'), entry.body.length);
    const headers = {
      ...corsHeaders,
      'Content-Type': entry.contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=1800',
      'Content-Disposition': `inline; filename="${params.id}.m4a"`
    };
    if (!range) {
      return new NextResponse(entry.body, {
        status: 200,
        headers: { ...headers, 'Content-Length': String(entry.body.length) }
      });
    }

    const [start, end] = range;
    const body = entry.body.subarray(start, end + 1);
    return new NextResponse(body, {
      status: 206,
      headers: {
        ...headers,
        'Content-Length': String(body.length),
        'Content-Range': `bytes ${start}-${end}/${entry.body.length}`
      }
    });
  } catch (error: any) {
    console.error('Error serving decoded audio:', error);
    const status = error?.response?.status === 404 ? 404 : 502;
    return NextResponse.json(
      { error: 'Unable to retrieve or decode audio', detail: error?.message || String(error) },
      { status, headers: corsHeaders }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
