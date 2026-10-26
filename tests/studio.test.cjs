const fs = require('node:fs');
const ts = require('typescript');
const test = require('node:test');
const assert = require('node:assert/strict');
// Use the repository's existing TypeScript dependency; no runtime/test dependency added.
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, filename);
const { StudioApi, StudioError, fullSongState } = require('../src/lib/StudioApi.ts');
const project = '11111111-1111-4111-8111-111111111111';
const clip = '22222222-2222-4222-8222-222222222222';
const render = '33333333-3333-4333-8333-333333333333';
const makeInput = () => ({ project_id: project, clip_id: clip, duration_seconds: 204,
  state: { tracks: [{ type: 'audio', id: 'old', clips: [{ streaming: true, warp: { enabled: true } }],
    takeLanes: [{ clips: [{}] }] }, { type: 'audio', clips: [{}] }], actors: { private: {} } } });
function setup(override = () => undefined) {
  const calls = [];
  const api = new StudioApi(async (path, method, body) => {
    calls.push({ path, method, body });
    const custom = override(path, method, body);
    if (custom !== undefined) return custom;
    if (path.startsWith('studio/project/')) return { owner_user_id: 'owner' };
    if (path === 'c/check') return { required: false };
    if (path === 'feed/v3') return { clips: [{ id: clip, status: 'complete', metadata: { duration: 204 } }] };
    return { id: render, clips: [{ id: clip }] };
  }, () => 'owner');
  return { api, calls };
}

test('Studio generation supplies exact lyrics/styles and one explicit POST', async () => {
  const { api, calls } = setup();
  await api.generate({ project_id: project, prompt: 'Original lyrics\nLine two', tags: 'bright folk pop' });
  const submits = calls.filter(c => c.path === 'generate/v2-web/');
  assert.equal(submits.length, 1);
  assert.equal(submits[0].body.attached_lyrics, 'Original lyrics\nLine two');
  assert.equal(submits[0].body.attached_styles, 'bright folk pop');
  assert.equal(submits[0].body.mv, 'chirp-hawk');
  assert.equal(submits[0].body.metadata.from_studio_project_id, project);
  assert.equal(submits[0].body.token, null);
});
for (const required of [true, undefined]) test(`CAPTCHA required=${required} stops without generation`, async () => {
  const { api, calls } = setup(path => path === 'c/check' ? { required } : undefined);
  await assert.rejects(api.generate({ project_id: project, prompt: 'Words', tags: 'pop' }), /CAPTCHA_REQUIRED/);
  assert.equal(calls.filter(c => c.path === 'generate/v2-web/').length, 0);
});

test('foreign project cannot generate or render', async () => {
  const { api, calls } = setup(path => path.startsWith('studio/project/') ? { owner_user_id: 'other' } : undefined);
  await assert.rejects(api.generate({ project_id: project, prompt: 'Words', tags: 'pop' }), /PROJECT_OWNER_MISMATCH/);
  await assert.rejects(api.export(makeInput()), /PROJECT_OWNER_MISMATCH/);
  assert.ok(calls.every(c => c.method === 'GET'));
});

test('generation timeout never causes another submission', async () => {
  const { api, calls } = setup(path => { if (path === 'generate/v2-web/') throw new Error('uncertain'); });
  await assert.rejects(api.generate({ project_id: project, prompt: 'Words', tags: 'pop' }), /uncertain/);
  assert.equal(calls.filter(c => c.path === 'generate/v2-web/').length, 1);
});

