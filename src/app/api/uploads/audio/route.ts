import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
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
    const { extension, upload_type } = body;
    if (!extension) {
      return new NextResponse(JSON.stringify({ error: 'extension is required' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    const uploadInfo = await (await sunoApi()).createAudioUpload({
      extension,
      upload_type
    });

    return new NextResponse(JSON.stringify(uploadInfo), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  } catch (error: any) {
    console.error('Error creating audio upload:', error);
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
