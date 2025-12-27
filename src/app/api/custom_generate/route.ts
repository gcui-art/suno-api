import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers';
import { DEFAULT_MODEL, sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const maxDuration = 60; // allow longer timeout for wait_audio == true
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      console.log('API received body:', JSON.stringify(body, null, 2));
      const { prompt, gpt_description_prompt, tags, title, make_instrumental, model, wait_audio, negative_tags, use_ui } = body;
      
      const api = await sunoApi((await cookies()).toString());
      let audioInfo;
      
      // Default to direct API generation
      // Only use UI-based generation if use_ui is explicitly set to true
      if (use_ui === true) {
        console.log('Using UI-based generation (use_ui=true)');
        audioInfo = await api.generateViaUI(
          prompt || '',
          tags || '',
          title || '',
          Boolean(make_instrumental),
          Boolean(wait_audio)
        );
      } else {
        // Direct API-based generation (default)
        console.log('Using direct API generation (default)');
        console.log('Calling custom_generate with gpt_description_prompt:', gpt_description_prompt);
        audioInfo = await api.custom_generate(
          prompt || '', 
          tags, 
          title,
          Boolean(make_instrumental),
          model || DEFAULT_MODEL,
          Boolean(wait_audio),
          negative_tags,
          gpt_description_prompt
        );
      }
      
      // Check if all items have error status (e.g., moderation failures)
      const allErrors = Array.isArray(audioInfo) && audioInfo.length > 0 && 
        audioInfo.every((audio: any) => audio.status === 'error');
      
      // If all items failed, return 400 Bad Request
      if (allErrors) {
        return new NextResponse(JSON.stringify(audioInfo), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      return new NextResponse(JSON.stringify(audioInfo), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error: any) {
      console.error('Error generating custom audio:', error);
      return new NextResponse(JSON.stringify({ error: error.response?.data?.detail || error.toString() }), {
        status: error.response?.status || 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: {
        Allow: 'POST',
        ...corsHeaders
      },
      status: 405
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
