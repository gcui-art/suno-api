import { NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { getSunoGenerateModeRequest } from "@/lib/sunoGenerateRequest";
import { prefersAsyncGeneration, runSunoGenerationJob } from "@/lib/sunoGenerationJobs";
import { pickAccount } from "@/lib/accountStore";
import { errorResponse, jsonResponse, optionsResponse } from "@/app/api/sunoProxyResponse";

export const maxDuration = 180;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const outcome = await runSunoGenerationJob(
      {
        namespace: 'custom_generate',
        idempotencyKey: req.headers.get('Idempotency-Key'),
        body,
        respondAsync: prefersAsyncGeneration(req.headers.get('Prefer')),
        selectAccount: async () => {
          const account = await pickAccount();
          if (!account) throw new Error('No Suno account is configured');
          return account.id;
        }
      },
      async (job) => {
        const request = getSunoGenerateModeRequest(job.body);
        return (await sunoApi(job.accountId)).generate(
          request.prompt,
          request.make_instrumental,
          request.model,
          request.wait_audio,
          { ...request.options, transaction_uuid: job.transactionUuid },
          {
            tags: request.tags,
            title: request.title,
            negative_tags: request.negative_tags
          }
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
  } catch (error: any) {
    console.error('Error generating custom audio:', error);
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
