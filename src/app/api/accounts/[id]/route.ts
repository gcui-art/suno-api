import { NextRequest, NextResponse } from 'next/server';
import {
  ensureLoaded,
  getAccountById,
  removeAccount,
  updateAccountCookie,
  toggleAccount,
} from '@/lib/accountStore';
import { cache } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** GET /api/accounts/[id] — 获取单个账号（含完整 cookie） */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  await ensureLoaded();
  const account = await getAccountById(params.id);
  if (!account) {
    return NextResponse.json({ error: '账号不存在' }, { status: 404, headers: corsHeaders });
  }
  return NextResponse.json(account, { headers: corsHeaders });
}

/** PATCH /api/accounts/[id] — 更新账号（action: 'toggle' | 'updateCookie'） */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  await ensureLoaded();
  const account = await getAccountById(params.id);
  if (!account) {
    return NextResponse.json({ error: '账号不存在' }, { status: 404, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action, cookie } = body as { action: string; cookie?: string };

    if (action === 'toggle') {
      const enabled = await toggleAccount(params.id);
      return NextResponse.json({ id: params.id, enabled }, { headers: corsHeaders });
    }

    if (action === 'updateCookie') {
      if (!cookie || !cookie.trim()) {
        return NextResponse.json({ error: 'Cookie 不能为空' }, { status: 400, headers: corsHeaders });
      }
      await updateAccountCookie(params.id, cookie);
      // 清除该账号的 SunoApi 缓存，下次请求重新初始化
      cache.delete(params.id);
      return NextResponse.json({ success: true }, { headers: corsHeaders });
    }

    return NextResponse.json({ error: '未知 action' }, { status: 400, headers: corsHeaders });
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error: ' + error },
      { status: 500, headers: corsHeaders }
    );
  }
}

/** DELETE /api/accounts/[id] — 删除账号 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  await ensureLoaded();
  const deleted = await removeAccount(params.id);
  if (!deleted) {
    return NextResponse.json({ error: '账号不存在' }, { status: 404, headers: corsHeaders });
  }
  // 清除该账号的 SunoApi 缓存
  cache.delete(params.id);
  return NextResponse.json({ success: true }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}
