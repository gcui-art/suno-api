import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  if (req.method === 'GET') {
    try {

      const limit = await (await sunoApi).get_credits();


      return new NextResponse(JSON.stringify(limit), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Error fetching limit:', error);

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