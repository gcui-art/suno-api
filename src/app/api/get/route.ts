import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url);
      const songIds = url.searchParams.get('ids');
      let audioInfo = [];
      if (songIds && songIds.length > 0) {
        const idsArray = songIds.split(',');
        audioInfo = await (await sunoApi).get(idsArray);
      } else {
        audioInfo = await (await sunoApi).get();
      }

      return new NextResponse(JSON.stringify(audioInfo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Error fetching audio:', error);

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