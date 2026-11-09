import { NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { errorResponse, jsonResponse, optionsResponse } from "@/app/api/sunoProxyResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/clips/reverse-clip
 * body: { clip_id, title? }
 * 反转整首歌曲，返回新 clip（status=processing，无后续轮询）。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { clip_id, title } = body || {};
    if (!clip_id) {
      return errorResponse(new Error('clip_id is required'));
    }
    const result = await (await sunoApi()).reverse(clip_id, title);
    return jsonResponse(result);
  } catch (error: any) {
    console.error('Error reversing clip:', error);
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
