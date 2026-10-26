import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { sunoApi } from '@/lib/SunoApi';
import { StudioError } from '@/lib/StudioApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handle(req: NextRequest, action: string, method: 'GET' | 'POST') {
  const allowed = method === 'GET' ? ['project', 'status', 'download'] : ['generate', 'export'];
  if (!allowed.includes(action)) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404, headers: corsHeaders });
  try {
    const body = method === 'POST' ? await req.json() : null;
    if (method === 'POST' && (!body || typeof body !== 'object' || Array.isArray(body))) {
      throw new StudioError('INVALID_BODY');
    }
    const studio = (await sunoApi((await cookies()).toString())).studio();
    const query = new URL(req.url).searchParams;
    let result;
    switch (action) {
      case 'project': result = await studio.getProject(query.get('id') ?? ''); break;
      case 'status': result = await studio.get((query.get('ids') ?? '').split(',')); break;
      case 'download': result = await studio.getDownload(query.get('id') ?? ''); break;
      case 'generate': result = await studio.generate(body); break;
      case 'export': result = await studio.export(body); break;
    }
    return NextResponse.json(result, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
  } catch (error) {
    // Never serialize/log provider HTTP errors: they can contain account credentials.
    const known = error instanceof StudioError;
    return NextResponse.json({ error: known ? error.code : error instanceof SyntaxError ? 'INVALID_JSON' : 'STUDIO_REQUEST_FAILED',
      submission_unknown: known ? error.submissionUnknown : false },
    { status: known ? error.status : error instanceof SyntaxError ? 400 : 502,
      headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
  }
}
export async function GET(req: NextRequest, { params }: { params: { action: string } }) { return handle(req, params.action, 'GET'); }
export async function POST(req: NextRequest, { params }: { params: { action: string } }) { return handle(req, params.action, 'POST'); }
export async function OPTIONS() { return new Response(null, { headers: corsHeaders }); }
