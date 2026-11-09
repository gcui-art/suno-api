import { NextRequest, NextResponse } from 'next/server';
import { ensureLoaded, getAccountById, updateAccountCredits, AccountCredits } from '@/lib/accountStore';
import { sunoApi } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** POST /api/accounts/[id]/refresh — 刷新指定账号的积分信息 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  await ensureLoaded();
  const account = await getAccountById(params.id);
  if (!account) {
    return NextResponse.json({ error: '账号不存在' }, { status: 404, headers: corsHeaders });
  }

  try {
    const api = await sunoApi(params.id);
    const credits = await api.get_credits() as AccountCredits;
    await updateAccountCredits(params.id, credits);
    return NextResponse.json(credits, { headers: corsHeaders });
  } catch (error) {
    return NextResponse.json(
      { error: '刷新积分失败: ' + error },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}
