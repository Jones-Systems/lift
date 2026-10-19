import type { CoachingRequestScope, ProviderOutcome } from '../contracts.js';
import { projectStandardMetadata, type StandardOperation, type StandardOutcome } from './metadata.js';

export type StandardAudioFormat = 'wav' | 'm4a' | 'webm' | 'mp3' | 'mp4' | 'mpeg' | 'mpga' | 'ogg' | 'flac';
export type StandardAudioInput = Readonly<{ audio: Blob; format: StandardAudioFormat }>;
export type StandardTextInput = Readonly<{ text: string }>;
export type StandardSpeech = Readonly<{ audio: Uint8Array; mediaType: 'audio/wav' }>;
export type StandardProvider = Readonly<{
  enabled: boolean;
  transcribe(scope: CoachingRequestScope, input: StandardAudioInput): Promise<StandardOutcome<string>>;
  complete(scope: CoachingRequestScope, input: StandardTextInput): Promise<StandardOutcome<string>>;
  synthesize(scope: CoachingRequestScope, input: StandardTextInput): Promise<StandardOutcome<StandardSpeech>>;
}>;
export type GroqLimits = Readonly<{
  maxAudioBytes: number;
  maxTextCharacters: number;
  maxReplyCharacters: number;
  maxJsonBytes: number;
  maxSpeechBytes: number;
  maxCompletionTokens: number;
  timeoutMs: number;
}>;
export type GroqStandardConfiguration = Readonly<{
  apiKey?: string;
  transcriptionModel?: string;
  completionModel?: string;
  speechModel?: string;
  voice?: string;
  limits?: Partial<GroqLimits>;
}>;
export type GroqHttp = (url: string, init: RequestInit) => Promise<Response>;

const origin = 'https://api.groq.com/openai/v1';
const defaults: GroqLimits = Object.freeze({
  maxAudioBytes: 10 * 1024 * 1024,
  maxTextCharacters: 8_000,
  maxReplyCharacters: 200,
  maxJsonBytes: 128 * 1024,
  maxSpeechBytes: 5 * 1024 * 1024,
  maxCompletionTokens: 256,
  timeoutMs: 30_000,
});
const formats = new Set<string>(['wav', 'm4a', 'webm', 'mp3', 'mp4', 'mpeg', 'mpga', 'ogg', 'flac']);
const voices = new Set<string>(['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy']);
const length = (text: string): number => Array.from(text).length;
const textWithin = (text: unknown, maximum: number): text is string =>
  typeof text === 'string' && text.trim().length > 0 && length(text) <= maximum;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function current(scope: CoachingRequestScope): void {
  scope.signal.throwIfAborted();
  scope.assertCurrent();
}

async function readBounded(response: Response, limit: number, scope: CoachingRequestScope, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new Error('response_bound');
  }
  if (!response.body) throw new Error('missing_body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      current(scope);
      const chunk = await reader.read();
      signal.throwIfAborted();
      current(scope);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error('response_bound');
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 44) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.byteLength) return false;
  let offset = 12;
  let format = false;
  let data = false;
  while (offset + 8 <= bytes.byteLength) {
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    if (end > bytes.byteLength) return false;
    if (tag(offset) === 'fmt ') {
      if (size < 16 || view.getUint16(offset + 10, true) === 0 || view.getUint32(offset + 12, true) === 0) return false;
      format = true;
    }
    if (tag(offset) === 'data' && size > 0) data = true;
    offset = end + size % 2;
  }
  return format && data && offset === bytes.byteLength;
}

