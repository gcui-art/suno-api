import { NextRequest, NextResponse } from 'next/server';

import {
  generateMiniMaxMusicCover,
  MiniMaxMusicApiError,
  MiniMaxMusicCoverRequest
} from '@/lib/MiniMaxMusicApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as MiniMaxMusicCoverRequest;
    const result = await generateMiniMaxMusicCover(body);
    return NextResponse.json(result, { status: 200, headers: corsHeaders });
  } catch (error) {
    const status = error instanceof MiniMaxMusicApiError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : 'Music cover request failed';
    return NextResponse.json(
      { error: message },
      { status, headers: corsHeaders }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
