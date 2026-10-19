import type { FormApi } from '../api/client';
import type { ActivityCalendar, ActivityCatalog, ActivityCapabilities, ActivityEntry, ActivityPage, ActivityPlan, ActivityPlanFields, ActivityWrite, Adherence, DayCorrection, PersonalExercise, PersonalExerciseFields, PlanDaySnapshot, ScheduleRevision, ScheduleWrite } from './contracts';
import { commandId, resourceId, revision, sanitizeActivityPlan, sanitizeActivityWrite, sanitizeDayCorrection, sanitizePersonalExercise, sanitizeSchedule, strictObject, ActivityValidationError } from './drafts/validation';
import { parseCivilDate, validTimeZone } from './drafts/dates';
export type ActivityApi = Pick<FormApi, 'request'>;
export type ActivityListQuery = { cursor?: string; limit?: number; retired?: 'true' | 'false' };
export type ActivityEntryQuery = Omit<ActivityListQuery, 'retired'> & { from: string; to: string };
const pathId = (id: string) => encodeURIComponent(resourceId(id));
function listQuery(input: ActivityListQuery | ActivityEntryQuery = {}, range = false): string {
  const record = strictObject(input, range ? ['cursor', 'limit', 'from', 'to'] : ['cursor', 'limit', 'retired'], range ? ['from', 'to'] : []);
  const query = new URLSearchParams();
  if (input.cursor !== undefined) { if (typeof input.cursor !== 'string' || input.cursor.length > 500) throw new ActivityValidationError([{ fieldPath: 'cursor', code: 'invalid_cursor' }]); query.set('cursor', input.cursor); }
  if (input.limit !== undefined) { if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) throw new ActivityValidationError([{ fieldPath: 'limit', code: 'invalid_limit' }]); query.set('limit', String(input.limit)); }
  for (const field of ['from', 'to'] as const) if (record[field] !== undefined) { if (typeof record[field] !== 'string' || !parseCivilDate(record[field])) throw new ActivityValidationError([{ fieldPath: field, code: 'invalid_date' }]); query.set(field, record[field] as string); }
  if (record.from && record.to && String(record.from) > String(record.to)) throw new ActivityValidationError([{ fieldPath: 'from', code: 'invalid_range' }]);
  if (record.retired !== undefined) { if (!['true', 'false'].includes(String(record.retired))) throw new ActivityValidationError([{ fieldPath: 'retired', code: 'invalid_filter' }]); query.set('retired', String(record.retired)); }
  return query.size ? `?${query}` : '';
}
// Inject the existing root-created FormApi (or FormResources.api); this module creates no auth or session store.
export class ActivityResources {
  constructor(public readonly api: ActivityApi) {}
  capabilities = () => this.api.request<ActivityCapabilities>('/v1/activity/capabilities');
  calendar = () => this.api.request<ActivityCalendar | null>('/v1/activity/calendar');
  createCalendar(timeZone: string, key: string) {
    if (!validTimeZone(timeZone)) throw new ActivityValidationError([{ fieldPath: 'timeZone', code: 'invalid_zone' }]);
    return this.api.request<ActivityCalendar>('/v1/activity/calendar', 'POST', { timeZone, confirmed: true }, commandId(key));
  }
  catalog = () => this.api.request<ActivityCatalog>('/v1/activity/catalog');
  personalExercise = (id: string) => this.api.request<PersonalExercise>(`/v1/activity/exercises/${pathId(id)}`);
  personalExercises = (query?: ActivityListQuery) => this.api.request<ActivityPage<PersonalExercise>>(`/v1/activity/exercises${listQuery(query)}`);
  createPersonalExercise = (fields: PersonalExerciseFields, key: string) => this.api.request<PersonalExercise>('/v1/activity/exercises', 'POST', sanitizePersonalExercise(fields), commandId(key));
  editPersonalExercise = (id: string, expectedRevision: number, fields: PersonalExerciseFields, key: string) => this.api.request<PersonalExercise>(`/v1/activity/exercises/${pathId(id)}`, 'PATCH', { ...sanitizePersonalExercise(fields), expectedRevision: revision(expectedRevision) }, commandId(key));
  retirePersonalExercise = (id: string, expectedRevision: number, key: string) => this.api.request<PersonalExercise>(`/v1/activity/exercises/${pathId(id)}/retire`, 'POST', { expectedRevision: revision(expectedRevision) }, commandId(key));
  entries = (query: ActivityEntryQuery) => this.api.request<ActivityPage<ActivityEntry>>(`/v1/activity/entries${listQuery(query, true)}`);
  entry = (id: string) => this.api.request<ActivityEntry>(`/v1/activity/entries/${pathId(id)}`);
  createEntry = (write: ActivityWrite, key: string) => this.api.request<ActivityEntry>('/v1/activity/entries', 'POST', sanitizeActivityWrite(write), commandId(key));
  editEntry = (id: string, expectedRevision: number, write: ActivityWrite, key: string) => this.api.request<ActivityEntry>(`/v1/activity/entries/${pathId(id)}`, 'PATCH', { ...sanitizeActivityWrite(write), expectedRevision: revision(expectedRevision) }, commandId(key));
  voidEntry = (id: string, expectedRevision: number, key: string) => this.api.request<ActivityEntry>(`/v1/activity/entries/${pathId(id)}/void`, 'POST', { expectedRevision: revision(expectedRevision) }, commandId(key));
  plans = (query?: ActivityListQuery) => this.api.request<ActivityPage<ActivityPlan>>(`/v1/activity/plans${listQuery(query)}`);
  plan = (id: string) => this.api.request<ActivityPlan>(`/v1/activity/plans/${pathId(id)}`);
  createPlan = (fields: ActivityPlanFields, key: string) => this.api.request<ActivityPlan>('/v1/activity/plans', 'POST', sanitizeActivityPlan(fields), commandId(key));
  editPlan = (id: string, expectedRevision: number, fields: ActivityPlanFields, key: string) => this.api.request<ActivityPlan>(`/v1/activity/plans/${pathId(id)}`, 'PATCH', { ...sanitizeActivityPlan(fields), expectedRevision: revision(expectedRevision) }, commandId(key));
  archivePlan = (id: string, expectedRevision: number, key: string) => this.api.request<ActivityPlan>(`/v1/activity/plans/${pathId(id)}/archive`, 'POST', { expectedRevision: revision(expectedRevision) }, commandId(key));
  importLegacyPlan = (planId: string, planRevision: number, key: string) => this.api.request<ActivityPlan>('/v1/activity/plans/import-legacy', 'POST', { planId: resourceId(planId), revision: revision(planRevision) }, commandId(key));
  schedule = () => this.api.request<ScheduleRevision | null>('/v1/activity/schedule');
  saveSchedule = (write: ScheduleWrite, key: string) => this.api.request<ScheduleRevision>('/v1/activity/schedule', 'POST', sanitizeSchedule(write), commandId(key));
  correctDay(date: string, write: DayCorrection, key: string) {
    if (!parseCivilDate(date)) throw new ActivityValidationError([{ fieldPath: 'date', code: 'invalid_date' }]);
    return this.api.request<PlanDaySnapshot>(`/v1/activity/schedule/days/${encodeURIComponent(date)}/correct`, 'POST', sanitizeDayCorrection(write), commandId(key));
  }
  adherence = (from: string, to: string) => this.api.request<Adherence>(`/v1/activity/adherence${listQuery({ from, to }, true)}`);
}
