import { NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { errorResponse, jsonResponse, optionsResponse } from "@/app/api/sunoProxyResponse";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const lyricsA = String(body.lyrics_a ?? "");
    const lyricsB = String(body.lyrics_b ?? "");
    const source = body.source === undefined ? null : body.source;

    const lyrics = await (await sunoApi()).generateLyricsMashup(lyricsA, lyricsB, source);

    return jsonResponse(lyrics);
  } catch (error: any) {
    console.error("Error generating mashup lyrics:", error);
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
