import type { StandardClientTurnPort } from './contracts';
import { createStandardWireCodec, StandardWireError, type StandardWireLimits } from './wire-codec';

export type StandardWireExchange = (request: string, signal: AbortSignal) => Promise<string>;

/** The exchange owns transport/authentication; local lifecycle capabilities never become payload fields. */
export function createStandardWireTurn(options: Readonly<{
  limits: StandardWireLimits;
  exchange: StandardWireExchange;
}>): StandardClientTurnPort {
  const codec = createStandardWireCodec(options.limits);
  const exchange = options.exchange;
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
      if (!(audioBlob instanceof Blob) || audioBlob.type !== 'audio/wav') throw new StandardWireError('media');
      if (!audioBlob.size || audioBlob.size > codec.limits.maxAudioBytes) throw new StandardWireError('size');
      const buffer = await audioBlob.arrayBuffer();
      current();
      const request = codec.encodeRequest({ audio: new Uint8Array(buffer), mediaType: 'audio/wav' });
      current();
      const response = await exchange(request, signal);
      current();
      const result = codec.decodeResult(response);
      current();
      return result;
    },
  });
}
