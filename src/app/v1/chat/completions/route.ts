import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";

export const dynamic = "force-dynamic";

/**
 * desc
 *
 */
export async function POST(req: NextRequest) {
  try {

    const body = await req.json();

    let userMessage = null;
    const { messages } = body;
    for (let message of messages) {
      if (message.role == 'user') {
        userMessage = message;
      }
    }

    if (!userMessage) {
      return new NextResponse(JSON.stringify({ error: 'Prompt message is required' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }
      });
    }


    const audioInfo = await (await sunoApi).generate(userMessage.content, true, true);

    const audio = audioInfo[0]
    const data = `## 歌曲名称：${audio.title}\n![歌曲封面](${audio.image_url})\n### 歌词：\n${audio.lyric}\n### 听歌链接： ${audio.audio_url}`

    return new NextResponse(data, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }
    });
  } catch (error: any) {
    console.error('Error generating custom audio:', JSON.stringify(error.response.data));
    return new NextResponse(JSON.stringify({ error: 'Internal server error: ' + JSON.stringify(error.response.data.detail) }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}