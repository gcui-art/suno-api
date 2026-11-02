import { NextRequest } from "next/server";
import { SunoApi, sunoApi } from "@/lib/SunoApi";
import { errorResponse, jsonResponse, optionsResponse } from "@/app/api/sunoProxyResponse";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    id: string;
  };
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const result: any = await (await sunoApi()).getClip(context.params.id);
    if (result && typeof result === 'object') {
      result.audio_url = SunoApi.pickAudioUrl(result);
      result.media_urls = SunoApi.pickAudioMediaUrls(result);
    }
    return jsonResponse(result);
  } catch (error: any) {
    console.error('Error fetching clip:', error);
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
