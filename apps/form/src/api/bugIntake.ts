import { ApiError, type AuthAttemptGuard, type FormTransport } from './transport';

export type BugDiagnostics = Readonly<{
  platform: 'ios' | 'android' | 'web'; appVersion: string; buildNumber?: string;
  screen?: 'home' | 'workout' | 'progress' | 'settings' | 'other';
}>;
export type BugReportInput = Readonly<{
  title: string; description: string; diagnosticConsent?: boolean; diagnostics?: BugDiagnostics;
}>;
export type CanonicalBugReportInput = Readonly<Omit<BugReportInput, 'diagnosticConsent'> & { diagnosticConsent: boolean }>;
export type BugReportStatus = 'received' | 'prepared' | 'dispatch_unavailable' | 'dispatch_unknown' | 'dispatched';
export type BugReport = Readonly<CanonicalBugReportInput & {
  id: string; state: BugReportStatus; createdAt: string; dispatchReceiptId?: string;
}>;
export type BugSubmission = Readonly<{ report: BugReport; replayed: boolean; duplicate: boolean }>;
export type BugReportQuery = Readonly<{ limit?: number; after?: string }>;
export type BugIntakeTransport = Pick<FormTransport, 'request' | 'captureAuthContext'>;
export const bugReportLimits = Object.freeze({ title: 160, description: 4000, bytes: 12 * 1024, page: 50 });
const statuses: readonly string[] = ['received', 'prepared', 'dispatch_unavailable', 'dispatch_unknown', 'dispatched'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const invalid = () => new ApiError(422, 'invalid_bug_report', 'Check the report fields.');
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw invalid();
  return value.trim();
}
function bytes(value: string): number {
  let count = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    count += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return count;
}
function diagnostics(raw: unknown): BugDiagnostics {
  const value = object(raw, ['platform', 'appVersion', 'buildNumber', 'screen']);
  if (!['ios', 'android', 'web'].includes(String(value.platform)) || typeof value.platform !== 'string'
    || typeof value.appVersion !== 'string' || value.appVersion.length > 32 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(value.appVersion)
    || value.buildNumber !== undefined && (typeof value.buildNumber !== 'string' || value.buildNumber.length > 32 || !/^[0-9]+$/.test(value.buildNumber))
    || value.screen !== undefined && (typeof value.screen !== 'string' || !['home', 'workout', 'progress', 'settings', 'other'].includes(value.screen))) throw invalid();
  return Object.freeze({ platform: value.platform as BugDiagnostics['platform'], appVersion: value.appVersion,
    ...(value.buildNumber === undefined ? {} : { buildNumber: value.buildNumber as string }),
    ...(value.screen === undefined ? {} : { screen: value.screen as BugDiagnostics['screen'] }) });
}
export function canonicalBugReport(raw: unknown): CanonicalBugReportInput {
  const value = object(raw, ['title', 'description', 'diagnosticConsent', 'diagnostics']);
  if (value.diagnosticConsent !== undefined && typeof value.diagnosticConsent !== 'boolean') throw invalid();
  const consent = value.diagnosticConsent ?? false;
  if (value.diagnostics !== undefined && !consent) throw invalid();
  const payload: CanonicalBugReportInput = { title: text(value.title, bugReportLimits.title), description: text(value.description, bugReportLimits.description),
    diagnosticConsent: consent as boolean, ...(value.diagnostics === undefined ? {} : { diagnostics: diagnostics(value.diagnostics) }) };
  if (bytes(JSON.stringify(payload)) > bugReportLimits.bytes) throw new ApiError(413, 'bug_report_too_large', 'Shorten the report before sending.');
  return Object.freeze(payload);
}
export function bugReportKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new ApiError(400, 'invalid_idempotency_key', 'A valid report submission key is required.');
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new ApiError(400, 'invalid_bug_report_id', 'Select a valid report.');
  return value;
}
function report(raw: unknown): BugReport {
  const value = object(raw, ['title', 'description', 'diagnosticConsent', 'diagnostics', 'id', 'state', 'createdAt', 'dispatchReceiptId']);
  if (typeof value.diagnosticConsent !== 'boolean') throw invalid();
  const payload = canonicalBugReport({ title: value.title, description: value.description, diagnosticConsent: value.diagnosticConsent,
    ...(value.diagnostics === undefined ? {} : { diagnostics: value.diagnostics }) });
  if (payload.title !== value.title || payload.description !== value.description || typeof value.state !== 'string' || !statuses.includes(value.state)
    || typeof value.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt)
    || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) throw invalid();
  if (value.state === 'dispatched') {
    if (typeof value.dispatchReceiptId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.dispatchReceiptId)) throw invalid();
  } else if (value.dispatchReceiptId !== undefined) throw invalid();
  return Object.freeze({ ...payload, id: identifier(value.id), state: value.state as BugReportStatus, createdAt: value.createdAt,
    ...(value.dispatchReceiptId === undefined ? {} : { dispatchReceiptId: value.dispatchReceiptId as string }) });
}
function content(value: BugReport): CanonicalBugReportInput {
  return canonicalBugReport({ title: value.title, description: value.description, diagnosticConsent: value.diagnosticConsent,
    ...(value.diagnostics === undefined ? {} : { diagnostics: value.diagnostics }) });
}

