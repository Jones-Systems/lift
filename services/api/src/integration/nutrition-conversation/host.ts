import { randomUUID } from 'node:crypto';
import type { AccountContext, LifecycleBindings } from '../../lifecycle/types.js';
import { createRetainedGroundingRetriever } from '../../grounding/artifact.js';
import type { GroundingRetriever } from '../../grounding/index.js';
import { createNutritionConversationHost, type NutritionConversationHost, type ConversationRequest } from './index.js';
import { nutritionEnvelope, nutritionSelection, nutritionSubmit, nutritionWireSchema,
  type NutritionWireRequest, type NutritionSubmitRequest, type NutritionSelectionRequest, type NutritionWireResponse,
  type NutritionWireOperation, type NutritionWireCode, type NutritionWireStatus } from './wire.js';

export const nutritionLimits = Object.freeze({ perAccount: 2, conversations: 32, pending: 8,
  idleMs: 600000, absoluteMs: 1800000, acceptedTurns: 12, rejectedSubmissions: 16,
  citationAttempts: 24, responseBytes: 4 * 1024 * 1024, deadlineMs: 10000 });
type Limits = { [K in keyof typeof nutritionLimits]: number };
type Lease = { identity: object; controller: AbortController; deadline: number; invoked: boolean;
  cancelled: Promise<void>; cancel: () => void; clean: () => void; onCancel: (() => void) | undefined };
type Entry = { id: string; actor: AccountContext; created: number; touched: number; version: number;
  active: boolean; rejected: number; citations: number; host: NutritionConversationHost;
  invoking: Lease | null; leases: Set<Lease> };
export type NutritionDelivery = Readonly<{ serialize: () => { json: string; status: 200 | 201 } }>;
export type NutritionController = Readonly<{
  dispatch: (actor: AccountContext, operation: NutritionWireOperation,
    request: NutritionWireRequest | NutritionSubmitRequest | NutritionSelectionRequest,
    signal: AbortSignal, id?: string) => Promise<NutritionDelivery>;
  close: () => void;
}>;
const sameActor = (a: AccountContext, b: AccountContext) => a.accountId === b.accountId &&
  a.authUserId === b.authUserId && a.sessionId === b.sessionId && a.epoch === b.epoch;
const sessionKey = (actor: AccountContext) => JSON.stringify([actor.authUserId, actor.sessionId]);

