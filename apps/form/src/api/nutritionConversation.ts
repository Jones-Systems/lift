import type { AuthAttemptGuard, FormTransport } from './transport';

export const nutritionWireSchema = 'form.nutrition-conversation-wire/v1' as const;
export type NutritionWireOperation = 'resetFreshEmpty' | 'submit' | 'selectCitation' | 'snapshot' | 'dispose';
export type NutritionWireStatus = 'reset' | 'ok' | 'rejected' | 'unavailable' | 'unknown' | 'disposed';
export type NutritionWireCode = 'stale_turn' | 'turn_in_progress' | 'answer_unavailable' | 'unknown_statement'
  | 'retrieval_unavailable' | 'synthesis_unavailable' | 'nutrition_unconfigured' | 'conversation_unavailable'
  | 'capacity_exceeded' | 'history_limit' | 'response_limit' | 'outcome_unknown';
export type NutritionWireBinding = Readonly<{ id: string; expiresAt: string }>;
export type NutritionConversationInput = Readonly<{
  choice: 'ask' | 'continue-question' | 'source-explanation' | 'request-clarification' | 'correct-question' | 'update-context';
  previousTurnId: number | null;
  job: 'energy-uncertainty' | 'deficit-surplus-rate' | 'protein' | 'nutrients-dietary-patterns' | 'logging-accuracy' | 'supplements' | 'nutrition-boundaries';
  question: string;
  userContext: readonly string[];
  correction: string | null;
}>;
export type NutritionCitationRequest = Readonly<{ parentTurnId: number; statementId: string }>;
export type NutritionWireResponse<TState> = Readonly<{
  schema: typeof nutritionWireSchema;
  requestId: string;
  operation: NutritionWireOperation;
  status: NutritionWireStatus;
  code: NutritionWireCode | null;
  binding: NutritionWireBinding | null;
  stateVersion: number | null;
  state: TState | null;
  resetRequired: boolean;
}>;
export type NutritionStateValidation<TState> = Readonly<{
  isComplete(value: unknown): value is TState;
  isFreshEmpty(value: TState): boolean;
}>;
type LocalCode = 'validation_unavailable' | 'invalid_wire' | 'invalid_input' | 'session_changed' | 'request_changed';
export type NutritionConversationSnapshot<TState> = Readonly<{
  status: NutritionWireStatus | 'pending';
  code: NutritionWireCode | LocalCode | null;
  binding: NutritionWireBinding | null;
  stateVersion: number | null;
  state: TState | null;
  resetRequired: boolean;
}>;
export type NutritionConversationDependencies<TState> = Readonly<{
  api: Pick<FormTransport, 'request' | 'captureAuthContext'>;
  accountId: string;
  sessionGeneration: string;
  isCurrentSession(accountId: string, sessionGeneration: string): boolean;
  captureRequest(): AuthAttemptGuard;
  newRequestId(): string;
  stateValidation?: NutritionStateValidation<TState>;
  now?: () => number;
}>;

const codes: readonly NutritionWireCode[] = ['stale_turn', 'turn_in_progress', 'answer_unavailable', 'unknown_statement',
  'retrieval_unavailable', 'synthesis_unavailable', 'nutrition_unconfigured', 'conversation_unavailable',
  'capacity_exceeded', 'history_limit', 'response_limit', 'outcome_unknown'];
const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const fields = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const bytes = (value: string) => new TextEncoder().encode(value).length;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.trim().length > 0 && bytes(value) <= limit;
const futureInstant = (value: unknown, now: number): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > now && new Date(time).toISOString() ===
    value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
};

function copyData(value: unknown, depth = 0, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || depth > 64 || ancestors.has(value)) throw new Error('invalid_data');
  const array = Array.isArray(value), keys = Reflect.ownKeys(value);
  if ((!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    keys.some(key => typeof key !== 'string') || (array && keys.length !== value.length + 1)) throw new Error('invalid_data');
  ancestors.add(value);
  const result: Record<string, unknown> | unknown[] = array ? [] : {};
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (array && !/^(0|[1-9][0-9]*)$/.test(String(key))) throw new Error('invalid_data');
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in property) || !property.enumerable) throw new Error('invalid_data');
    Object.defineProperty(result, key, { value: copyData(property.value, depth + 1, ancestors), enumerable: true });
  }
  ancestors.delete(value);
  return Object.freeze(result);
}

