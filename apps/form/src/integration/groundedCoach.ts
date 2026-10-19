import type { FormResources } from '../api/resources';
import type { AuthAttemptGuard } from '../api/transport';
import { createGroundedAnswerCaller, type AnswerContext, type CitedStatement,
  type GroundedAnswerDependencies, type GroundedAnswerSnapshot } from '../api/groundedAnswer';

export type GroundedCoachDraft = Readonly<{ question: string; facts: readonly Readonly<{ id: string; text: string }>[] }>;
export type GroundedCoachDocuments = Readonly<{ profileRevision: number; preferencesRevision: number; isCurrent(): boolean }>;
export type GroundedCoachReview = GroundedCoachDraft & Readonly<{
  confirm(): GroundedCoachSnapshot;
  cancel(): GroundedCoachSnapshot;
}>;
export type GroundedCoachSnapshot = Readonly<{
  status: 'editing' | 'review' | 'confirmed' | 'cancelled' | 'stale' | 'unavailable' | 'disposed';
  code: string | null;
  draft: GroundedCoachDraft | null;
  review: GroundedCoachReview | null;
  context: AnswerContext | null;
  answer: GroundedAnswerSnapshot;
}>;
export type GroundedCoachOptions = Readonly<{
  resources: FormResources;
  accountId: string;
  sessionGeneration: string;
  isCurrentSession: GroundedAnswerDependencies['isCurrentSession'];
  newRevision(): string;
  captureDocuments(): GroundedCoachDocuments | null;
}>;
export type GroundedCoachEntry = Readonly<{
  getSnapshot(): GroundedCoachSnapshot;
  edit(draft: GroundedCoachDraft): GroundedCoachSnapshot;
  review(): GroundedCoachSnapshot;
  ask(): Promise<GroundedAnswerSnapshot>;
  selectCitation(statementId: string): CitedStatement | null;
  cancel(): GroundedCoachSnapshot;
  invalidate(): GroundedCoachSnapshot;
  dispose(): GroundedCoachSnapshot;
}>;

const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/[\uD800-\uDFFF]/u.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function data(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && 'value' in descriptor && descriptor.enumerable;
  });
}
function copyDraft(value: unknown): GroundedCoachDraft | null {
  if (!data(value, ['question', 'facts']) || typeof value.question !== 'string' || !Array.isArray(value.facts) ||
      Object.keys(value.facts).length !== value.facts.length) return null;
  const facts: { id: string; text: string }[] = [];
  for (let index = 0; index < value.facts.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.facts, index);
    if (!descriptor || !('value' in descriptor) || !data(descriptor.value, ['id', 'text']) ||
        typeof descriptor.value.id !== 'string' || typeof descriptor.value.text !== 'string') return null;
    facts.push(Object.freeze({ id: descriptor.value.id, text: descriptor.value.text }));
  }
  return Object.freeze({ question: value.question, facts: Object.freeze(facts) });
}
function contextFor(draft: GroundedCoachDraft, id: string, supersedesRevision: string | null): AnswerContext {
  return Object.freeze({ revision: id, facts: Object.freeze(draft.facts.map(fact => Object.freeze({ ...fact, origin: 'user_provided' as const }))), supersedesRevision });
}
function admitted(draft: GroundedCoachDraft, context: AnswerContext): boolean {
  return text(draft.question) && /[\p{L}\p{N}]/u.test(draft.question) && text(context.revision) &&
    context.revision !== context.supersedesRevision && draft.facts.every(fact => text(fact.id) && text(fact.text)) &&
    new Set(draft.facts.map(fact => fact.id)).size === draft.facts.length &&
    new TextEncoder().encode(JSON.stringify({ retrieval: { query: draft.question }, context })).length <= 64 * 1024;
}
function sameContext(value: AnswerContext, original: AnswerContext): boolean {
  return data(value, ['revision', 'facts', 'supersedesRevision']) && value.revision === original.revision &&
    value.supersedesRevision === original.supersedesRevision && Array.isArray(value.facts) && value.facts.length === original.facts.length &&
    Object.keys(value.facts).length === value.facts.length &&
    value.facts.every((fact, index) => data(fact, ['id', 'text', 'origin']) && fact.id === original.facts[index]!.id &&
      fact.text === original.facts[index]!.text && fact.origin === 'user_provided');
}
const emptyAnswer = (status: GroundedAnswerSnapshot['status'], code: string | null = null): GroundedAnswerSnapshot => Object.freeze({ status, code, answer: null });

