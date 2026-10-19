import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoachingRequestScope } from '../../../src/voice-coaching/contracts.js';
import { createGroqStandardProvider, type GroqStandardConfiguration, type GroqHttp } from '../../../src/voice-coaching/standard/index.js';

const configuration: GroqStandardConfiguration = {
  apiKey: 'fixture-key', transcriptionModel: 'whisper-large-v3-turbo', completionModel: 'fixture-chat-model',
  speechModel: 'canopylabs/orpheus-v1-english', voice: 'troy',
};
function scope() {
  const abort = new AbortController();
  let active = true;
  const actor = Object.freeze({ accountId: 'original', authUserId: 'user', sessionId: 'session', epoch: 3 });
  const request: CoachingRequestScope = Object.freeze({
    actor, signal: abort.signal,
    assertCurrent() { if (!active || abort.signal.aborted) throw new Error('stale'); },
  });
  return { request, abort, expire() { active = false; } };
}
const audio = { audio: new Blob(['audio fixture'], { type: 'audio/wav' }), format: 'wav' as const };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const completion = (content = 'Keep your movement controlled.', finish_reason = 'stop') => json({ choices: [{ message: { content }, finish_reason }] });
function wav(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 38, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, 2, true);
  return bytes;
}

test('fixed endpoints carry multipart transcription, bounded completion and WAV synthesis', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const responses = [json({ text: 'How should I move?' }), completion(), new Response(wav())];
  const http: GroqHttp = async (url, init) => { calls.push({ url, init }); return responses.shift()!; };
  const provider = createGroqStandardProvider(configuration, http);
  const { request } = scope();
  assert.equal(provider.enabled, true);
  assert.deepEqual(await provider.transcribe(request, audio), { kind: 'succeeded', value: 'How should I move?', metadata: unavailableMetadata('transcribe', 'whisper-large-v3-turbo') });
  assert.deepEqual(await provider.complete(request, { text: 'How should I move?' }), { kind: 'succeeded', value: 'Keep your movement controlled.', metadata: unavailableMetadata('complete', 'fixture-chat-model') });
  const speech = await provider.synthesize(request, { text: 'Keep your movement controlled.' });
  assert.equal(speech.kind, 'succeeded');
  if (speech.kind === 'succeeded') { assert.deepEqual(speech.value.audio, wav()); assert.equal(speech.value.mediaType, 'audio/wav'); }
  assert.deepEqual(calls.map(call => call.url), [
    'https://api.groq.com/openai/v1/audio/transcriptions',
    'https://api.groq.com/openai/v1/chat/completions',
    'https://api.groq.com/openai/v1/audio/speech',
  ]);
  for (const { init } of calls) {
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-key');
    assert.ok(init.signal instanceof AbortSignal);
  }
  const form = calls[0]!.init.body as FormData;
  assert.equal(form.get('model'), 'whisper-large-v3-turbo'); assert.equal(form.get('response_format'), 'json');
  assert.equal((form.get('file') as File).name, 'recording.wav');
  assert.equal(new Headers(calls[0]!.init.headers).has('content-type'), false);
  const chat = JSON.parse(calls[1]!.init.body as string);
  assert.equal(chat.model, 'fixture-chat-model'); assert.equal(chat.max_completion_tokens, 256); assert.equal(chat.stream, false);
  assert.match(chat.messages[0].content, /200 Unicode characters/);
  assert.deepEqual(JSON.parse(calls[2]!.init.body as string), {
    model: 'canopylabs/orpheus-v1-english', voice: 'troy', input: 'Keep your movement controlled.', response_format: 'wav',
  });
  assert.equal(request.actor.accountId, 'original');
});

test('missing or unsupported configuration disables all stages without dispatch', async () => {
  let calls = 0;
  const http: GroqHttp = async () => { calls++; throw new Error('must not dispatch'); };
  for (const invalid of [{}, { ...configuration, apiKey: '' }, { ...configuration, completionModel: '' },
    { ...configuration, speechModel: 'unsupported' }, { ...configuration, voice: '' },
    { ...configuration, limits: { maxReplyCharacters: 201 } }]) {
    const provider = createGroqStandardProvider(invalid, http);
    assert.equal(provider.enabled, false);
    assert.equal((await provider.transcribe(scope().request, audio)).kind, 'not_dispatched');
    assert.equal((await provider.complete(scope().request, { text: 'Move' })).kind, 'not_dispatched');
    assert.equal((await provider.synthesize(scope().request, { text: 'Move' })).kind, 'not_dispatched');
  }
  assert.equal(calls, 0);
});