/** A resource belongs to one mounted account and captured transport auth intent, even before token replacement. */
export class BugIntakeResources {
  private disposed = false;
  private readonly auth: AuthAttemptGuard;
  constructor(private readonly api: BugIntakeTransport, private readonly isCurrentSession: () => boolean) {
    this.auth = api.captureAuthContext();
  }
  isCurrent(): boolean { return !this.disposed && this.auth.isCurrent() && this.isCurrentSession(); }
  dispose(): void { this.disposed = true; }
  private async request<T>(path: string, method: 'GET' | 'POST', decode: (value: unknown) => T, body?: CanonicalBugReportInput, key?: string): Promise<T> {
    const changed = (unknown = false) => new ApiError(409, 'session_changed',
      'This account session ended. Check reports in the original account before sending again.', false, unknown);
    if (!this.isCurrent()) throw changed();
    try {
      const result = await this.api.request<unknown>(`/v1/bug-reports${path}`, method, body, key);
      if (!this.isCurrent()) throw changed(method === 'POST');
      let value: T;
      try { value = decode(result); }
      catch { throw new ApiError(502, 'invalid_bug_report_response', 'The report result could not be confirmed.', method === 'POST'); }
      if (!this.isCurrent()) throw changed(method === 'POST');
      return value;
    } catch (error) {
      if (!this.isCurrent()) throw changed(method === 'POST' || error instanceof ApiError && (error.effectUnknown || error.originalEffectUnknown));
      throw error;
    }
  }
  submit(raw: BugReportInput, key: string): Promise<BugSubmission> {
    const payload = canonicalBugReport(raw), commandKey = bugReportKey(key);
    return this.request('', 'POST', rawResult => {
      const value = object(rawResult, ['report', 'replayed', 'duplicate']);
      const saved = report(value.report);
      if (typeof value.replayed !== 'boolean' || typeof value.duplicate !== 'boolean' || value.replayed && value.duplicate
        || JSON.stringify(content(saved)) !== JSON.stringify(payload)) throw invalid();
      return Object.freeze({ report: saved, replayed: value.replayed, duplicate: value.duplicate });
    }, payload, commandKey);
  }
  get(id: string): Promise<BugReport> {
    const requested = identifier(id);
    return this.request(`/${encodeURIComponent(requested)}`, 'GET', raw => {
      const value = object(raw, ['report']), result = report(value.report);
      if (result.id !== requested) throw invalid();
      return result;
    });
  }
  list(input: BugReportQuery = {}): Promise<readonly BugReport[]> {
    const value = object(input, ['limit', 'after']), limit = value.limit ?? 20;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > bugReportLimits.page) throw new ApiError(400, 'invalid_bug_report_page', 'Select a valid report page.');
    const params = new URLSearchParams();
    if (value.limit !== undefined) params.set('limit', String(limit));
    if (value.after !== undefined) params.set('after', identifier(value.after));
    const suffix = params.size ? `?${params.toString()}` : '';
    return this.request(suffix, 'GET', raw => {
      const page = object(raw, ['reports']);
      if (!Array.isArray(page.reports) || page.reports.length > Number(limit)) throw invalid();
      const reports = page.reports.map(report);
      if (new Set(reports.map(item => item.id)).size !== reports.length) throw invalid();
      return Object.freeze(reports);
    });
  }
}
