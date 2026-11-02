import { NextRequest } from 'next/server';
import { getSunoGenerationJob } from '@/lib/sunoGenerationJobs';
import { errorResponse, jsonResponse, optionsResponse } from '@/app/api/sunoProxyResponse';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const outcome = getSunoGenerationJob(params.id);
    if (!outcome) return jsonResponse({ error: 'Generation request not found', code: 'SUNO_GENERATION_NOT_FOUND' }, 404);
    const response = outcome.status === 'succeeded'
      ? jsonResponse(outcome.result)
      : outcome.status === 'pending' ? jsonResponse(outcome, 202) : errorResponse(outcome.error);
    response.headers.set('X-Generation-Request-Id', outcome.request_id);
    response.headers.set('Cache-Control', 'no-store');
    if (outcome.status === 'pending') {
      response.headers.set('Retry-After', String(outcome.retry_after_seconds));
      response.headers.set('Location', outcome.status_url);
    }
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
