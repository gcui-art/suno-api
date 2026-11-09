import { NextRequest, NextResponse } from 'next/server';
import { ensureLoaded, getAccounts, addAccount } from '@/lib/accountStore';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** GET /api/accounts — 获取所有账号列表 */
export async function GET() {
  await ensureLoaded();
  const accounts = (await getAccounts()).map(a => ({
    ...a,
    cookie: a.cookie.slice(0, 30) + '...', // 隐藏完整 cookie，仅展示前缀
  }));
  return NextResponse.json(accounts, { headers: corsHeaders });
}

/** POST /api/accounts — 添加新账号 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, cookie } = body as { email?: string; cookie?: string };
    if (!email || !email.trim()) {
      return NextResponse.json({ error: '邮箱不能为空' }, { status: 400, headers: corsHeaders });
    }
    if (!cookie || !cookie.trim()) {
      return NextResponse.json({ error: 'Cookie 不能为空' }, { status: 400, headers: corsHeaders });
    }
    const account = await addAccount(email, cookie);
    return NextResponse.json(
      { ...account, cookie: account.cookie.slice(0, 30) + '...' },
      { status: 201, headers: corsHeaders }
    );
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error: ' + error },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}
