import { NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { errorResponse, jsonResponse, optionsResponse } from "@/app/api/sunoProxyResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/edit/fade
 * body: { clip_id, fade_in_time?, fade_out_time?, title? }
 * 同步跑完 fade → action 轮询 → 取 clip，返回淡入/淡出后的新歌曲。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { clip_id, fade_in_time, fade_out_time, title } = body || {};
    if (!clip_id) {
      return errorResponse(new Error('clip_id is required'));
    }
    const result = await (await sunoApi()).fade(clip_id, {
      fade_in_time,
      fade_out_time,
      title
    });
    return jsonResponse(result);
  } catch (error: any) {
    console.error('Error fading clip:', error);
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
