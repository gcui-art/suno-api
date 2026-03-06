import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers'
import { DEFAULT_MODEL, sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const { prompt, make_instrumental, model, wait_audio } = body;

      const audioInfo = await (await sunoApi((await cookies()).toString())).generate(
        prompt,
        Boolean(make_instrumental),
        model || DEFAULT_MODEL,
        Boolean(wait_audio)
      );

      return new NextResponse(JSON.stringify(audioInfo), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error: any) {
      console.error('Error generating audio:', error);
      
      // Handle different types of errors
      if (error.response) {
        // Axios error with response
        console.error('Response error:', JSON.stringify(error.response.data));
        
        if (error.response.status === 402) {
          return new NextResponse(JSON.stringify({ 
            error: error.response.data?.detail || 'Payment required' 
          }), {
            status: 402,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
        
        return new NextResponse(JSON.stringify({ 
          error: 'API Error: ' + (error.response.data?.detail || error.response.statusText || 'Unknown error')
        }), {
          status: error.response.status || 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } else if (error.request) {
        // Axios error without response (network error, timeout, etc.)
        console.error('Network error:', error.message);
        return new NextResponse(JSON.stringify({ 
          error: 'Network error: Unable to connect to Suno API. Please check your internet connection and try again.' 
        }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } else {
        // Other types of errors (timeout, etc.)
        console.error('Other error:', error.message);
        return new NextResponse(JSON.stringify({ 
          error: 'Internal error: ' + (error.message || 'Unknown error occurred') 
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
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