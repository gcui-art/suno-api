import { NextRequest, NextResponse } from 'next/server';
import { getMonitorStats, getRecentLogs, purgeOldLogs } from '@/lib/requestMonitor';
import { corsHeaders } from '@/lib/utils';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const hoursParam = searchParams.get('hours');
  const hours = hoursParam ? Math.max(1, Math.min(720, parseInt(hoursParam, 10) || 24)) : 24;
  const view = searchParams.get('view');

  try {
    if (view === 'logs') {
      const limitParam = searchParams.get('limit');
      const limit = limitParam ? Math.max(1, Math.min(200, parseInt(limitParam, 10) || 50)) : 50;
      const logs = await getRecentLogs(limit);
      return NextResponse.json(logs, { headers: corsHeaders });
    }

    const stats = await getMonitorStats(hours);
    return NextResponse.json(stats, { headers: corsHeaders });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500, headers: corsHeaders });
  }
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const daysParam = searchParams.get('days');
  const days = daysParam ? Math.max(1, parseInt(daysParam, 10) || 30) : 30;
  try {
    const deleted = await purgeOldLogs(days);
    return NextResponse.json({ deleted }, { headers: corsHeaders });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500, headers: corsHeaders });
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}
