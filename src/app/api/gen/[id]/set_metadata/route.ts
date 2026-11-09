import { NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { errorResponse, jsonResponse, optionsResponse } from "@/app/api/sunoProxyResponse";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    id: string;
  };
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const body = await req.json();
    const result = await (await sunoApi()).setClipMetadata(context.params.id, body);
    return jsonResponse(result);
  } catch (error: any) {
    console.error('Error setting clip metadata:', error);
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
