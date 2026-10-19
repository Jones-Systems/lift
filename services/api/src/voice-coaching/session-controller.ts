import type { AccountContext, LifecycleBindings } from '../lifecycle/types.js';
import type { CoachingRequestScope } from './contracts.js';
import { createCoachingRequestScope } from './request-scope.js';

export class CoachingSessionController {
  readonly scope: CoachingRequestScope;
  private readonly abort = new AbortController();
  private generation = 0;
  private readonly detach: () => void;

  constructor(actor: AccountContext, lifecycle: Pick<LifecycleBindings, 'assertActive'>, signal: AbortSignal) {
    this.scope = createCoachingRequestScope(actor, lifecycle, AbortSignal.any([signal, this.abort.signal]));
    const onAbort = () => { this.stop('request_aborted'); };
    signal.addEventListener('abort', onAbort, { once: true });
    this.detach = () => signal.removeEventListener('abort', onAbort);
  }

  async run<T>(operation: (scope: CoachingRequestScope) => Promise<T>): Promise<T> {
    this.scope.assertCurrent();
    const generation = this.generation;
    const result = await operation(this.scope);
    this.scope.assertCurrent();
    if (this.generation !== generation) throw new Error('coaching_session_stale');
    return result;
  }

  stop(reason: string): void {
    if (this.abort.signal.aborted) return;
    ++this.generation;
    this.detach();
    this.abort.abort(reason);
  }
}
