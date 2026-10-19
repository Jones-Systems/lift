import { performance } from 'node:perf_hooks';
import { DomainError } from '../errors.js';
import type { AccountContext, LifecycleBindings } from '../lifecycle/types.js';
export const actionLimits = Object.freeze({ invitation_attempt: 10, invitation_issue: 5, post: 10, reaction: 30, report: 5, motion: 5 });
export type LimitedAction = keyof typeof actionLimits;
export class CommunityLimiter {
  private readonly entries = new Map<string, number[]>();
  private last: number;
  private readonly started: number;
  private failed = false;
  constructor(private readonly lifecycle: LifecycleBindings, private readonly clock: () => number = () => performance.now()) {
    this.started = this.last = clock();
    if (!Number.isFinite(this.started) || this.started < 0) this.failed = true;
  }
  private time(): number {
    const now = this.clock();
    if (this.failed || !Number.isFinite(now) || now < this.last) { this.failed = true; throw new DomainError(503, 'community_limiter_unavailable'); }
    this.last = now; return now;
  }
  readiness(): 'warming_up' | 'ready' { return this.time() - this.started < 60000 ? 'warming_up' : 'ready'; }
  consume = (actor: AccountContext, action: LimitedAction): void => {
    if (!Object.hasOwn(actionLimits, action) || !actor.accountId) throw new DomainError(503, 'community_limiter_unavailable');
    this.lifecycle.withActiveWrite(actor, () => {
      const now = this.time();
      if (now - this.started < 60000) throw new DomainError(503, 'community_limiter_warming_up');
      for (const [key, queue] of this.entries) {
        while (queue.length && queue[0]! <= now - 60000) queue.shift();
        if (!queue.length) this.entries.delete(key);
      }
      const key = JSON.stringify([actor.accountId, action]);
      let queue = this.entries.get(key);
      if (!queue) { if (this.entries.size >= 4096) throw new DomainError(429, 'community_limiter_capacity'); queue = []; this.entries.set(key, queue); }
      if (queue.length >= actionLimits[action]) throw new DomainError(429, 'community_rate_limited');
      queue.push(now);
    });
  };
}