test('configuration and limits are captured rather than read from a mutated caller', async () => {
  const supplied = { ...configuration, limits: { maxReplyCharacters: 20 } };
  let sent: Record<string, unknown> | undefined;
  const provider = createGroqStandardProvider(supplied, async (_url, init) => {
    sent = JSON.parse(init.body as string); return completion('Proceed slowly.');
  });
  supplied.completionModel = 'replacement'; supplied.limits.maxReplyCharacters = 200;
  assert.equal((await provider.complete(scope().request, { text: 'Move' })).kind, 'succeeded');
  assert.equal(sent!.model, 'fixture-chat-model');
  assert.match(JSON.stringify(sent), /20 Unicode characters/);
});

test('input byte and Unicode bounds reject whole inputs without truncation or dispatch', async () => {
  let calls = 0;
  const provider = createGroqStandardProvider({ ...configuration, limits: { maxAudioBytes: 4, maxTextCharacters: 8 } }, async () => { calls++; return new Response(wav()); });
  assert.equal((await provider.transcribe(scope().request, audio)).kind, 'not_dispatched');
  assert.equal((await provider.complete(scope().request, { text: '123456789' })).kind, 'not_dispatched');
  assert.equal((await provider.synthesize(scope().request, { text: '🙂'.repeat(201) })).kind, 'not_dispatched');
  assert.equal(calls, 0);
  assert.equal((await provider.synthesize(scope().request, { text: '🙂'.repeat(200) })).kind, 'succeeded');
  assert.equal(calls, 1);
});

test('aborted or expired admission causes zero dispatch', async () => {
  let calls = 0;
  const provider = createGroqStandardProvider(configuration, async () => { calls++; return completion(); });
  const aborted = scope(); aborted.abort.abort();
  const expired = scope(); expired.expire();
  for (const { request } of [aborted, expired]) assert.equal((await provider.complete(request, { text: 'Move' })).kind, 'not_dispatched');
  assert.equal(calls, 0);
});

test('cancellation or expiry after HTTP await stays unknown and prevents the next stage', async () => {
  for (const mode of ['abort', 'expire'] as const) {
    const context = scope();
    let calls = 0;
    const provider = createGroqStandardProvider(configuration, async () => {
      calls++; mode === 'abort' ? context.abort.abort() : context.expire(); return json({ text: 'Move' });
    });
    assert.equal((await provider.transcribe(context.request, audio)).kind, 'unknown');
    assert.equal((await provider.complete(context.request, { text: 'Move' })).kind, 'not_dispatched');
    assert.equal((await provider.synthesize(context.request, { text: 'Move' })).kind, 'not_dispatched');
    assert.equal(calls, 1);
    assert.equal(context.request.actor.accountId, 'original');
  }
});

test('expiry during streamed body reading cannot return a successful completion', async () => {
  const context = scope();
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    context.expire(); controller.enqueue(new TextEncoder().encode('{"text":"Move"}')); controller.close();
  } }, { highWaterMark: 0 });
  const provider = createGroqStandardProvider(configuration, async () => new Response(body));
  assert.equal((await provider.transcribe(context.request, audio)).kind, 'unknown');
});

test('explicit HTTP rejection differs from ambiguous server/network failure without retry', async () => {
  for (const status of [400, 401, 429, 408, 500, 503]) {
    let calls = 0;
    const provider = createGroqStandardProvider(configuration, async () => { calls++; return new Response('private provider detail', { status }); });
    const result = await provider.complete(scope().request, { text: 'Move' });
    assert.equal(result.kind, status < 500 && status !== 408 ? 'rejected' : 'unknown');
    assert.equal(JSON.stringify(result).includes('private provider detail'), false); assert.equal(calls, 1);
  }
  let calls = 0;
  const provider = createGroqStandardProvider(configuration, async () => { calls++; throw new Error('private transport detail'); });
  assert.deepEqual(await provider.complete(scope().request, { text: 'Move' }), { kind: 'unknown', reason: 'provider_outcome_unknown', metadata: unavailableMetadata('complete', 'fixture-chat-model') });
  assert.equal(calls, 1);
});

