import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    id: string;
  };
}

export async function GET(req: NextRequest, context: RouteContext) {
  if (req.method !== 'GET') {
    return new NextResponse('Method Not Allowed', {
      headers: {
        Allow: 'GET',
        ...corsHeaders
      },
      status: 405
    });
  }

  try {
    const result = await (await sunoApi()).getAudioUpload(context.params.id);

    return new NextResponse(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  } catch (error: any) {
    console.error('Error fetching audio upload:', error);
    return new NextResponse(JSON.stringify({
      error: error.response?.data?.detail || error.toString()
    }), {
      status: error.response?.status || 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
