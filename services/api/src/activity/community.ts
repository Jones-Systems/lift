import type { AccountContext, LifecycleBindings } from '../lifecycle/types.js';
import { dateRange, localDate } from './calendar.js';
import type { ActivityService } from './service.js';
import type { ActivityCommunityDay, ActivityCommunityField, ActivityCommunityReader, CommunityReadInput, TrustedActivityCommunityContext } from './types.js';

const fieldsAllowed = new Set<ActivityCommunityField>(['workout', 'exerciseSnack', 'planAdherence', 'workoutMinutes', 'exerciseCount', 'streakDays']);
export function createActivityCommunityReader(input: Readonly<{
  service: ActivityService;
  viewer: AccountContext;
  lifecycle: LifecycleBindings;
  trustedContext: (request: CommunityReadInput) => TrustedActivityCommunityContext | null;
}>): ActivityCommunityReader {
  return {
    readDays(request) {
      if (!input.lifecycle?.assertActive || !input.trustedContext || !input.viewer ||
        !Array.isArray(request.fields) || request.fields.some(field => !fieldsAllowed.has(field)) || new Set(request.fields).size !== request.fields.length)
        return { status: 'unavailable' };
      try {
        dateRange(request.from, request.to);
        input.lifecycle.assertActive(input.viewer);
        let projectionTimeZone: string | undefined, projectionThroughDate: string | undefined;
        const result = input.service.read(input.viewer, () => {
          // The callback resolves subject identity from fresh canonical Community membership/grants, never HTTP input.
          const trusted = input.trustedContext(request);
          if (!trusted || trusted.subjectAccountId !== request.subjectAccountId) return { status: 'unavailable' } as const;
          trusted.assertAuthorized(request); trusted.assertSubjectActive();
          const db = input.service.deps.db;
          const calendar = db.prepare('SELECT 1 FROM activity_calendar WHERE account_id=?').get(trusted.subjectAccountId);
          if (!calendar) return { status: 'unavailable' } as const;
          const value = input.service.projection(trusted.subjectAccountId, request.from, request.to);
          projectionTimeZone = value.calendar.timeZone;
          projectionThroughDate = value.replay.throughDate;
          const days: ActivityCommunityDay[] = value.days.map(day => {
            const result: { -readonly [K in keyof ActivityCommunityDay]: ActivityCommunityDay[K] } = {
              localDate: day.localDate, timeZone: value.calendar.timeZone, ...day.boundaries,
              revision: value.sourceGeneration.projectionRevision,
            };
            const eligibleDate = day.localDate <= value.replay.throughDate;
            const workout = day.entries.filter(x => x.kind === 'workout');
            const snack = day.entries.some(x => x.kind === 'exerciseSnack');
            if (request.fields.includes('workout')) result.workout = workout.length || day.legacyRecorded ? 'recorded'
              : eligibleDate && day.legacyAvailable ? 'not_recorded' : 'unknown';
            if (request.fields.includes('exerciseSnack')) result.exerciseSnack = snack ? 'recorded' : eligibleDate ? 'not_recorded' : 'unknown';
            if (request.fields.includes('planAdherence')) result.planAdherence = day.adherence?.actual ?? 'unknown';
            const occurrenceCountsKnown = day.legacyEvidence.every(x => x.confirmedOccurrenceCount !== undefined && Number.isSafeInteger(x.confirmedOccurrenceCount) && x.confirmedOccurrenceCount! >= 1);
            if (request.fields.includes('exerciseCount') && eligibleDate && day.legacyAvailable && occurrenceCountsKnown)
              result.exerciseCount = workout.reduce((n, entry) => n + entry.items.length, 0) + day.legacyEvidence.reduce((n, x) => n + x.confirmedOccurrenceCount!, 0);
            const completeElapsed = workout.every(x => x.items.length === 1 && x.items[0]!.snapshot.kind === 'run' && x.items[0]!.durationSeconds !== undefined);
            if (request.fields.includes('workoutMinutes') && eligibleDate && !day.legacyRecorded && day.legacyAvailable && completeElapsed)
              result.workoutMinutes = workout.reduce((n, x) => n + x.items[0]!.durationSeconds!, 0) / 60;
            if (request.fields.includes('streakDays') && day.localDate === value.replay.throughDate && day.legacyAvailable && value.replay.coverageStart !== null)
              result.streakDays = value.replay.currentPlanDays;
            return result;
          });
          trusted.assertSubjectActive(); trusted.assertAuthorized(request);
          input.lifecycle.assertActive(input.viewer);
          return { status: 'available', days } as const;
        });
        if (result.status === 'available') {
          const now = input.service.deps.now === undefined ? new Date() : input.service.deps.now();
          if (!projectionTimeZone || !projectionThroughDate || localDate(now.toISOString(), projectionTimeZone) !== projectionThroughDate)
            return { status: 'unavailable' };
        }
        return result;
      } catch {
        return { status: 'unavailable' };
      }
    },
  };
}
