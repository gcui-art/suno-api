import { NextRequest } from "next/server";
import {
  errorResponse,
  jsonResponse,
  optionsResponse
} from "@/app/api/sunoProxyResponse";
import { sunoApi, type PromptUpsampleRequest } from "@/lib/SunoApi";

export const dynamic = "force-dynamic";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPromptUpsampleRequest(body: unknown): PromptUpsampleRequest {
  if (!isObject(body)) {
    throw new Error("Request body must be a JSON object.");
  }

  const { original_tags, is_instrumental } = body;
  if (typeof original_tags !== "string") {
    throw new Error("original_tags must be a string.");
  }
  if (typeof is_instrumental !== "boolean") {
    throw new Error("is_instrumental must be a boolean.");
  }

  return { original_tags, is_instrumental };
}

export async function POST(req: NextRequest) {
  let request: PromptUpsampleRequest;
  try {
    request = getPromptUpsampleRequest(await req.json());
  } catch (error: any) {
    return jsonResponse({ error: error.message }, 400);
  }

  try {
    const result = await (await sunoApi()).upsamplePrompt(request);
    return jsonResponse(result);
  } catch (error: any) {
    console.error("Error upsampling prompt:", error);
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
