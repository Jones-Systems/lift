import type { ContextConfirmationSlotContext, SettingsEditTarget } from '../../contract';
import type { ContextConfirmationResult, ContextConfirmationSnapshot, ContextReview } from '../../../integration/contextConfirmation';
import type { SavedFirstPlanDestination, SavedFirstPlanOpenResult } from '../../../integration/savedFirstPlanDestination';
import { ContextReviewScreen } from './ContextReviewScreen';

type Context = ContextConfirmationSlotContext;
export type ContextReviewView = Readonly<{
  current: boolean;
  snapshot: ContextConfirmationSnapshot;
  review?: ContextReview;
  saved: boolean;
  canOpen: boolean;
  opening: boolean;
  retrying: boolean;
  openResult?: SavedFirstPlanOpenResult;
}>;
export type ContextReviewAttachment = Readonly<{
  view(): ContextReviewView;
  confirm(review: ContextReview): void;
  edit(review: ContextReview, target: SettingsEditTarget): void;
  capture(): void;
  retry(): void;
  open(): void;
  close(): void;
  detach(): void;
}>;
export type ContextReviewPresentation = Readonly<{
  view(ctx: Context): ContextReviewView;
  attach(ctx: Context, observer: () => void): ContextReviewAttachment;
}>;

function createPresentation(controller: Context['confirmation'], generation: string): ContextReviewPresentation {
  let result: ContextConfirmationResult | undefined;
  let operation: Promise<void> | undefined;
  let destination: { saved: ContextConfirmationResult; value: SavedFirstPlanDestination | null } | undefined;
  let openOperation: Promise<void> | undefined;
  let openResult: SavedFirstPlanOpenResult | undefined;
  let presentationId = 0, openedPresentation: number | undefined;
  const observers = new Set<() => void>();
  const current = (ctx: Context) => {
    try { return ctx.confirmation === controller && ctx.sessionGeneration === generation && ctx.isCurrentSession(); }
    catch { return false; }
  };
  const notify = () => { for (const observer of observers) observer(); };
  const saved = (snapshot: ContextConfirmationSnapshot) => snapshot.status === 'saved' && snapshot.effect === 'confirmed' &&
    result?.snapshot.status === 'saved' && result.snapshot.effect === 'confirmed' && !!result.receipt;
  function view(ctx: Context): ContextReviewView {
    const snapshot = controller.snapshot(), active = current(ctx);
    return { current: active, snapshot, saved: active && saved(snapshot),
      review: active && snapshot.status === 'ready' && result?.snapshot.status === 'ready' ? result.review : undefined,
      canOpen: active && saved(snapshot) && !!destination?.value && openedPresentation !== presentationId && openResult?.status !== 'stale',
      opening: !!openOperation, retrying: snapshot.status === 'pending' && result?.snapshot.effect === 'unknown',
      openResult: active ? openResult : undefined };
  }
  function retain(ctx: Context, task: Promise<ContextConfirmationResult>) {
    const pending = task.then(value => {
      if (!current(ctx)) return;
      result = value;
      if (saved(controller.snapshot()) && destination?.saved !== value) {
        let valueDestination: SavedFirstPlanDestination | null = null;
        try { valueDestination = ctx.savedFirstPlanDestination(value); } catch { /* Saving already succeeded. */ }
        destination = { saved: value, value: valueDestination };
      }
    }).finally(() => { if (operation === pending) operation = undefined; notify(); });
    operation = pending;
    notify();
  }
  return { view, attach(ctx, observer) {
    const attachmentId = ++presentationId;
    let attached = true;
    const active = () => attached && current(ctx);
    const emit = () => { if (attached) observer(); };
    observers.add(emit);
    const snapshot = () => controller.snapshot();
    const blocked = (state: ContextConfirmationSnapshot) => state.status === 'pending' || state.effect === 'pending' || state.effect === 'unknown';
    const capture = () => {
      const state = snapshot();
      if (!active() || operation || blocked(state) || state.effect !== 'none' ||
        !['idle', 'cancelled', 'stale', 'unavailable'].includes(state.status)) return;
      retain(ctx, controller.capture());
    };
    const attachment: ContextReviewAttachment = {
      view: () => view(ctx),
      confirm(review) {
        const state = snapshot();
        if (!active() || operation || state.status !== 'ready' || state.effect !== 'none' || result?.review !== review) return;
        retain(ctx, review.confirm());
      },
      edit(review, target) {
        const state = snapshot();
        if (!active() || operation || state.status !== 'ready' || state.effect !== 'none' || !state.canEdit || result?.review !== review) return;
        review.edit(target); notify();
      },
      capture,
      retry() {
        const state = snapshot();
        if (!active() || operation || state.status !== 'unknown' || !state.canRetry) return;
        retain(ctx, controller.retry());
      },
      open() {
        const state = snapshot(), target = destination?.value;
        if (!active() || !saved(state) || !target || openOperation || openedPresentation === attachmentId || openResult?.status === 'stale') return;
        const pending = target.openSavedPlan().then(value => {
          if (current(ctx)) {
            openResult = value;
            if (value.status === 'opened') openedPresentation = attachmentId;
          }
        }, () => {
          if (current(ctx)) openResult = { status: 'unavailable', reason: 'read_failed' };
        }).finally(() => { if (openOperation === pending) openOperation = undefined; notify(); });
        openOperation = pending; notify();
      },
      close() {
        const state = snapshot();
        if (!active() || blocked(state) || openOperation) return;
        if (state.effect === 'none') controller.cancel();
        attached = false; observers.delete(emit); ctx.close();
      },
      detach() { attached = false; observers.delete(emit); },
    };
    const initial = snapshot();
    if (initial.status === 'idle' || initial.status === 'cancelled') capture();
    return attachment;
  } };
}

export function createContextReviewRenderer() {
  const cache = new WeakMap<Context['confirmation'], Map<string, ContextReviewPresentation>>();
  return function renderContextReview(ctx: Context) {
    let sessions = cache.get(ctx.confirmation);
    if (!sessions) { sessions = new Map(); cache.set(ctx.confirmation, sessions); }
    let presentation = sessions.get(ctx.sessionGeneration);
    if (!presentation) { presentation = createPresentation(ctx.confirmation, ctx.sessionGeneration); sessions.set(ctx.sessionGeneration, presentation); }
    return <ContextReviewScreen ctx={ctx} presentation={presentation} />;
  };
}
