import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";

export async function GET(req: NextRequest) {
  if (req.method === 'GET') {
    try {
      // 调用 SunoApi.get_limit 方法获取剩余的信用额度
      const limit = await (await sunoApi).get_credits();

      // 使用 NextResponse 构建成功响应
      return new NextResponse(JSON.stringify(limit), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Error fetching limit:', error);
      // 使用 NextResponse 构建错误响应
      return new NextResponse(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: { Allow: 'GET' },
      status: 405
    });
  }
}