import type { StandardClientTurnPort } from './contracts';
import { createStandardWireCodec, StandardWireError, type StandardWireLimits } from './wire-codec';
import { standardWireUsageOutcome } from './wire-usage';

/** Per-turn delivery context. The key is derived from the turn's session id, never stored, and identical on every attempt. */
export type StandardWireTurnContext = Readonly<{ idempotencyKey: string; attempt: 1 | 2 }>;
export type StandardWireExchange = (request: string, signal: AbortSignal, turn: StandardWireTurnContext) => Promise<string>;

// The server accepts 8-128 characters of this alphabet; the fixed prefix leaves 112 for the session id.
const sessionKeyPattern = /^[A-Za-z0-9_.:-]{1,112}$/;
/** One key per user turn: `std-turn:` plus that turn's session id. Refuses an id that is not key-safe. */
export function standardTurnIdempotencyKey(sessionId: string): string {
  if (typeof sessionId !== 'string' || !sessionKeyPattern.test(sessionId)) throw new Error('standard_wire_key_invalid');
  return `std-turn:${sessionId}`;
}

/**
 * The exchange owns transport/authentication; local lifecycle capabilities never become payload fields.
 * `retryUnknownResult` is absent by default (exactly one attempt). When supplied and it returns exactly `true` for the
 * first attempt's error, one more attempt carries the same key and the same encoded request.
 */
export function createStandardWireTurn(options: Readonly<{
  limits: StandardWireLimits;
  exchange: StandardWireExchange;
  retryUnknownResult?: (error: unknown) => boolean;
}>): StandardClientTurnPort {
  const codec = createStandardWireCodec(options.limits);
  const exchange = options.exchange;
  const retryUnknownResult = options.retryUnknownResult;
  return Object.freeze({
    async run(input: Parameters<StandardClientTurnPort['run']>[0]) {
      const { signal, sessionId, audioBlob } = input;
      const assertCurrent = input.assertCurrent.bind(input);
      const isCurrent = input.scope.isCurrent.bind(input.scope);
      const account = Object.freeze({ ...input.scope.account });
      const fence = Object.freeze({ ...input.fence });
      function current(): void {
        signal.throwIfAborted();
        assertCurrent();
        if (!isCurrent() || fence.accountId !== account.accountId || fence.authSessionId !== account.authSessionId
          || fence.accountEpoch !== account.accountEpoch || !Number.isSafeInteger(fence.generation) || fence.generation < 1
          || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 128) {
          throw new Error('standard_wire_scope_stale');
        }
        signal.throwIfAborted();
      }
      current();
      const idempotencyKey = standardTurnIdempotencyKey(sessionId);
      if (!(audioBlob instanceof Blob) || audioBlob.type !== 'audio/wav') throw new StandardWireError('media');
      if (!audioBlob.size || audioBlob.size > codec.limits.maxAudioBytes) throw new StandardWireError('size');
      const buffer = await audioBlob.arrayBuffer();
      current();
      const request = codec.encodeRequest({ audio: new Uint8Array(buffer), mediaType: 'audio/wav' });
      let response: string;
      for (let attempt: 1 | 2 = 1; ; attempt = 2) {
        current();
        try {
          response = await exchange(request, signal, Object.freeze({ idempotencyKey, attempt }));
          break;
        } catch (error) {
          if (attempt !== 1 || !retryUnknownResult || signal.aborted) throw error;
          let retry = false;
          try { retry = retryUnknownResult(error) === true; } catch { retry = false; }
          if (!retry) throw error;
        }
      }
      current();
      const result = codec.decodeResult(response);
      current();
      const usage = standardWireUsageOutcome(result);
      return usage ? Object.freeze({ ...result, usage }) : result;
    },
  });
}