export function createGroundedCoach(options: GroundedCoachOptions): GroundedCoachEntry {
  const { resources, accountId, sessionGeneration, isCurrentSession, newRevision, captureDocuments } = options;
  const api = resources?.api;
  let auth: AuthAttemptGuard | null = null;
  try { auth = api?.captureAuthContext() ?? null; } catch {}
  let configured = !!api && !!auth && text(accountId) && text(sessionGeneration) && typeof isCurrentSession === 'function' &&
    typeof newRevision === 'function' && typeof captureDocuments === 'function';
  let disposed = false, expired = false, sequence = 0;
  let status: GroundedCoachSnapshot['status'] = configured ? 'editing' : 'unavailable';
  let code: string | null = configured ? null : 'grounded_coach_scope_unavailable';
  let draft: GroundedCoachDraft | null = null, review: GroundedCoachReview | null = null, context: AnswerContext | null = null;
  let documents: (() => boolean) | null = null, confirmedQuestion: string | null = null, supersedes: string | null = null;
  let pending: Promise<GroundedAnswerSnapshot> | null = null;
  let answerIssued = false;
  let caller: ReturnType<typeof createGroundedAnswerCaller> | null = null;
  const issuedRevisions = new Set<string>();

  function current(): boolean {
    if (!configured || disposed || expired) return false;
    try {
      if (options.resources !== resources || resources.api !== api || options.accountId !== accountId || options.sessionGeneration !== sessionGeneration ||
          options.isCurrentSession !== isCurrentSession || options.captureDocuments !== captureDocuments || options.newRevision !== newRevision ||
          auth!.isCurrent() !== true || isCurrentSession(accountId, sessionGeneration) !== true) expired = true;
    } catch { expired = true; }
    return !expired;
  }
  function clear(next: GroundedCoachSnapshot['status'], reason: string | null, clearDraft = false): void {
    sequence++; caller?.invalidate(); review = null; context = null; documents = null; confirmedQuestion = null; pending = null; answerIssued = false;
    if (clearDraft) draft = null;
    status = next; code = reason;
  }
  function scopeCurrent(): boolean {
    if (!current()) return false;
    try { return !documents || documents() === true; } catch { return false; }
  }
  function getSnapshot(): GroundedCoachSnapshot {
    if (!disposed && configured && !current()) clear('stale', 'session_changed', true);
    else if (!disposed && documents && !scopeCurrent()) clear('stale', 'context_changed');
    const answer = caller?.getSnapshot() ?? emptyAnswer('unavailable', 'grounded_coach_scope_unavailable');
    if (context && answerIssued && answer.status === 'stale') clear('stale', answer.code ?? 'context_changed');
    return Object.freeze({ status, code, draft, review, context,
      answer: disposed ? emptyAnswer('disposed') : context && answerIssued ? answer :
        emptyAnswer(status === 'stale' ? 'stale' : status === 'unavailable' ? 'unavailable' : 'idle', code) });
  }
  function stale(): GroundedCoachSnapshot {
    return Object.freeze({ status: 'stale', code: 'review_changed', draft: null, review: null, context: null, answer: emptyAnswer('stale', 'review_changed') });
  }
  if (configured) {
    try {
      caller = createGroundedAnswerCaller({ api, accountId, sessionGeneration, isCurrentSession,
        captureRequest() {
          const captured = sequence;
          return Object.freeze({ isCurrent: () => sequence === captured && scopeCurrent() });
        },
        captureContext(value) {
          const captured = sequence, original = context;
          const matched = !!original && sameContext(value, original);
          return Object.freeze({ isCurrent: () => matched && sequence === captured && context === original && scopeCurrent() && sameContext(value, original!) });
        },
      });
    } catch { configured = false; status = 'unavailable'; code = 'grounded_coach_scope_unavailable'; }
  }
  function cancel(): GroundedCoachSnapshot {
    if (disposed) return getSnapshot();
    if (!current()) return getSnapshot();
    clear('cancelled', null, true); return getSnapshot();
  }
  return Object.freeze({
    getSnapshot,
    edit(value: GroundedCoachDraft): GroundedCoachSnapshot {
      if (disposed || !current()) return getSnapshot();
      clear('editing', null, true); draft = copyDraft(value);
      if (!draft) { status = 'unavailable'; code = 'invalid_request'; }
      return getSnapshot();
    },
    review(): GroundedCoachSnapshot {
      getSnapshot();
      if (!current() || !caller) return getSnapshot();
      if (!draft) { clear('unavailable', 'invalid_request'); return getSnapshot(); }
      clear('editing', null);
      const captured = sequence, original = draft;
      if (!admitted(original, contextFor(original, '00000000-0000-4000-8000-000000000000', supersedes))) {
        status = 'unavailable'; code = 'invalid_request'; return getSnapshot();
      }
      let witness: GroundedCoachDocuments | null;
      try { witness = captureDocuments(); } catch { witness = null; }
      if (sequence !== captured || !current()) return getSnapshot();
      if (!witness || !revision(witness.profileRevision) || !revision(witness.preferencesRevision) || typeof witness.isCurrent !== 'function') {
        status = 'unavailable'; code = 'grounded_coach_documents_unavailable'; return getSnapshot();
      }
      const capturedDocuments = witness;
      const profileRevision = witness.profileRevision, preferencesRevision = witness.preferencesRevision, isCurrent = witness.isCurrent.bind(witness);
      let invalidated = false;
      documents = () => {
        try { if (capturedDocuments.profileRevision !== profileRevision || capturedDocuments.preferencesRevision !== preferencesRevision || isCurrent() !== true) invalidated = true; }
        catch { invalidated = true; }
        return !invalidated;
      };
      if (!scopeCurrent()) { clear('stale', 'context_changed'); return getSnapshot(); }
      const issued: GroundedCoachReview = Object.freeze({ ...original,
        confirm(): GroundedCoachSnapshot {
          if (this !== issued || review !== issued || captured !== sequence) return stale();
          if (!scopeCurrent()) return getSnapshot();
          if (context) return getSnapshot();
          let id: string;
          try { id = newRevision(); } catch {
            if (captured !== sequence || review !== issued) return stale();
            clear('unavailable', 'grounded_coach_revision_unavailable'); return getSnapshot();
          }
          if (captured !== sequence || review !== issued) return stale();
          if (!scopeCurrent()) return getSnapshot();
          const confirmed = contextFor(original, id, supersedes);
          if (!admitted(original, confirmed) || issuedRevisions.has(id)) { clear('unavailable', 'invalid_request'); return getSnapshot(); }
          issuedRevisions.add(id); context = confirmed; confirmedQuestion = original.question; supersedes = id;
          status = 'confirmed'; code = null; return getSnapshot();
        },
        cancel(): GroundedCoachSnapshot {
          return this === issued && review === issued && captured === sequence ? cancel() : stale();
        },
      });
      review = issued; status = 'review'; code = null; return getSnapshot();
    },
    ask(): Promise<GroundedAnswerSnapshot> {
      getSnapshot();
      if (!scopeCurrent() || !context || confirmedQuestion === null || !caller) return Promise.resolve(getSnapshot().answer);
      if (pending) return pending;
      const captured = sequence, original = context, question = confirmedQuestion, originalCaller = caller;
      let finish!: (snapshot: GroundedAnswerSnapshot) => void;
      const task = new Promise<GroundedAnswerSnapshot>(resolve => { finish = resolve; }); pending = task; answerIssued = true;
      status = 'confirmed'; code = null;
      void (async () => {
        try {
          const answer = await originalCaller.ask(question, original);
          if (captured === sequence && scopeCurrent() && answer.status === 'unavailable') { status = 'unavailable'; code = answer.code; }
        } catch {
          if (captured === sequence && scopeCurrent()) { answerIssued = false; status = 'unavailable'; code = 'grounded_answer_unavailable'; }
        } finally {
          if (pending === task) pending = null;
          finish(captured === sequence ? getSnapshot().answer : emptyAnswer('stale', 'review_changed'));
        }
      })();
      return task;
    },
    selectCitation(statementId: string): CitedStatement | null {
      const snapshot = getSnapshot();
      return snapshot.context && snapshot.answer.status === 'ready' ? caller!.selectCitation(statementId) : null;
    },
    cancel,
    invalidate(): GroundedCoachSnapshot {
      if (!disposed) clear('stale', 'context_changed');
      return getSnapshot();
    },
    dispose(): GroundedCoachSnapshot {
      if (!disposed) { clear('disposed', null, true); disposed = true; supersedes = null; issuedRevisions.clear(); caller?.dispose(); }
      return getSnapshot();
    },
  });
}
