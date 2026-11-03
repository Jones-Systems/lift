import type { NativePrescription, SourceUnknownLoad,
  SourceWorkoutSession } from '../../../api/domain';
import type { SourceExecution } from '../model';
import type { SourceRest } from '../source-rest';
import type { Frozen, PreviewFence, PreviewResult,
  PreviewDenial } from '../../syntheticPreviewContract';

type WorkoutIdentity = Pick<SourceExecution,
  'sessionId' | 'sessionRevision' | 'planId' | 'planRevision' | 'sessionStatus'>;
type OccurrenceIdentity = Pick<SourceWorkoutSession['occurrences'][number],
  'id' | 'itemId' | 'exerciseId' | 'position'>;

export type RestWorkoutProjection = Frozen<{
  session: WorkoutIdentity;
  occurrence: OccurrenceIdentity;
  prescription: Pick<NativePrescription, 'rest_seconds'>;
  prescribedLoad: SourceUnknownLoad;
}>;

export type ForegroundRestState =
  | Readonly<{
      status: 'running';
      value: SourceRest & Readonly<{ status: 'running' }>;
      onPause(): PreviewResult;
    }>
  | Readonly<{
      status: 'paused';
      value: SourceRest & Readonly<{ status: 'paused' }>;
      onResume(): PreviewResult;
    }>
  | Readonly<{
      status: 'unavailable'; value: null;
      reason: PreviewDenial | 'no_rest' | 'rest_finished';
    }>;

export type SourceWorkoutViewProps = Readonly<{
  fence: PreviewFence;
  context: RestWorkoutProjection;
  rest: ForegroundRestState;
  onClose(): void;
}>;
