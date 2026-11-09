import { NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { errorResponse, jsonResponse, optionsResponse } from "@/app/api/sunoProxyResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/edit/crop
 * body: { clip_id, crop_start_s, crop_end_s, is_crop_remove? }
 * 同步跑完 crop → action 轮询 → 取 clip，直接返回裁剪后的新歌曲。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { clip_id, crop_start_s, crop_end_s, is_crop_remove, title } = body || {};
    if (!clip_id) {
      return errorResponse(new Error('clip_id is required'));
    }
    const result = await (await sunoApi()).crop(clip_id, {
      crop_start_s,
      crop_end_s,
      is_crop_remove,
      title
    });
    return jsonResponse(result);
  } catch (error: any) {
    console.error('Error cropping clip:', error);
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
