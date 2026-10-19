import type { FormApi } from './client';
import { ApiError } from './transport';

export type FeatureCategory = 'general' | 'workouts' | 'plans' | 'coaching' | 'accessibility' | 'community' | 'settings';
export type FeatureStatus = 'submitted' | 'under_consideration' | 'planned' | 'in_progress' | 'released' | 'not_planned';
export type FeatureVisibility = 'pending' | 'published' | 'hidden' | 'withdrawn';
export type FeatureView = Readonly<{
  id: string; title: string; description: string; category: FeatureCategory; status: FeatureStatus;
  statusReason: string | null; revision: number; createdAt: string; visibility: FeatureVisibility;
  authorLabel: 'Form member'; voteCount: number; supported: boolean;
}>;
export type FeatureSubmission = Readonly<{
  id: string; featureId: string; canonicalFeatureId: string; title: string; description: string;
  category: FeatureCategory; revision: number; visibility: FeatureVisibility; createdAt: string;
  predecessorSubmissionId?: string; successorSubmissionId?: string;
}>;
export type FeatureVote = Readonly<{ featureId: string; active: boolean; revision: number }>;
export type FeatureDetail = Readonly<{
  requestedId: string; canonicalId: string; combined: boolean; feature: FeatureView;
  original?: Readonly<{ title: string; description: string }>;
}>;
type Capability = 'unavailable' | 'injected_unqualified';
export type FeatureBoardCapabilities = Readonly<{
  submissions: 'pending_author_only'; liveActivation: 'unqualified'; purge: 'pending_qualification';
  moderation: Capability; steward: Capability; safety: Capability; retention: Capability;
  support: Capability; publicProjection: Capability;
}>;
export type FeaturePage = Readonly<{ features: readonly FeatureView[]; page: number; pageSize: number; hasMore: boolean }>;
export type FeatureQuery = {
  q?: string; category?: FeatureCategory; status?: FeatureStatus; mine?: 'submissions' | 'votes';
  sort?: 'newest' | 'most_supported'; page?: number; pageSize?: number;
};
export type FeatureSubmissionInput = {
  title: string; description: string; category: FeatureCategory;
  policyVersion: 'form_feature_board_v1'; policyAccepted: true; audienceAccepted: true; voteOnSubmit?: boolean;
};
export type FeatureCorrectionInput = Readonly<Omit<FeatureSubmissionInput, 'voteOnSubmit'> & {
  expectedRevision: number; expectedCanonicalFeatureId: string;
}>;
export type FeatureCorrectionReceipt = Readonly<{
  schema: 'form.feature-board-correction/v1'; key: string; eventId: string;
  submissionId: string; featureId: string; expectedRevision: number; resultRevision: number;
  canonicalFeatureId: string; canonicalRevision: number;
  successor: Readonly<{ submissionId: string; featureId: string }>;
  replacement: Readonly<Omit<FeatureSubmissionInput, 'voteOnSubmit'>>; createdAt: string;
}>;
export type FeatureCorrectionResult = Readonly<{ receipt: FeatureCorrectionReceipt; successor: FeatureSubmission | null }>;
const categories = ['general', 'workouts', 'plans', 'coaching', 'accessibility', 'community', 'settings'];
const statuses = ['submitted', 'under_consideration', 'planned', 'in_progress', 'released', 'not_planned'];
const invalid = () => new ApiError(422, 'board_invalid_input', 'Check the feature request fields.');
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) throw invalid();
  return encodeURIComponent(value);
}
function commandKey(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(value)) throw invalid();
  return value;
}
function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid();
  return value;
}
function plain(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || [...value].length < min || [...value].length > max ||
    value.trim() !== value || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    /(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:https?:|www\.|mailto:|data:)|\b[\p{L}\p{N}-]+\.[\p{L}]{2,63}\b)/iu.test(value)) throw invalid();
  return value;
}
function query(input: FeatureQuery, own = false): string {
  const values = object(input, own ? ['page', 'pageSize'] : ['q', 'category', 'status', 'mine', 'sort', 'page', 'pageSize']);
  const result = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (name === 'q') plain(value, 1, 100);
    else if (name === 'page' || name === 'pageSize') {
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > (name === 'page' ? 200 : 50)) throw invalid();
    } else {
      const allowed = name === 'category' ? categories : name === 'status' ? statuses :
        name === 'mine' ? ['submissions', 'votes'] : ['newest', 'most_supported'];
      if (typeof value !== 'string' || !allowed.includes(value)) throw invalid();
    }
    result.set(name, String(value));
  }
  return result.size ? `?${result}` : '';
}

