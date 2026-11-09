import { NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { errorResponse, jsonResponse, optionsResponse } from "@/app/api/sunoProxyResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/remaster
 * body: { clip_id, model_name, variation_category? }
 * 用指定模型重制歌曲（upsample），返回一批新 clip（无后续轮询）。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { clip_id, model_name, variation_category } = body || {};
    if (!clip_id) {
      return errorResponse(new Error('clip_id is required'));
    }
    const result = await (await sunoApi()).remaster(clip_id, {
      model_name,
      variation_category
    });
    return jsonResponse(result);
  } catch (error: any) {
    console.error('Error remastering clip:', error);
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
