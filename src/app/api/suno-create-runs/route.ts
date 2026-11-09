import { NextRequest, NextResponse } from 'next/server';
import { getRecentSunoCreateRuns, purgeOldSunoCreateRuns } from '@/lib/sunoCreateRunStore';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limitParam = searchParams.get('limit');
  const limit = limitParam ? Math.max(1, Math.min(200, parseInt(limitParam, 10) || 50)) : 50;

  try {
    const runs = await getRecentSunoCreateRuns(limit);
    return NextResponse.json(runs, { headers: corsHeaders });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500, headers: corsHeaders });
  }
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const daysParam = searchParams.get('days');
  const days = daysParam ? Math.max(1, parseInt(daysParam, 10) || 30) : 30;

  try {
    const deleted = await purgeOldSunoCreateRuns(days);
    return NextResponse.json({ deleted }, { headers: corsHeaders });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500, headers: corsHeaders });
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}
