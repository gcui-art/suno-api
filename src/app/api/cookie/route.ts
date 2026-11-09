/**
 * 此接口已废弃，请使用新的多账号接口：
 *   POST /api/accounts  — 添加账号
 *   GET  /api/accounts  — 查看所有账号
 * 或通过管理页面 /admin 操作。
 */
import { NextResponse, NextRequest } from 'next/server';
import { addAccount, ensureLoaded, getAccounts } from '@/lib/accountStore';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const LEGACY_EMAIL = 'legacy@suno-api.local';

export async function GET() {
  await ensureLoaded();
  const accounts = await getAccounts();
  const configured = accounts.length > 0;
  return NextResponse.json(
    { configured, deprecated: true, message: '请使用 /api/accounts 和 /admin 管理账号' },
    { status: 200, headers: corsHeaders }
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { cookie } = body as { cookie?: string };
    if (!cookie || !cookie.trim()) {
      return NextResponse.json({ error: 'cookie 字段不能为空' }, { status: 400, headers: corsHeaders });
    }
    await addAccount(LEGACY_EMAIL, cookie.trim());
    return NextResponse.json(
      { success: true, deprecated: true, message: '已通过兼容接口添加账号，建议改用 POST /api/accounts' },
      { headers: corsHeaders }
    );
  } catch (error) {
    return NextResponse.json({ error: 'Internal error: ' + error }, { status: 500, headers: corsHeaders });
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}
