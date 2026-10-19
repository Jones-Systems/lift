import type { AccountContext } from '../lifecycle/types.js';
import type { ProgressReaderDependencies, SessionSelection, SourceRef } from '../progress-comparison/index.js';

type Session = ReturnType<ProgressReaderDependencies['domain']['session']>;

export type FeedbackSessionSource = Readonly<{
  source: SourceRef;
  sessionStatus: Session['status'];
  planSnapshot: Readonly<{ planId: Session['planId']; planRevision: Session['planRevision'] }>;
  occurrence: Readonly<Pick<Session['occurrences'][number], 'id' | 'itemId' | 'exerciseId'>>;
  sets: readonly Readonly<Pick<Session['sets'][number], 'id' | 'revision' | 'status'>>[];
}>;

// The released snapshot port owns authentication/lifecycle checks; this witness proves no performed identity or prescription.
export function createFeedbackSessionSourceReader(
  deps: Pick<ProgressReaderDependencies, 'domain' | 'withReadSnapshot'>,
) {
  return {
    read(context: AccountContext, selection: SessionSelection): FeedbackSessionSource {
      return deps.withReadSnapshot(context, (): FeedbackSessionSource => {
        const session = deps.domain.session(context.accountId, selection.sessionId);
        const occurrence = session.occurrences.find(item => item.id === selection.occurrenceId);
        if (!occurrence) throw new RangeError('feedback_occurrence_missing');
        return {
          source: { accountId: context.accountId, kind: 'session', id: session.id,
            revision: session.revision, itemId: occurrence.id },
          sessionStatus: session.status,
          planSnapshot: { planId: session.planId, planRevision: session.planRevision },
          occurrence: { id: occurrence.id, itemId: occurrence.itemId, exerciseId: occurrence.exerciseId },
          sets: session.sets.filter(set => set.occurrenceId === occurrence.id)
            .map(set => ({ id: set.id, revision: set.revision, status: set.status })),
        };
      });
    },
  };
}
