import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ActivityRuntimeContext } from '../../FormRuntime';
import { Notice } from '../../features/shared/ui';
import { ActivityEditor } from './ActivityEditor';
import { ActivityReview } from './ActivityReview';
import { ActivityCalendarScreen, ActivityDetail, ActivityFrame, ActivityList, ActivitySpeech, ActivityStatus, ActivityVoidReview } from './ActivityScreens';
import { activityPresentation, pendingChannels, type ActivityView } from './presentation';

export function ActivitySlot({ context }: { context: ActivityRuntimeContext }) {
  const presentation = useMemo(() => activityPresentation(context), [context.activity, context.sessionGeneration]);
  const snapshot = useSyncExternalStore(presentation.subscribe, presentation.getSnapshot, presentation.getSnapshot);
  const [view, setView] = useState<ActivityView | null>(null);
  useEffect(() => {
    let attached: ActivityView;
    try { attached = presentation.attach(context); } catch { return; }
    setView(attached);
    void presentation.actions(attached).initialize();
    return () => presentation.detach(attached);
  }, [presentation]);
  useEffect(() => { if (!context.isCurrentSession()) presentation.retire(); });
  if (!context.isCurrentSession()) return <ActivityFrame title="Activity"><Notice kind="warning" text="The account session changed. This Activity view is unavailable." /></ActivityFrame>;
  if (!view || view.context.activity !== context.activity || view.context.sessionGeneration !== context.sessionGeneration) return null;
  const actions = presentation.actions(view);
  const blocked = snapshot.busy || snapshot.integrityUnavailable || snapshot.custodyUnavailable
    || (snapshot.consumer ? pendingChannels(snapshot.consumer).length > 0 : true);
  const showReceiptWhileReading = snapshot.busy && snapshot.route === 'detail' && snapshot.receipt !== null
    && !snapshot.integrityUnavailable && !snapshot.custodyUnavailable && snapshot.consumer !== null && pendingChannels(snapshot.consumer).length === 0;
  const title = snapshot.route === 'list' ? 'Activity' : snapshot.route === 'calendar' ? 'Activity calendar'
    : snapshot.route === 'editor' ? 'Edit activity draft' : snapshot.route === 'review' ? 'Review activity'
      : snapshot.route === 'detail' ? 'Activity entry' : snapshot.route === 'void' ? 'Review void' : 'Review speech';
  const back = blocked ? undefined : snapshot.route === 'list' ? 'Today' : snapshot.route === 'review' ? 'Edit draft'
    : ['editor', 'speech', 'void', 'calendar'].includes(snapshot.route) ? 'Discard unsaved input' : 'Activity date';
  return <ActivityFrame title={title} back={back} onBack={() => { void actions.back(); }}>
    <ActivityStatus snapshot={snapshot} actions={actions} />
    {(!blocked || showReceiptWhileReading) && snapshot.available ? <>
      {snapshot.route === 'list' ? <ActivityList key={snapshot.selectedDate} snapshot={snapshot} actions={actions} /> : null}
      {snapshot.route === 'calendar' ? <ActivityCalendarScreen snapshot={snapshot} actions={actions} /> : null}
      {snapshot.route === 'editor' ? <ActivityEditor key={snapshot.consumer?.draft.epoch} snapshot={snapshot} actions={actions} advanced={context.appMode === 'advanced'} /> : null}
      {snapshot.route === 'review' ? <ActivityReview snapshot={snapshot} actions={actions} /> : null}
      {snapshot.route === 'detail' ? <ActivityDetail snapshot={snapshot} actions={actions} /> : null}
      {snapshot.route === 'void' ? <ActivityVoidReview snapshot={snapshot} actions={actions} /> : null}
      {snapshot.route === 'speech' ? <ActivitySpeech snapshot={snapshot} actions={actions} /> : null}
    </> : null}
  </ActivityFrame>;
}