test('full song keeps duration, disables warp/streaming, removes other tracks without mutating template', () => {
  const input = makeInput(); const original = JSON.stringify(input);
  const { state, end } = fullSongState(input);
  assert.equal(JSON.stringify(input), original);
  assert.equal(end, 408); assert.equal(state.timing.bps, 2);
  assert.equal(state.tracks.length, 1);
  const out = state.tracks[0].clips[0];
  assert.equal(out.streaming, false); assert.equal(out.warp.enabled, false);
  assert.equal(out.readStartBeats, 0); assert.equal(out.endBeats, end);
  assert.equal(out.asset.id, clip); assert.deepEqual(state.actors, {});
  assert.deepEqual(state.tracks[0].takeLanes, []);
});
for (const duration of [0, -1, NaN, Infinity, 481, '204']) test(`invalid duration ${duration} stops`, () => {
  assert.throws(() => fullSongState({ ...makeInput(), duration_seconds: duration }), /INVALID_DURATION/);
});

test('incomplete source and incorrect duration cannot render', async () => {
  for (const source of [{ status: 'streaming', duration: 204 }, { status: 'complete', duration: 150 }]) {
    const { api, calls } = setup(path => path === 'feed/v3' ? { clips: [{ id: clip, status: source.status, metadata: { duration: source.duration } }] } : undefined);
    await assert.rejects(api.export(makeInput()), /SOURCE_/);
    assert.equal(calls.filter(c => c.path === 'studio/render-state').length, 0);
  }
});

test('export returns render ID, never saves the existing project timeline', async () => {
  const { api, calls } = setup(); const result = await api.export(makeInput());
  assert.equal(result.id, render);
  const renders = calls.filter(c => c.path === 'studio/render-state');
  assert.equal(renders.length, 1); assert.equal(renders[0].body.end_beats, 408);
  assert.equal(renders[0].body.export_mode, 'fullsong_export');
  assert.equal(renders[0].body.studio_project_version_id, null);
  assert.equal(calls.some(c => c.path.includes('save-project')), false);
});

test('status polls supplied IDs without generation/render', async () => {
  const { api, calls } = setup(); await api.get([clip, render]);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].body.filters.ids.clipIds, [clip, render]);
});

test('download propagates pending then ready signed URL without fetching audio', async () => {
  const url = `https://suno-data-uploads.s3.amazonaws.com/studio/uploads/${render}_lyrics.m4a?signature=example`;
  for (const response of [{ status: 'processing' }, { status: 'ready', download_url: url }]) {
    const { api, calls } = setup(() => response);
    assert.deepEqual(await api.getDownload(render), response);
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
  }
});
for (const url of ['http://localhost/private', 'https://evil.example/audio',
  `https://suno-data-uploads.s3.amazonaws.com/studio/uploads/${clip}_lyrics.m4a`,
  `https://secret@suno-data-uploads.s3.amazonaws.com/studio/uploads/${render}_lyrics.m4a`]) {
  test('unexpected download destination rejected', async () => {
    const { api } = setup(() => ({ status: 'ready', download_url: url }));
    await assert.rejects(api.getDownload(render), /UNEXPECTED_DOWNLOAD_DESTINATION/);
  });
}

test('invalid IDs, style and missing clip template stop before provider access', async () => {
  const { api, calls } = setup();
  await assert.rejects(api.get(['../../private']), /INVALID_ID/);
  await assert.rejects(api.generate({ project_id: project, prompt: 'Words', tags: 'x'.repeat(1001) }), /STYLE_TOO_LONG/);
  await assert.rejects(api.export({ ...makeInput(), state: { tracks: [] } }), /AUDIO_CLIP_TEMPLATE_REQUIRED/);
  assert.equal(calls.length, 0);
});

test('Studio errors expose only a code and uncertain-submission flag', () => {
  const error = new StudioError('STUDIO_REQUEST_FAILED', 502, true);
  assert.equal(error.message, 'STUDIO_REQUEST_FAILED'); assert.equal(error.submissionUnknown, true);
});

test('malformed track/clip template fails as an input error', () => {
  for (const tracks of [[null], [{ type: 'audio', clips: [null] }], [{ type: 'audio', clips: ['invalid'] }]]) {
    assert.throws(() => fullSongState({ ...makeInput(), state: { tracks } }), StudioError);
  }
});
