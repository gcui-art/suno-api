import { NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { errorResponse, jsonResponse, optionsResponse } from "@/app/api/sunoProxyResponse";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    id: string;
  };
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const result = await (await sunoApi()).getWaveformAggregates(context.params.id);
    return jsonResponse(result);
  } catch (error: any) {
    console.error('Error fetching waveform aggregates:', error);
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
