import { NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { errorResponse, jsonResponse, optionsResponse } from "@/app/api/sunoProxyResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/clips/adjust-speed
 * body: { clip_id, speed_multiplier, keep_pitch?, title? }
 * 变速，返回新 clip（status=processing，无后续轮询）。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { clip_id, speed_multiplier, keep_pitch, title } = body || {};
    if (!clip_id) {
      return errorResponse(new Error('clip_id is required'));
    }
    const result = await (await sunoApi()).adjustSpeed(clip_id, {
      speed_multiplier,
      keep_pitch,
      title
    });
    return jsonResponse(result);
  } catch (error: any) {
    console.error('Error adjusting speed:', error);
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