test('timeout signals injected transport and remains unknown without retry', async () => {
  let calls = 0;
  const provider = createGroqStandardProvider({ ...configuration, limits: { timeoutMs: 5 } }, async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true }); });
  });
  assert.equal((await provider.complete(scope().request, { text: 'Move' })).kind, 'unknown');
  assert.equal(calls, 1);
});

test('malformed, overlong and token-truncated successful responses are unknown', async () => {
  for (const response of [new Response('{'), json({}), completion('x'.repeat(201)), completion('unfinished', 'length')]) {
    let calls = 0;
    const provider = createGroqStandardProvider(configuration, async () => { calls++; return response; });
    assert.equal((await provider.complete(scope().request, { text: 'Move' })).kind, 'unknown'); assert.equal(calls, 1);
  }
  const provider = createGroqStandardProvider(configuration, async () => new Response('not WAV audio'));
  assert.equal((await provider.synthesize(scope().request, { text: 'Move' })).kind, 'unknown');
});

test('response limits reject declared and streamed oversized bodies', async () => {
  for (const response of [new Response('small', { headers: { 'content-length': '1000' } }), new Response('x'.repeat(100))]) {
    const provider = createGroqStandardProvider({ ...configuration, limits: { maxJsonBytes: 20 } }, async () => response);
    assert.equal((await provider.complete(scope().request, { text: 'Move' })).kind, 'unknown');
  }
});


test('a scope invalidated at the final dispatch check remains not dispatched', async () => {
  let checks = 0;
  let calls = 0;
  const base = scope().request;
  const request: CoachingRequestScope = { ...base, assertCurrent() { if (++checks === 3) throw new Error('expired'); } };
  const provider = createGroqStandardProvider(configuration, async () => { calls++; return completion(); });
  assert.equal((await provider.complete(request, { text: 'Move' })).kind, 'not_dispatched');
  assert.equal(calls, 0);
});

test('WAV markers alone cannot qualify an invalid successful audio response', async () => {
  const malformed = wav();
  malformed[40] = 100;
  const provider = createGroqStandardProvider(configuration, async () => new Response(malformed));
  assert.equal((await provider.synthesize(scope().request, { text: 'Move' })).kind, 'unknown');
});


function unavailableMetadata(operation: 'transcribe' | 'complete' | 'synthesize', requestedModelId: string) {
  return { schemaVersion: 1, providerId: 'groq', operation, requestedModelId,
    telemetry: { status: 'unavailable', invalidFields: [] } };
}
const metadataFixture = {
  id: 'chatcmpl_fixture', model: 'reported/model-v1', x_groq: { id: 'req_fixture' },
  usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37, prompt_tokens_details: { cached_tokens: 12 } },
};
const metadataResponse = (fields: Record<string, unknown> = {}) => json({
  ...metadataFixture, choices: [{ message: { content: 'Move slowly.' }, finish_reason: 'stop' }], ...fields,
});

test('metadata separates requested model, reported model, request identity and response identity', async () => {
  const provider = createGroqStandardProvider(configuration, async () => metadataResponse());
  const result = await provider.complete(scope().request, { text: 'Move' });
  assert.equal(result.kind, 'succeeded');
  if (result.kind === 'succeeded') assert.equal(result.value, 'Move slowly.');
  assert.deepEqual(result.metadata, {
    schemaVersion: 1, providerId: 'groq', operation: 'complete', requestedModelId: 'fixture-chat-model',
    reportedModelId: 'reported/model-v1', requestId: 'req_fixture', responseId: 'chatcmpl_fixture',
    telemetry: { status: 'complete', promptTokens: 30, completionTokens: 7, cachedPromptTokens: 12, totalTokens: 37, invalidFields: [] },
  });
  assert.ok(Object.isFrozen(result.metadata));
  assert.ok(Object.isFrozen(result.metadata!.telemetry));
  assert.ok(Object.isFrozen(result.metadata!.telemetry.invalidFields));
});

test('absent usage and identities stay unavailable and absent, never substituted', async () => {
  const provider = createGroqStandardProvider(configuration, async () => completion());
  const result = await provider.complete(scope().request, { text: 'Move' });
  assert.deepEqual(result.metadata, unavailableMetadata('complete', 'fixture-chat-model'));
  assert.equal(Object.hasOwn(result.metadata!, 'reportedModelId'), false);
  assert.equal(Object.hasOwn(result.metadata!.telemetry, 'cachedPromptTokens'), false);
});

