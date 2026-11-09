import { sunoApi } from "@/lib/SunoApi";
import {
  errorResponse,
  jsonResponse,
  optionsResponse
} from "@/app/api/sunoProxyResponse";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const suggestions = await (await sunoApi()).getPromptSuggestions();
    return jsonResponse(suggestions);
  } catch (error: any) {
    console.error('Error fetching prompt suggestions:', error);
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