function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const result: Record<string, unknown> = {};
  for (const name of Reflect.ownKeys(value)) {
    if (typeof name !== 'string' || !required.includes(name) && !optional.includes(name)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
    result[name] = descriptor.value;
  }
  if (required.some(name => !Object.hasOwn(result, name))) throw invalid();
  return result;
}
const replacementKeys = ['title', 'description', 'category', 'policyVersion', 'policyAccepted', 'audienceAccepted'] as const;
function replacement(value: unknown): Readonly<Omit<FeatureSubmissionInput, 'voteOnSubmit'>> {
  const row = closed(value, replacementKeys);
  if (row.policyVersion !== 'form_feature_board_v1' || row.policyAccepted !== true || row.audienceAccepted !== true ||
    typeof row.category !== 'string' || !categories.includes(row.category)) throw invalid();
  return Object.freeze({ title: plain(row.title, 5, 100), description: plain(row.description, 20, 2000),
    category: row.category as FeatureCategory, policyVersion: row.policyVersion, policyAccepted: true, audienceAccepted: true });
}
function idValue(value: unknown): string { if (typeof value !== 'string') throw invalid(); identifier(value); return value; }
function revValue(value: unknown): number { if (typeof value !== 'number') throw invalid(); return revision(value); }
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalid();
  return value;
}
function decodeCorrection(value: unknown, id: string, input: FeatureCorrectionInput, key: string): FeatureCorrectionResult {
  const envelope = closed(value, ['receipt', 'successor']);
  const row = closed(envelope.receipt, ['schema', 'key', 'eventId', 'submissionId', 'featureId', 'expectedRevision', 'resultRevision',
    'canonicalFeatureId', 'canonicalRevision', 'successor', 'replacement', 'createdAt']);
  if (row.schema !== 'form.feature-board-correction/v1' || row.key !== key || row.submissionId !== id ||
    row.expectedRevision !== input.expectedRevision || row.resultRevision !== input.expectedRevision + 1 || row.canonicalFeatureId !== input.expectedCanonicalFeatureId) throw invalid();
  const supplied = replacement(row.replacement);
  if (replacementKeys.some(name => supplied[name] !== input[name])) throw invalid();
  const next = closed(row.successor, ['submissionId', 'featureId']);
  const successor = Object.freeze({ submissionId: idValue(next.submissionId), featureId: idValue(next.featureId) });
  const receipt: FeatureCorrectionReceipt = Object.freeze({ schema: 'form.feature-board-correction/v1', key,
    eventId: idValue(row.eventId), submissionId: id, featureId: idValue(row.featureId), expectedRevision: revValue(row.expectedRevision),
    resultRevision: revValue(row.resultRevision), canonicalFeatureId: idValue(row.canonicalFeatureId), canonicalRevision: revValue(row.canonicalRevision),
    successor, replacement: supplied, createdAt: timestamp(row.createdAt) });
  if (successor.submissionId === id || successor.featureId === receipt.featureId) throw invalid();
  let current: FeatureSubmission | null = null;
  if (envelope.successor !== null) {
    const view = closed(envelope.successor, ['id', 'featureId', 'canonicalFeatureId', 'title', 'description', 'category', 'revision', 'visibility', 'createdAt', 'predecessorSubmissionId'], ['successorSubmissionId']);
    if (view.id !== successor.submissionId || view.featureId !== successor.featureId || view.predecessorSubmissionId !== id ||
      view.title !== supplied.title || view.description !== supplied.description || view.category !== supplied.category ||
      typeof view.visibility !== 'string' || !['pending', 'published', 'hidden', 'withdrawn'].includes(view.visibility)) throw invalid();
    current = Object.freeze({ id: successor.submissionId, featureId: successor.featureId, canonicalFeatureId: idValue(view.canonicalFeatureId),
      title: supplied.title, description: supplied.description, category: supplied.category, revision: revValue(view.revision),
      visibility: view.visibility as FeatureVisibility, createdAt: timestamp(view.createdAt), predecessorSubmissionId: id,
      ...(Object.hasOwn(view, 'successorSubmissionId') ? { successorSubmissionId: idValue(view.successorSubmissionId) } : {}) });
  }
  return Object.freeze({ receipt, successor: current });
}

