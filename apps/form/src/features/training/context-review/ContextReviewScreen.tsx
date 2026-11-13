import { useLayoutEffect, useReducer, useState } from 'react';
import type { ContextConfirmationSlotContext } from '../../contract';
import { AccountRow, Gutter, Nav, Notice, PlainAction, PrimaryAction, RowGroup, Screen, Subtitle, Title } from '../../shared/ui';
import type { ContextReviewAttachment, ContextReviewPresentation } from './presentation';
import { contextReviewRows } from './rows';

const readbackMessages = {
  read_failed: 'Your plan was saved. Reading it failed. Try opening the saved plan again.',
  invalid_readback: 'Your plan was saved. Its readback could not be verified.',
  plan_missing: 'Your plan was saved, but it is missing from the current plan list.',
  plan_changed: 'Your plan was saved, but it has changed since this confirmation.',
  plan_archived: 'Your plan was saved, but it is now archived.',
} as const;

export function ContextReviewScreen({ ctx, presentation }: {
  ctx: ContextConfirmationSlotContext; presentation: ContextReviewPresentation;
}) {
  const [, refresh] = useReducer(value => value + 1, 0);
  const [attached, setAttached] = useState<{ ctx: ContextConfirmationSlotContext; actions: ContextReviewAttachment } | null>(null);
  useLayoutEffect(() => {
    const actions = presentation.attach(ctx, refresh);
    setAttached({ ctx, actions });
    return actions.detach;
  }, [presentation, ctx.confirmation, ctx.sessionGeneration, ctx.isCurrentSession, ctx.close, ctx.savedFirstPlanDestination]);
  const view = presentation.view(ctx), { snapshot } = view;
  const actions = attached && attached.ctx.confirmation === ctx.confirmation && attached.ctx.sessionGeneration === ctx.sessionGeneration ? attached.actions : undefined;
  const blocked = snapshot.status === 'pending' || snapshot.effect === 'pending' || snapshot.effect === 'unknown';
  const canClose = view.current && !blocked && !view.opening && !!actions;
  const ready = view.current && snapshot.status === 'ready' && !!view.review;
  const recapture = view.current && snapshot.effect === 'none' && ['stale', 'unavailable', 'cancelled'].includes(snapshot.status);
  let message = 'Loading your training context…';
  if (!view.current) message = blocked ? 'This session is no longer current. The save is unresolved; navigation remains blocked.' : 'This session is no longer current. Training context is hidden.';
  else if (snapshot.status === 'pending') message = 'Saving your plan. Wait for confirmation before leaving.';
  else if (snapshot.effect === 'unknown') message = 'The save may have completed. Retry the same confirmation to check its outcome.';
  else if (snapshot.status === 'stale') message = 'This review is no longer current. Review your context again before confirming.';
  else if (snapshot.status === 'unavailable') message = 'Training context or plan creation is unavailable. You can go back or explicitly review again.';
  else if (snapshot.status === 'cancelled') message = 'This review was cancelled. Review again to use fresh context.';
  else if (view.saved) message = 'Your plan is saved.';
  else if (snapshot.status === 'saved') message = 'The save is confirmed, but its saved-plan receipt is unavailable here.';
  const openMessage = view.opening ? 'Opening your saved plan…'
    : view.openResult?.status === 'unavailable' ? readbackMessages[view.openResult.reason]
      : view.openResult?.status === 'stale' ? 'The saved-plan destination is no longer current. No further navigation is available here.'
        : !view.canOpen ? 'Your plan is saved. Opening it is unavailable here.' : undefined;
  return <Screen testID="screen-context-review" nav={<Nav {...(canClose ? { back: 'Today', onBack: () => actions?.close() } : {})} />}>
    <Gutter>
      <Title text="Review your training context" />
      <Subtitle text="Review the captured details below. Confirming uses this context to create your first plan." />
      {!ready ? <Notice kind="info" text={message} announce captureId="context-review-notice" /> : null}
    </Gutter>
    {ready && view.review ? contextReviewRows(view.review).map(group => <RowGroup key={group.heading} heading={group.heading}>
      {group.rows.map((row, index) => <AccountRow key={row.id} label={row.label} detail={row.text}
        testID={`context-row-${row.id}`} last={index === group.rows.length - 1}
        onPress={row.edit && snapshot.canEdit && actions ? () => actions.edit(view.review!, row.edit!) : undefined} />)}
    </RowGroup>) : null}
    <Gutter>
      {ready || snapshot.status === 'pending' && view.current ? <PrimaryAction label={view.retrying ? 'Retry confirmation' : 'Confirm and create plan'} captureId="context-confirm"
        disabled={!ready || !actions} loading={snapshot.status === 'pending'} onPress={() => { if (view.review) actions?.confirm(view.review); }} /> : null}
      {view.current && snapshot.effect === 'unknown' && snapshot.status !== 'pending' ? <PrimaryAction label="Retry confirmation" captureId="context-retry"
        disabled={!snapshot.canRetry || !actions} onPress={() => actions?.retry()} /> : null}
      {recapture ? <PlainAction label="Review again" captureId="context-recapture" chevron={null} onPress={() => actions?.capture()} disabled={!actions} /> : null}
      {view.saved ? <>
        {openMessage ? <Notice kind="info" text={openMessage} announce captureId="context-readback-notice" /> : null}
        <PrimaryAction label={view.openResult?.status === 'unavailable' ? 'Retry opening saved plan' : 'Open saved plan'} captureId="context-open"
          disabled={!view.canOpen || !actions || view.openResult?.status === 'stale'}
          loading={view.opening} onPress={() => actions?.open()} />
      </> : null}
      {canClose && snapshot.effect === 'none' ? <PlainAction label="Cancel" captureId="context-cancel" chevron={null} onPress={() => actions?.close()} /> : null}
    </Gutter>
  </Screen>;
}
