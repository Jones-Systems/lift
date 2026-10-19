import type { CoachingRequestScope } from '../contracts.js';
import type { StandardTurnController } from '../turn-controller.js';
import { createStandardWireCodec, type StandardWireLimits } from './wire-codec.js';

/** Unmounted: callers supply an independently authenticated scope and server-configured controller. */
export function createStandardWireHandler(options: Readonly<{
  limits: StandardWireLimits;
  controller: StandardTurnController;
}>) {
  const codec = createStandardWireCodec(options.limits);
  const run = options.controller.run.bind(options.controller);
  return Object.freeze({
    async run(scope: CoachingRequestScope, request: string): Promise<string> {
      const signal = scope.signal;
      const assertCurrent = scope.assertCurrent.bind(scope);
      const original = Object.freeze({ actor: Object.freeze({ ...scope.actor }), signal, assertCurrent });
      function current(): void {
        signal.throwIfAborted();
        assertCurrent();
        signal.throwIfAborted();
      }
      current();
      const input = codec.decodeRequest(request);
      const audio = new Blob([new Uint8Array(input.audio).buffer], { type: 'audio/wav' });
      current();
      const result = await run(original, { audio, format: 'wav' });
      current();
      return codec.encodeResult(result);
    },
  });
}