/** One mounted account generation; callers retain exact keys/payloads for explicit unknown-result reconciliation. */
export class FeatureBoardResources {
  private disposed = false;
  constructor(private readonly api: Pick<FormApi, 'request'>, private readonly isCurrentSession: () => boolean) {}
  dispose() { this.disposed = true; }
  private current() { return !this.disposed && this.isCurrentSession(); }
  private async request<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
    const changed = (unknown: boolean) => new ApiError(409, 'session_changed',
      'This account session ended. Reconcile uncertain changes before trying again.', false, unknown);
    if (!this.current()) throw changed(false);
    try {
      const result = await this.api.request<T>(`/v1/community/board${path}`, method, body, key);
      if (!this.current()) throw changed(method !== 'GET');
      return result;
    } catch (error) {
      if (!this.current()) throw changed(error instanceof ApiError ?
        error.effectUnknown || error.originalEffectUnknown : method !== 'GET');
      throw error;
    }
  }
  capabilities = () => this.request<FeatureBoardCapabilities>('/capabilities');
  browse = (input: FeatureQuery = {}) => this.request<FeaturePage>(`/features${query(input)}`);
  detail = (id: string) => this.request<FeatureDetail>(`/features/${identifier(id)}`);
  ownSubmissions = (input: Pick<FeatureQuery, 'page' | 'pageSize'> = {}) =>
    this.request<{ submissions: readonly FeatureSubmission[] }>(`/me/submissions${query(input, true)}`);
  ownVotes = (input: Pick<FeatureQuery, 'page' | 'pageSize'> = {}) =>
    this.request<{ votes: readonly FeatureVote[] }>(`/me/votes${query(input, true)}`);
  submit(input: FeatureSubmissionInput, key: string) {
    object(input, ['title', 'description', 'category', 'policyVersion', 'policyAccepted', 'audienceAccepted', 'voteOnSubmit']);
    if (input.policyVersion !== 'form_feature_board_v1' || input.policyAccepted !== true ||
      input.audienceAccepted !== true || !categories.includes(input.category) ||
      input.voteOnSubmit !== undefined && typeof input.voteOnSubmit !== 'boolean') throw invalid();
    const body = { title: plain(input.title, 5, 100), description: plain(input.description, 20, 2000),
      category: input.category, policyVersion: input.policyVersion, policyAccepted: true, audienceAccepted: true,
      ...(input.voteOnSubmit === undefined ? {} : { voteOnSubmit: input.voteOnSubmit }) };
    return this.request<FeatureSubmission>('/features', 'POST', body, commandKey(key));
  }
  correct(id: string, input: FeatureCorrectionInput, key: string): Promise<FeatureCorrectionResult> {
    const row = closed(input, [...replacementKeys, 'expectedRevision', 'expectedCanonicalFeatureId']);
    const fields = replacement(Object.fromEntries(replacementKeys.map(name => [name, row[name]])));
    const body: FeatureCorrectionInput = Object.freeze({ ...fields, expectedRevision: revValue(row.expectedRevision),
      expectedCanonicalFeatureId: idValue(row.expectedCanonicalFeatureId) });
    const path = `/submissions/${identifier(id)}/correct`; commandKey(key);
    return this.request<unknown>(path, 'POST', body, key).then(value => {
      let result: FeatureCorrectionResult;
      try { result = decodeCorrection(value, id, body, key); }
      catch { throw new ApiError(0, 'board_correction_response_invalid', 'Keep the original correction intent before retrying.', true); }
      if (!this.current()) throw new ApiError(409, 'session_changed', 'This account session ended.', false, true);
      return result;
    });
  }
  setVote(id: string, active: boolean, expectedRevision: number, key: string) {
    if (typeof active !== 'boolean') throw invalid();
    return this.request<FeatureVote>(`/features/${identifier(id)}/vote`, 'POST',
      { active, expectedRevision: revision(expectedRevision) }, commandKey(key));
  }
  withdraw(id: string, expectedRevision: number, key: string) {
    return this.request<FeatureSubmission>(`/submissions/${identifier(id)}/withdraw`, 'POST',
      { expectedRevision: revision(expectedRevision) }, commandKey(key));
  }
  report(id: string, reason: 'harassment' | 'privacy' | 'unsafe' | 'other', key: string) {
    if (!['harassment', 'privacy', 'unsafe', 'other'].includes(reason)) throw invalid();
    return this.request<{ receiptId: string; status: 'pending' }>(`/features/${identifier(id)}/report`, 'POST', { reason }, commandKey(key));
  }
}