function validInput(value: unknown): value is NutritionConversationInput {
  if (!fields(value, ['choice', 'previousTurnId', 'job', 'question', 'userContext', 'correction'])) return false;
  const correction = value.choice === 'correct-question' || value.choice === 'update-context';
  return ['ask', 'continue-question', 'source-explanation', 'request-clarification', 'correct-question', 'update-context'].includes(String(value.choice)) &&
    ['energy-uncertainty', 'deficit-surplus-rate', 'protein', 'nutrients-dietary-patterns', 'logging-accuracy', 'supplements', 'nutrition-boundaries'].includes(String(value.job)) &&
    (value.previousTurnId === null || positive(value.previousTurnId)) && text(value.question, 2000) &&
    Array.isArray(value.userContext) && value.userContext.length <= 16 && value.userContext.every(item => text(item, 1000)) &&
    value.userContext.reduce((total: number, item: string) => total + bytes(item), 0) <= 8000 &&
    (correction ? text(value.correction, 2000) : value.correction === null);
}

export function createNutritionConversation<TState>(dependencies: NutritionConversationDependencies<TState>) {
  const { api, accountId, sessionGeneration, isCurrentSession, captureRequest, newRequestId } = dependencies;
  const now = dependencies.now ?? Date.now;
  const validation = dependencies.stateValidation;
  const isComplete = validation?.isComplete, isFreshEmpty = validation?.isFreshEmpty;
  const auth = api.captureAuthContext();
  let expired = false, disposed = false, sequence = 0, pending = false;
  let binding: NutritionWireBinding | null = null, version: number | null = null;
  let deliveryGuard: AuthAttemptGuard | null = null;
  const usedRequests = new Set<string>(), usedBindings = new Set<string>();
  const empty = (status: NutritionWireStatus, code: NutritionWireCode | LocalCode | null): NutritionConversationSnapshot<TState> =>
    Object.freeze({ status, code, binding: null, stateVersion: null, state: null, resetRequired: true });
  let visible = empty('unavailable', typeof isComplete === 'function' && typeof isFreshEmpty === 'function' ? 'conversation_unavailable' : 'validation_unavailable');
  const current = () => {
    try { if (!accountId || !sessionGeneration || !auth.isCurrent() || !isCurrentSession(accountId, sessionGeneration)) expired = true; }
    catch { expired = true; }
    return !expired;
  };
  const invalidate = (status: NutritionWireStatus, code: NutritionWireCode | LocalCode | null) => {
    sequence++; pending = false;
    binding = null; version = null; deliveryGuard = null;
    return visible = empty(status, code);
  };
  const getSnapshot = (): NutritionConversationSnapshot<TState> => {
    if (!current()) return invalidate('unavailable', 'session_changed');
    try {
      if (deliveryGuard && !deliveryGuard.isCurrent()) return invalidate(pending ? 'unknown' : 'unavailable', 'request_changed');
    } catch { return invalidate(pending ? 'unknown' : 'unavailable', 'request_changed'); }
    if (binding && Date.parse(binding.expiresAt) <= now()) return invalidate('unavailable', 'conversation_unavailable');
    return visible;
  };

  async function run(operation: NutritionWireOperation, input?: NutritionConversationInput | NutritionCitationRequest): Promise<NutritionConversationSnapshot<TState>> {
    if (!current()) return invalidate('unavailable', 'session_changed');
    if (disposed) return empty('disposed', null);
    if (typeof isComplete !== 'function' || typeof isFreshEmpty !== 'function' || typeof captureRequest !== 'function' || typeof newRequestId !== 'function') {
      return invalidate('unavailable', 'validation_unavailable');
    }
    if (pending && operation !== 'resetFreshEmpty' && operation !== 'dispose') return getSnapshot();
    getSnapshot();
    if (operation !== 'resetFreshEmpty' && operation !== 'dispose' && !binding) return visible;
    const originalBinding = binding, originalVersion = version;
    const requestSequence = ++sequence;
    const ownsRequest = () => requestSequence === sequence;
    const fail = (status: NutritionWireStatus, code: NutritionWireCode | LocalCode | null) =>
      ownsRequest() ? invalidate(status, code) : empty(status, code);
    if (operation === 'dispose') disposed = true;
    binding = operation === 'resetFreshEmpty' || operation === 'dispose' ? null : binding;
    version = binding ? version : null;
    visible = Object.freeze({ status: 'pending', code: null, binding: null, stateVersion: null, state: null, resetRequired: true });
    deliveryGuard = null;
    if (operation === 'dispose' && !originalBinding) { pending = false; return invalidate('disposed', null); }
    let requestGuard: AuthAttemptGuard, requestId: string, payload: Record<string, unknown>;
    try {
      requestGuard = captureRequest();
      if (!requestGuard.isCurrent() || !current()) return fail('unavailable', 'request_changed');
      requestId = newRequestId();
      if (!uuid(requestId) || usedRequests.has(requestId)) throw new Error('invalid_request_id');
      usedRequests.add(requestId);
      payload = { schema: nutritionWireSchema, requestId };
      if (operation === 'submit' || operation === 'selectCitation') {
        const copied = copyData(input);
        if (operation === 'submit' ? !validInput(copied) :
          !fields(copied, ['parentTurnId', 'statementId']) || !positive(copied.parentTurnId) || !text(copied.statementId, 128)) {
          throw new Error('invalid_input');
        }
        payload.input = copied;
      }
      if (bytes(JSON.stringify(payload)) > 16 * 1024) throw new Error('invalid_input');
    } catch { return fail('unavailable', 'invalid_input'); }
    const requestCurrent = () => {
      try { return current() && requestGuard.isCurrent(); } catch { return false; }
    };
    if (!ownsRequest() || !requestCurrent()) return fail('unavailable', 'request_changed');
    deliveryGuard = requestGuard;
    const suffix = operation === 'resetFreshEmpty' ? '/reset-fresh-empty'
      : `/${originalBinding!.id}/${operation === 'selectCitation' ? 'select-citation' : operation}`;
    pending = true;
    try {
      const response = await api.request<unknown>(`/v1/nutrition/conversations${suffix}`, 'POST', payload);
      if (!ownsRequest()) return empty('unavailable', 'request_changed');
      if (!requestCurrent()) return invalidate('unknown', current() ? 'request_changed' : 'session_changed');
      let wire: NutritionWireResponse<TState>;
      try {
        const value = copyData(response);
        if (bytes(JSON.stringify(value)) > 4 * 1024 * 1024 || !fields(value, [
          'schema', 'requestId', 'operation', 'status', 'code', 'binding', 'stateVersion', 'state', 'resetRequired',
        ]) || value.schema !== nutritionWireSchema || value.requestId !== requestId || value.operation !== operation ||
          !['reset', 'ok', 'rejected', 'unavailable', 'unknown', 'disposed'].includes(String(value.status)) ||
          (value.code !== null && !codes.includes(value.code as NutritionWireCode)) || typeof value.resetRequired !== 'boolean') throw new Error();
        if (value.resetRequired) {
          if (value.binding !== null || value.stateVersion !== null || value.state !== null ||
            !['unavailable', 'unknown', 'disposed'].includes(String(value.status)) ||
            (value.status === 'unavailable' && value.code === null) ||
            (value.status === 'unknown' && value.code !== 'outcome_unknown') ||
            (value.status === 'disposed' && (operation !== 'dispose' || value.code !== null))) throw new Error();
        } else {
          if (!fields(value.binding, ['id', 'expiresAt']) || !uuid(value.binding.id) ||
            !futureInstant(value.binding.expiresAt, now()) ||
            !positive(value.stateVersion) || value.state === null || !isComplete(value.state)) throw new Error();
          if (operation === 'resetFreshEmpty') {
            if (value.status !== 'reset' || value.code !== null || value.stateVersion !== 1 || usedBindings.has(value.binding.id) ||
              !isFreshEmpty(value.state)) throw new Error();
          } else if (operation === 'dispose' || !originalBinding || value.binding.id !== originalBinding.id ||
            value.stateVersion < originalVersion! || !['ok', 'rejected', 'unavailable'].includes(String(value.status)) ||
            (value.status === 'ok' && value.code !== null) || (value.status === 'rejected' && value.code === null)) throw new Error();
        }
        wire = value as unknown as NutritionWireResponse<TState>;
      } catch { return fail('unavailable', 'invalid_wire'); }
      if (!ownsRequest()) return empty('unavailable', 'request_changed');
      if (!requestCurrent()) return invalidate('unknown', current() ? 'request_changed' : 'session_changed');
      binding = wire.binding; version = wire.stateVersion;
      if (binding) usedBindings.add(binding.id);
      visible = Object.freeze({ status: wire.status, code: wire.code, binding, stateVersion: version, state: wire.state, resetRequired: wire.resetRequired });
      return visible;
    } catch {
      if (!ownsRequest()) return empty('unknown', 'outcome_unknown');
      return invalidate('unknown', current() ? 'outcome_unknown' : 'session_changed');
    } finally { if (ownsRequest()) pending = false; }
  }

  return Object.freeze({ accountId, sessionGeneration, getSnapshot,
    resetFreshEmpty: () => run('resetFreshEmpty'),
    submit: (input: NutritionConversationInput) => run('submit', input),
    selectCitation: (input: NutritionCitationRequest) => run('selectCitation', input),
    snapshot: () => run('snapshot'),
    dispose: () => run('dispose'),
  });
}
