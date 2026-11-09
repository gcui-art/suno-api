import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    id: string;
  };
}

export async function POST(req: NextRequest, context: RouteContext) {
  if (req.method !== 'POST') {
    return new NextResponse('Method Not Allowed', {
      headers: {
        Allow: 'POST',
        ...corsHeaders
      },
      status: 405
    });
  }

  try {
    const body = await req.json();
    const { upload_filename, upload_type } = body;
    if (!upload_filename) {
      return new NextResponse(JSON.stringify({ error: 'upload_filename is required' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    const result = await (await sunoApi()).finishAudioUpload(
      context.params.id,
      {
        upload_filename,
        upload_type
      }
    );

    return new NextResponse(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  } catch (error: any) {
    console.error('Error finishing audio upload:', error);
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