test('absent cached or total tokens remain absent and explicitly partial', async () => {
  for (const usage of [
    { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37 },
    { prompt_tokens: 30, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 0 } },
    { prompt_tokens: 30 },
  ]) {
    const provider = createGroqStandardProvider(configuration, async () => metadataResponse({ usage }));
    const result = await provider.complete(scope().request, { text: 'Move' });
    const telemetry = result.metadata!.telemetry;
    assert.equal(telemetry.status, 'partial');
    assert.equal(telemetry.promptTokens, 30);
    assert.deepEqual(telemetry.invalidFields, []);
    assert.equal(Object.hasOwn(telemetry, 'cachedPromptTokens'), Object.hasOwn(usage, 'prompt_tokens_details'));
    assert.equal(Object.hasOwn(telemetry, 'totalTokens'), Object.hasOwn(usage, 'total_tokens'));
  }
});

test('invalid supplied token counts are omitted while other valid counts survive', async () => {
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7', null]) {
    const provider = createGroqStandardProvider(configuration, async () => metadataResponse({ usage: {
      prompt_tokens: 30, completion_tokens: invalid, total_tokens: 37, prompt_tokens_details: { cached_tokens: 12 },
    } }));
    const result = await provider.complete(scope().request, { text: 'Move' });
    assert.deepEqual(result.metadata!.telemetry, {
      status: 'partial', promptTokens: 30, cachedPromptTokens: 12, totalTokens: 37, invalidFields: ['completionTokens'],
    });
  }
  const provider = createGroqStandardProvider(configuration, async () => metadataResponse({ usage: {
    prompt_tokens: -1, completion_tokens: 0, total_tokens: '7', prompt_tokens_details: { cached_tokens: -1 },
  } }));
  assert.deepEqual((await provider.complete(scope().request, { text: 'Move' })).metadata!.telemetry, {
    status: 'partial', completionTokens: 0, invalidFields: ['promptTokens', 'cachedPromptTokens', 'totalTokens'],
  });
});

test('malformed usage containers are explicit and cannot invent zero counts', async () => {
  for (const usage of [null, [], 'private detail']) {
    const provider = createGroqStandardProvider(configuration, async () => metadataResponse({ usage }));
    assert.deepEqual((await provider.complete(scope().request, { text: 'Move' })).metadata!.telemetry,
      { status: 'partial', invalidFields: ['usage'] });
  }
  for (const details of [null, [], 'private detail']) {
    const provider = createGroqStandardProvider(configuration, async () => metadataResponse({ usage: {
      prompt_tokens: 30, prompt_tokens_details: details,
    } }));
    assert.deepEqual((await provider.complete(scope().request, { text: 'Move' })).metadata!.telemetry,
      { status: 'partial', promptTokens: 30, invalidFields: ['cachedPromptTokens'] });
  }
});

test('provider identity accepts bounded ASCII only without retaining arbitrary fields or headers', async () => {
  for (const invalid of ['', 'bad id', 'bad\nid', 'badid\n', 'badid\r', '🙂', 'a'.repeat(201), { secret: 'private' }, 42]) {
    const provider = createGroqStandardProvider(configuration, async () => {
      const response = metadataResponse({ id: invalid, model: invalid, x_groq: { id: invalid }, private: 'private content' });
      response.headers.set('x-request-id', 'unqualified-header');
      return response;
    });
    const metadata = (await provider.complete(scope().request, { text: 'Move' })).metadata!;
    for (const key of ['requestId', 'responseId', 'reportedModelId', 'private']) assert.equal(Object.hasOwn(metadata, key), false);
    assert.equal(JSON.stringify(metadata).includes('unqualified-header'), false);
  }
  const validId = 'a'.repeat(200);
  const provider = createGroqStandardProvider(configuration, async () => metadataResponse({ id: validId }));
  assert.equal((await provider.complete(scope().request, { text: 'Move' })).metadata!.responseId, validId);
});

test('telemetry completeness reports presence, leaving arithmetic consistency to the consumer', async () => {
  const provider = createGroqStandardProvider(configuration, async () => metadataResponse({ usage: {
    prompt_tokens: 1, completion_tokens: 2, total_tokens: 99, prompt_tokens_details: { cached_tokens: 8 },
  } }));
  assert.deepEqual((await provider.complete(scope().request, { text: 'Move' })).metadata!.telemetry, {
    status: 'complete', promptTokens: 1, completionTokens: 2, cachedPromptTokens: 8, totalTokens: 99, invalidFields: [],
  });
});