export function createGroqStandardProvider(configuration: GroqStandardConfiguration, http: GroqHttp = fetch): StandardProvider {
  const config = Object.freeze({ ...configuration });
  const limits = Object.freeze({ ...defaults, ...configuration.limits });
  const limitsValid = Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0)
    && limits.maxAudioBytes <= 25_000_000 && limits.maxReplyCharacters <= 200
    && limits.maxTextCharacters <= 32_000 && limits.maxJsonBytes <= 1_048_576
    && limits.maxSpeechBytes <= 25_000_000 && limits.maxCompletionTokens <= 2_048
    && limits.timeoutMs <= 120_000;
  const enabled = limitsValid && textWithin(config.apiKey, 4096) && !/[\r\n]/.test(config.apiKey)
    && ['whisper-large-v3', 'whisper-large-v3-turbo'].includes(config.transcriptionModel ?? '')
    && textWithin(config.completionModel, 200) && config.speechModel === 'canopylabs/orpheus-v1-english'
    && voices.has(config.voice ?? '');

  function admission(scope: CoachingRequestScope): ProviderOutcome<never> | undefined {
    if (!enabled) return { kind: 'not_dispatched', reason: 'standard_provider_disabled' };
    try { current(scope); } catch { return { kind: 'not_dispatched', reason: 'scope_not_current' }; }
    return undefined;
  }

  async function dispatch<T>(scope: CoachingRequestScope, operation: StandardOperation, requestedModelId: string,
    path: string, body: BodyInit, json: boolean, bound: number,
    decode: (bytes: Uint8Array, payload: unknown) => T): Promise<StandardOutcome<T>> {
    const denied = admission(scope);
    if (denied) return denied;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), limits.timeoutMs);
    const signal = AbortSignal.any([scope.signal, deadline.signal]);
    let response: Response | undefined;
    let dispatched = false;
    let metadata = projectStandardMetadata(operation, requestedModelId);
    try {
      current(scope);
      dispatched = true;
      response = await http(`${origin}${path}`, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${config.apiKey}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
        body,
      });
      signal.throwIfAborted();
      current(scope);
      if (!response.ok) {
        if (operation === 'synthesize') await response.body?.cancel();
        else {
          try {
            const bytes = await readBounded(response, bound, scope, signal);
            signal.throwIfAborted();
            current(scope);
            metadata = projectStandardMetadata(operation, requestedModelId, decodeJson(bytes));
          } catch {
            metadata = projectStandardMetadata(operation, requestedModelId);
          }
        }
        signal.throwIfAborted();
        current(scope);
        return response.status >= 400 && response.status < 500 && response.status !== 408
          ? { kind: 'rejected', reason: `provider_http_${response.status}`, metadata }
          : { kind: 'unknown', reason: 'provider_http_ambiguous', metadata };
      }
      const bytes = await readBounded(response, bound, scope, signal);
      signal.throwIfAborted();
      current(scope);
      const payload: unknown = operation === 'synthesize' ? undefined : decodeJson(bytes);
      metadata = projectStandardMetadata(operation, requestedModelId, payload);
      const value = decode(bytes, payload);
      current(scope);
      return { kind: 'succeeded', value, metadata };
    } catch {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
      return dispatched
        ? { kind: 'unknown', reason: 'provider_outcome_unknown', metadata }
        : { kind: 'not_dispatched', reason: 'scope_not_current' };
    } finally {
      clearTimeout(timer);
    }
  }

  const decodeJson = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  return Object.freeze({
    enabled,
    async transcribe(scope: CoachingRequestScope, input: StandardAudioInput): Promise<StandardOutcome<string>> {
      const denied = admission(scope);
      if (denied) return denied;
      if (!(input.audio instanceof Blob) || input.audio.size === 0 || input.audio.size > limits.maxAudioBytes || !formats.has(input.format)) {
        return { kind: 'not_dispatched', reason: 'invalid_audio_input' };
      }
      const body = new FormData();
      body.set('file', input.audio, `recording.${input.format}`);
      body.set('model', config.transcriptionModel!);
      body.set('response_format', 'json');
      return dispatch(scope, 'transcribe', config.transcriptionModel!, '/audio/transcriptions', body, false, limits.maxJsonBytes, (_bytes, value) => {
        if (!record(value) || !textWithin(value.text, limits.maxTextCharacters)) throw new Error('invalid_transcript');
        return value.text;
      });
    },
    async complete(scope: CoachingRequestScope, input: StandardTextInput): Promise<StandardOutcome<string>> {
      const denied = admission(scope);
      if (denied) return denied;
      if (!textWithin(input.text, limits.maxTextCharacters)) return { kind: 'not_dispatched', reason: 'invalid_text_input' };
      const body = JSON.stringify({
        model: config.completionModel, stream: false, max_completion_tokens: limits.maxCompletionTokens,
        messages: [
          { role: 'system', content: `Give one brief coaching response in at most ${limits.maxReplyCharacters} Unicode characters. Use plain spoken text. Do not claim to change the workout or account.` },
          { role: 'user', content: input.text },
        ],
      });
      return dispatch(scope, 'complete', config.completionModel!, '/chat/completions', body, true, limits.maxJsonBytes, (_bytes, value) => {
        const choice: unknown = record(value) && Array.isArray(value.choices) ? value.choices[0] : undefined;
        if (!record(choice) || choice.finish_reason !== 'stop' || !record(choice.message)
          || !textWithin(choice.message.content, limits.maxReplyCharacters)) throw new Error('invalid_completion');
        return choice.message.content;
      });
    },
    async synthesize(scope: CoachingRequestScope, input: StandardTextInput): Promise<StandardOutcome<StandardSpeech>> {
      const denied = admission(scope);
      if (denied) return denied;
      if (!textWithin(input.text, limits.maxReplyCharacters)) return { kind: 'not_dispatched', reason: 'invalid_speech_input' };
      const body = JSON.stringify({ model: config.speechModel, voice: config.voice, input: input.text, response_format: 'wav' });
      return dispatch(scope, 'synthesize', config.speechModel!, '/audio/speech', body, true, limits.maxSpeechBytes, bytes => {
        if (!isWav(bytes)) throw new Error('invalid_wav');
        return { audio: bytes, mediaType: 'audio/wav' as const };
      });
    },
  });
}
