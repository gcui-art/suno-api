import { NextRequest, NextResponse } from 'next/server';
import { ensureLoaded, getAccountById } from '@/lib/accountStore';
import { sunoApi } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** GET /api/accounts/[id]/songs — 获取指定账号的歌曲列表 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  await ensureLoaded();
  const account = await getAccountById(params.id);
  if (!account) {
    return NextResponse.json({ error: '账号不存在' }, { status: 404, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const page = url.searchParams.get('page') ?? '1';

  try {
    const api = await sunoApi(params.id);
    const songs = await api.get(undefined, page);
    return NextResponse.json(songs, { headers: corsHeaders });
  } catch (error) {
    return NextResponse.json(
      { error: '获取歌曲列表失败: ' + error },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}
