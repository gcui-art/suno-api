import { NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { errorResponse, jsonResponse, optionsResponse } from "@/app/api/sunoProxyResponse";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    actionClipId: string;
  };
}

/**
 * GET /api/edit/action/{actionClipId}
 * 查询 fade/crop 等编辑动作的生成状态。供调用方（前端）主动轮询。
 */
export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const result = await (await sunoApi()).getEditAction(context.params.actionClipId);
    return jsonResponse(result);
  } catch (error: any) {
    console.error('Error fetching edit action:', error);
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
