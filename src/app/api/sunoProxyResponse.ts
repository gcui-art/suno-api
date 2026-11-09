import { NextResponse } from "next/server";
import { corsHeaders } from "@/lib/utils";
import { retryAfterSeconds } from "@/lib/sunoRateLimit";

export function jsonResponse(data: unknown, status: number = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

export function errorResponse(error: any) {
  const status = error?.statusCode || error?.response?.status || 500;
  const message = error?.response?.data?.detail || error?.message || String(error);
  const upstreamRetryAfter = status === 429
    ? retryAfterSeconds(error?.response?.headers)
    : undefined;
  const retryAfter = error?.retryAfterSeconds ?? upstreamRetryAfter;
  const body = {
    error: message,
    ...(error?.code ? { code: error.code } : {}),
    ...(retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {})
  };
  const response = jsonResponse(body, status);
  if (retryAfter !== undefined) {
    response.headers.set('Retry-After', String(retryAfter));
  }
  return response;
}

export function optionsResponse() {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