test('qualified metadata survives invalid completion content while outcome stays unknown', async () => {
  for (const choices of [[], [{ message: { content: 'x'.repeat(201) }, finish_reason: 'stop' }],
    [{ message: { content: 'unfinished' }, finish_reason: 'length' }]]) {
    let calls = 0;
    const provider = createGroqStandardProvider(configuration, async () => { calls++; return metadataResponse({ choices }); });
    const result = await provider.complete(scope().request, { text: 'Move' });
    assert.equal(result.kind, 'unknown'); assert.equal(calls, 1);
    assert.equal(result.metadata!.requestId, 'req_fixture');
    assert.equal(result.metadata!.telemetry.status, 'complete');
    assert.equal(Object.hasOwn(result, 'value'), false);
  }
});

test('provider rejection and server ambiguity retain qualified metadata without changing kind', async () => {
  for (const status of [400, 429, 408, 500]) {
    let calls = 0;
    const provider = createGroqStandardProvider(configuration, async () => {
      calls++; return new Response(JSON.stringify({ ...metadataFixture, error: { message: 'private' } }), { status });
    });
    const result = await provider.complete(scope().request, { text: 'Move' });
    assert.equal(result.kind, status === 400 || status === 429 ? 'rejected' : 'unknown');
    assert.equal(result.metadata!.requestId, 'req_fixture'); assert.equal(result.metadata!.telemetry.promptTokens, 30);
    assert.equal(JSON.stringify(result).includes('private'), false); assert.equal(calls, 1);
  }
  for (const response of [new Response('{', { status: 400 }), new Response('x'.repeat(100), { status: 400 })]) {
    const provider = createGroqStandardProvider({ ...configuration, limits: { maxJsonBytes: 10 } }, async () => response);
    const result = await provider.complete(scope().request, { text: 'Move' });
    assert.equal(result.kind, 'rejected'); assert.equal(result.metadata!.telemetry.status, 'unavailable');
  }
});

test('cancellation does not read additional provider content for telemetry or advance dispatch', async () => {
  const context = scope();
  let reads = 0;
  let calls = 0;
  const provider = createGroqStandardProvider(configuration, async () => {
    calls++; context.abort.abort();
    return new Response(new ReadableStream({ pull(controller) { reads++; controller.close(); } }, { highWaterMark: 0 }));
  });
  const result = await provider.complete(context.request, { text: 'Move' });
  assert.equal(result.kind, 'unknown');
  assert.deepEqual(result.metadata, unavailableMetadata('complete', 'fixture-chat-model'));
  assert.equal((await provider.synthesize(context.request, { text: 'Move' })).kind, 'not_dispatched');
  assert.equal(reads, 0); assert.equal(calls, 1);
});

test('STT keeps only documented request identity and speech keeps units explicitly unavailable', async () => {
  const provider = createGroqStandardProvider(configuration, async url => url.endsWith('/transcriptions')
    ? json({ ...metadataFixture, text: 'Move', duration: 10, characters: 4 })
    : new Response(wav(), { headers: { 'x-request-id': 'unqualified-header' } }));
  const transcript = await provider.transcribe(scope().request, audio);
  assert.deepEqual(transcript.metadata, { ...unavailableMetadata('transcribe', 'whisper-large-v3-turbo'), requestId: 'req_fixture' });
  const speech = await provider.synthesize(scope().request, { text: 'Move' });
  assert.deepEqual(speech.metadata, unavailableMetadata('synthesize', 'canopylabs/orpheus-v1-english'));
  const malformedTranscript = createGroqStandardProvider(configuration, async () => json({ x_groq: { id: 'req_stt' } }));
  const failed = await malformedTranscript.transcribe(scope().request, audio);
  assert.equal(failed.kind, 'unknown'); assert.equal(failed.metadata!.requestId, 'req_stt');
});

test('metadata projection does not tighten previously accepted supplied model configuration', async () => {
  let calls = 0;
  const provider = createGroqStandardProvider({ ...configuration, completionModel: 'explicit model selection' }, async () => { calls++; return completion(); });
  assert.equal(provider.enabled, true);
  const result = await provider.complete(scope().request, { text: 'Move' });
  assert.equal(result.kind, 'succeeded'); assert.equal(calls, 1);
  assert.equal(result.metadata!.requestedModelId, 'explicit model selection');
  assert.equal(Object.hasOwn(result.metadata!, 'reportedModelId'), false);
});