export function createNutritionController(dependencies: {
  lifecycle: Pick<LifecycleBindings, 'assertActive'>;
  retriever?: GroundingRetriever;
  now?: () => number;
  limits?: Partial<Limits>;
}): NutritionController {
  const limits = { ...nutritionLimits, ...dependencies.limits };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('invalid-nutrition-host-limit');
  const now = dependencies.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const leases = new Set<Lease>();
  const pendingSessions = new Set<string>();
  let pending = 0, closed = false;
  const expires = (entry: Entry) => Math.min(entry.created + limits.absoluteMs, entry.touched + limits.idleMs);
  const invalidate = (entry: Entry) => {
    if (!entry.active) return;
    entry.active = false; entries.delete(entry.id); entry.host.dispose();
    for (const lease of entry.leases) lease.cancel();
  };
  const sweep = () => { for (const entry of entries.values()) if (now() >= expires(entry)) invalidate(entry); };
  const timer = setInterval(sweep, 30000); timer.unref();
  const usable = (entry: Entry) => {
    if (closed || !entry.active || now() >= expires(entry)) { invalidate(entry); return false; }
    return true;
  };
  const scope = <T>(entry: Entry, lease: Lease, effect: () => T): T => {
    const previous = entry.invoking; entry.invoking = lease;
    try { return effect(); } finally { entry.invoking = previous; }
  };
  function leaseFor(signal: AbortSignal): Lease {
    const controller = new AbortController();
    let cancel!: () => void;
    const cancelled = new Promise<void>(resolve => { cancel = () => { if (controller.signal.aborted) return; controller.abort(); resolve(); lease.onCancel?.(); }; });
    const lease: Lease = { identity: {}, controller, deadline: now() + limits.deadlineMs, invoked: false,
      cancelled, cancel, onCancel: undefined, clean: () => {} };
    const timeout = setTimeout(cancel, limits.deadlineMs); timeout.unref();
    const abort = () => cancel(); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) cancel();
    lease.clean = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); leases.delete(lease); };
    leases.add(lease); return lease;
  }
  function current(actor: AccountContext, lease: Lease, entry?: Entry): void {
    dependencies.lifecycle.assertActive(actor);
    if (closed || lease.controller.signal.aborted || now() >= lease.deadline || (entry && !usable(entry))) throw Error('delivery_unavailable');
    if (entry && !sameActor(actor, entry.actor)) throw Error('delivery_unavailable');
  }
  return Object.freeze({
    close() { closed = true; clearInterval(timer); for (const entry of [...entries.values()]) invalidate(entry); for (const lease of leases) { lease.cancel(); lease.clean(); } },
    async dispatch(actorInput: AccountContext, operation: NutritionWireOperation,
      raw: NutritionWireRequest | NutritionSubmitRequest | NutritionSelectionRequest, signal: AbortSignal, id?: string) {
      const request = operation === 'submit' ? nutritionSubmit.parse(raw) :
        operation === 'selectCitation' ? nutritionSelection.parse(raw) : nutritionEnvelope.parse(raw);
      const actor = Object.freeze({ ...actorInput });
      dependencies.lifecycle.assertActive(actor);
      sweep();
      const lease = leaseFor(signal);
      let entry: Entry | undefined;
      let status: NutritionWireStatus = 'ok', code: NutritionWireCode | null = null;
      let resetRequired = false;
      const unavailable = (reason: NutritionWireCode = 'conversation_unavailable') => {
        status = 'unavailable'; code = reason; resetRequired = true;
      };
      const discard = () => {
        if (entry) { entry.leases.delete(lease); lease.onCancel = undefined; invalidate(entry); entry = undefined; }
      };
      const bindLease = (selected: Entry) => { lease.onCancel = () => invalidate(selected); };
      const unknown = () => {
        discard();
        status = 'unknown'; code = 'outcome_unknown'; resetRequired = true;
      };
      try {
        current(actor, lease);
        if (!dependencies.retriever) unavailable('nutrition_unconfigured');
        else if (operation === 'resetFreshEmpty') {
          for (const prior of [...entries.values()]) if (sessionKey(prior.actor) === sessionKey(actor)) invalidate(prior);
          if (entries.size >= limits.conversations || [...entries.values()].filter(value => value.actor.accountId === actor.accountId).length >= limits.perAccount) unavailable('capacity_exceeded');
          else {
            const lifetime = { conversation: {}, generation: {} };
            const owner: { entry?: Entry } = {};
            const host = createNutritionConversationHost({ retriever: dependencies.retriever, bindings: {
              actor, lifetime, lifecycle: dependencies.lifecycle,
              isCurrentHost: () => !!owner.entry && usable(owner.entry),
              captureRequest: (): ConversationRequest => {
                const active = owner.entry?.invoking;
                if (!active) throw Error('request_required');
                return { identity: active.identity, signal: active.controller.signal };
              },
              isCurrentRequest: identity => !!owner.entry && [...owner.entry.leases].some(value =>
                value.identity === identity && !value.controller.signal.aborted && now() < value.deadline),
            } });
            if (host.status !== 'available') unavailable('nutrition_unconfigured');
            else {
              entry = { id: randomUUID(), actor, created: now(), touched: now(), version: 1, active: true,
                rejected: 0, citations: 0, host, invoking: null, leases: new Set([lease]) };
              owner.entry = entry; entries.set(entry.id, entry); bindLease(entry); lease.invoked = true; status = 'reset';
            }
          }
        } else {
          const found = id ? entries.get(id) : undefined;
          if (!found || !sameActor(found.actor, actor) || !usable(found)) unavailable();
          else {
            entry = found; entry.leases.add(lease); bindLease(entry); entry.touched = now();
            current(actor, lease, entry);
            if (operation === 'dispose') {
              discard(); status = 'disposed'; resetRequired = true;
            } else {
              const before = scope(entry, lease, () => entry!.host.snapshot());
              if (operation === 'submit') {
                if (before.conversation.turns.length >= limits.acceptedTurns || entry.rejected >= limits.rejectedSubmissions) unavailable('history_limit');
                else if (pendingSessions.has(sessionKey(actor)) || pending >= limits.pending) {
                  entry.rejected++; status = 'rejected'; code = 'turn_in_progress';
                } else {
                  lease.invoked = true; entry.version++; pending++; pendingSessions.add(sessionKey(actor));
                  const selected = entry;
                  const input = (request as NutritionSubmitRequest).input;
                  const settled = scope(selected, lease, () => selected.host.submit(input)).then(
                    () => ({ kind: 'settled' as const }), error => ({ kind: 'error' as const, error }),
                  ).finally(() => { pending--; pendingSessions.delete(sessionKey(actor)); selected.version++; });
                  const result = await Promise.race([settled, lease.cancelled.then(() => ({ kind: 'cancelled' as const }))]);
                  current(actor, lease, selected);
                  if (result.kind === 'cancelled') unknown();
                  else if (result.kind === 'error') {
                    selected.rejected++;
                    const message = result.error instanceof Error ? result.error.message : '';
                    if (message === 'stale-nutrition-turn' || message === 'nutrition-turn-in-progress') {
                      status = 'rejected'; code = message === 'stale-nutrition-turn' ? 'stale_turn' : 'turn_in_progress';
                    } else unknown();
                  } else {
                    const latest = scope(selected, lease, () => selected.host.snapshot()).conversation.turns.at(-1);
                    if (latest?.status === 'retrieval-unavailable' || latest?.status === 'synthesis-unavailable') {
                      status = 'unavailable'; code = latest.status === 'retrieval-unavailable' ? 'retrieval_unavailable' : 'synthesis_unavailable';
                    }
                  }
                }
              } else if (operation === 'selectCitation') {
                if (entry.citations >= limits.citationAttempts) unavailable('history_limit');
                else {
                  lease.invoked = true; entry.version++; entry.citations++;
                  const selected = scope(entry, lease, () => entry!.host.selectCitation((request as NutritionSelectionRequest).input));
                  const outcome = selected.selections.at(-1)?.status;
                  if (outcome !== 'selected') {
                    status = 'rejected'; code = outcome === 'stale-turn' ? 'stale_turn' : outcome === 'answer-unavailable' ? 'answer_unavailable' : 'unknown_statement';
                  }
                }
              }
            }
          }
        }
      } catch {
        if (lease.invoked) unknown(); else { discard(); unavailable(); }
      }
      let delivered = false;
      return Object.freeze({ serialize() {
        const empty = (): NutritionWireResponse => ({ schema: nutritionWireSchema, requestId: request.requestId, operation,
          status, code, binding: null, stateVersion: null, state: null, resetRequired });
        let response = empty();
        try {
          if (delivered) throw Error('delivery_consumed');
          current(actor, lease);
          if (entry && !resetRequired) {
            current(actor, lease, entry);
            const state = scope(entry, lease, () => entry!.host.snapshot());
            current(actor, lease, entry);
            response = { ...response, binding: { id: entry.id, expiresAt: new Date(expires(entry)).toISOString() }, stateVersion: entry.version, state };
          } else if (entry && resetRequired) discard();
          let json = JSON.stringify(response);
          if (Buffer.byteLength(json, 'utf8') > limits.responseBytes) {
            discard();
            status = 'unavailable'; code = 'response_limit'; resetRequired = true;
            json = JSON.stringify(empty());
          }
          current(actor, lease);
          return { json, status: status === 'reset' ? 201 as const : 200 as const };
        } catch {
          if (lease.invoked) unknown(); else { discard(); unavailable(); }
          return { json: JSON.stringify(empty()), status: 200 as const };
        } finally { delivered = true; entry?.leases.delete(lease); lease.onCancel = undefined; lease.clean(); }
      } });
    },
  });
}

export function createRetainedNutritionController(dependencies: {
  lifecycle: Pick<LifecycleBindings, 'assertActive'>; projectionBytes?: Uint8Array;
}): NutritionController {
  let retriever: GroundingRetriever | undefined;
  if (dependencies.projectionBytes) {
    try { retriever = createRetainedGroundingRetriever(dependencies.projectionBytes); } catch { /* Unverified bytes cannot establish a source. */ }
  }
  return createNutritionController({ lifecycle: dependencies.lifecycle, ...(retriever ? { retriever } : {}) });
}
