import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";

export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const { prompt, tags, title, make_instrumental, wait_audio } = body;

      // 校验输入参数
      if (!prompt || !tags || !title) {
        return new NextResponse(JSON.stringify({ error: 'Prompt, tags, and title are required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 调用 SunoApi.custom_generate 方法生成定制音频
      const audioInfo = await (await sunoApi).custom_generate(
        prompt, tags, title,
        make_instrumental == true,
        wait_audio == true
      );

      // 使用 NextResponse 构建成功响应
      return new NextResponse(JSON.stringify(audioInfo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error: any) {
      console.error('Error generating custom audio:', error.response.data);
      if (error.response.status === 402) {
        return new NextResponse(JSON.stringify({ error: error.response.data.detail }), {
          status: 402,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      // 使用 NextResponse 构建错误响应
      return new NextResponse(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: { Allow: 'POST' },
      status: 405
    });
  }
}