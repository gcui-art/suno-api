import { NextRequest, NextResponse } from 'next/server';
import { loadModels, getModelsSnapshot } from '@/lib/modelStore';
import { fetchAndSaveModels } from '@/lib/scheduler';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * GET /api/models
 * 返回本地缓存的模型列表及最后更新时间
 */
export async function GET() {
  await loadModels();
  const snapshot = await getModelsSnapshot();
  return NextResponse.json(snapshot, { headers: corsHeaders });
}

/**
 * POST /api/models/refresh（通过同一路由 action 参数区分）
 * 手动触发立即更新模型列表
 */
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  if (url.searchParams.get('action') !== 'refresh') {
    return NextResponse.json({ error: '未知操作，请使用 ?action=refresh' }, { status: 400, headers: corsHeaders });
  }

  const diff = await fetchAndSaveModels();
  if (diff === null) {
    return NextResponse.json(
      { error: '更新失败，请确认已添加账号' },
      { status: 500, headers: corsHeaders }
    );
  }

  const snapshot = await getModelsSnapshot();
  return NextResponse.json(
    { ...snapshot, diff },
    { headers: corsHeaders }
  );
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}
