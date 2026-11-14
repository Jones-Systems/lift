import type { CommunityPostsController, CommunityPostsSnapshot } from '../../api/community';
import type { CheckinsContext, CheckinsPresentation, CheckinsView } from './contracts';
import { endedCheckinsView, projectCheckins } from './projection';

// Leaf removal preserves the host's page, but never permits adoption by a new auth generation.
const controllerSessions = new WeakMap<CommunityPostsController, { generation: CheckinsContext['sessionGeneration']; ended: boolean }>();

export function createCheckinsPresentation(context: CheckinsContext): CheckinsPresentation {
  const { controller, groupId, sessionGeneration, isCurrentSession, onClose } = context;
  let session = controllerSessions.get(controller);
  if (!session) { session = { generation: sessionGeneration, ended: false }; controllerSessions.set(controller, session); }
  if (session.generation !== sessionGeneration) session.ended = true;
  const controllerSession = session;
  const attachment = { active: false };
  let ended: 'disposed' | 'sessionended' | null = null, attached = false, reading = false;
  let subscription: { remove(): void } | null = null;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) { try { listener(); } catch {} } };
  const invalidate = (reason: 'disposed' | 'sessionended') => {
    ended = reason; attachment.active = false; subscription?.remove(); subscription = null;
  };
  const currentSnapshot = (): CommunityPostsSnapshot | null => {
    if (ended || !attachment.active) return null;
    if (controllerSession.ended || !isCurrentSession()) {
      controllerSession.ended = true; invalidate('sessionended'); return null;
    }
    const snapshot = controller.getSnapshot();
    if (ended || !attachment.active) return null;
    if (snapshot.disposed) { controllerSession.ended = true; invalidate('disposed'); return null; }
    if (snapshot.groupId !== groupId || snapshot.page.groupId !== groupId) {
      controllerSession.ended = true; invalidate('sessionended'); return null;
    }
    return snapshot;
  };
  const getSnapshot = (): CheckinsView => {
    const snapshot = currentSnapshot();
    return snapshot ? projectCheckins(snapshot, groupId, reading) : endedCheckinsView(ended ?? 'sessionended');
  };
  const read = async (next: boolean) => {
    const snapshot = currentSnapshot();
    if (!snapshot) { emit(); return; }
    const view = projectCheckins(snapshot, groupId, reading);
    if (next ? !view.canNext : !view.canRefresh) return;
    const cursor = view.nextCursor;
    reading = true; emit();
    try {
      // A subscriber may synchronously remove the view or start a host command.
      const fresh = currentSnapshot();
      if (!fresh) return;
      const available = projectCheckins(fresh, groupId);
      if (!available.canRefresh || next && (!available.canNext || available.nextCursor !== cursor)) return;
      await controller.loadPage(next && cursor !== null ? { cursor } : {});
    } catch {
      // The controller owns the sanitized error state. Reads never retry automatically.
    } finally {
      if (currentSnapshot()) reading = false;
      emit();
    }
  };
  return {
    getSnapshot,
    subscribe(listener) {
      if (ended) return { remove() {} };
      listeners.add(listener); return { remove() { listeners.delete(listener); } };
    },
    attach() {
      if (attached || ended) return;
      attached = true; attachment.active = true;
      if (!currentSnapshot()) { emit(); return; }
      subscription = controller.subscribe(() => { currentSnapshot(); emit(); });
      emit();
    },
    detach() { invalidate('sessionended'); listeners.clear(); },
    refresh: () => read(false),
    next: () => read(true),
    close() {
      const snapshot = currentSnapshot();
      if (!snapshot) { emit(); return; }
      if (!projectCheckins(snapshot, groupId, reading).canClose) return;
      invalidate('sessionended'); emit(); listeners.clear(); onClose();
    },
  };
}
