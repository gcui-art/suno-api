import { handleLocalSunoRecoveryRequest } from '@/lib/sunoLocalRecovery';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  return handleLocalSunoRecoveryRequest(request);
}

export async function POST(request: Request) {
  return handleLocalSunoRecoveryRequest(request);
}
