import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const { prompt } = body;

      if (!prompt) {
        return new NextResponse(JSON.stringify({ error: 'Prompt is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const lyrics = await (await sunoApi).generateLyrics(prompt);

      return new NextResponse(JSON.stringify(lyrics), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error: any) {
      console.error('Error generating lyrics:', JSON.stringify(error.response.data));
      if (error.response.status === 402) {
        return new NextResponse(JSON.stringify({ error: error.response.data.detail }), {
          status: 402,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new NextResponse(JSON.stringify({ error: 'Internal server error: ' + JSON.stringify(error.response.data.detail) }), {
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