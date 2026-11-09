import { NextRequest } from 'next/server';
import { DEFAULT_MODEL, sunoApi } from '@/lib/SunoApi';
import { getSunoGenerateOptions } from '@/lib/sunoGenerateRequest';
import { prefersAsyncGeneration, runSunoGenerationJob } from '@/lib/sunoGenerationJobs';
import { pickAccount } from '@/lib/accountStore';
import { errorResponse, jsonResponse, optionsResponse } from '@/app/api/sunoProxyResponse';

export const dynamic = 'force-dynamic';
export const maxDuration = 180;

/** Extend a clip through the durable generation-job store. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return errorResponse({ statusCode: 400, code: 'INVALID_REQUEST', message: 'Request body must be an object' });
    }
    const requestBody = body as Record<string, unknown>;
    const audioId = typeof requestBody.audio_id === 'string' ? requestBody.audio_id.trim() : '';
    if (!audioId) {
      return errorResponse({ statusCode: 400, code: 'INVALID_REQUEST', message: 'Audio ID is required' });
    }
    if (requestBody.continue_at !== undefined &&
      (typeof requestBody.continue_at !== 'number' || !Number.isFinite(requestBody.continue_at) || requestBody.continue_at < 0)) {
      return errorResponse({ statusCode: 400, code: 'INVALID_REQUEST', message: 'continue_at must be a non-negative number' });
    }

    const outcome = await runSunoGenerationJob(
      {
        namespace: 'extend_audio',
        idempotencyKey: req.headers.get('Idempotency-Key'),
        body: requestBody,
        respondAsync: prefersAsyncGeneration(req.headers.get('Prefer')),
        selectAccount: async () => {
          const account = await pickAccount();
          if (!account) throw new Error('No Suno account is configured');
          return account.id;
        }
      },
      async (job) => {
        const savedBody = job.body;
        const options = getSunoGenerateOptions(savedBody);
        return (await sunoApi(job.accountId)).extendAudio(
          String(savedBody.audio_id).trim(),
          typeof savedBody.prompt === 'string' ? savedBody.prompt : '',
          typeof savedBody.continue_at === 'number' ? savedBody.continue_at : undefined,
          typeof savedBody.tags === 'string' ? savedBody.tags : '',
          typeof savedBody.negative_tags === 'string' ? savedBody.negative_tags : '',
          typeof savedBody.title === 'string' ? savedBody.title : '',
          typeof savedBody.model === 'string' && savedBody.model ? savedBody.model : DEFAULT_MODEL,
          savedBody.wait_audio === true,
          { ...options, transaction_uuid: job.transactionUuid }
        );
      }
    );

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
