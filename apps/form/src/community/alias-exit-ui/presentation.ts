import type { CommunityGroupController, CommunityGroupDetail } from '../../api/community';
import type { AliasExitContext, AliasExitMode, AliasExitNotice, AliasExitPresentation, AliasExitView } from './contracts';
import { aliasValidation, confirmedReceipt, currentDetail, matchingCommand, semanticNotice, unresolvedCommand } from './projection';

type Review = Readonly<{ memberId: string; memberRevision: number; groupRevision: number; alias: string; role: string }>;
// Retain the original generation across leaf remounts without owning controller disposal.
const controllerSessions = new WeakMap<CommunityGroupController, { generation: number; ended: boolean }>();
function identity(detail: CommunityGroupDetail | null): Review | null {
  const own = detail?.members.find(member => member.memberId === detail.memberId);
  return detail && own ? { memberId: own.memberId, memberRevision: own.revision, groupRevision: detail.revision,
    alias: own.alias, role: detail.role } : null;
}
function same(a: Review | null, b: Review | null): boolean {
  return !!a && !!b && a.memberId === b.memberId && a.memberRevision === b.memberRevision &&
    a.groupRevision === b.groupRevision && a.alias === b.alias && a.role === b.role;
}

/** makeKey is the app's crypto-backed commandKey; injection avoids native client/storage imports here. */
export function createAliasExitPresentation(context: AliasExitContext, mode: AliasExitMode, makeKey: () => string): AliasExitPresentation {
  const { controller, groupId, sessionGeneration, isCurrentSession, onClose } = context;
  let session = controllerSessions.get(controller);
  if (!session) { session = { generation: sessionGeneration, ended: false }; controllerSessions.set(controller, session); }
  if (session.generation !== sessionGeneration) session.ended = true;
  const controllerSession = session;
  const listeners = new Set<() => void>();
  let detached = false, attached = false, busy = false, reading = false;
  let subscription: { remove(): void } | null = null;
  let reviewed: Review | null = null, draft = '', localNotice: AliasExitNotice | null = null;
  let attemptedKey: string | null = null;
  let reviewedReceiptKey: string | null = null;
  const emit = () => { for (const listener of listeners) { try { listener(); } catch {} } };
  const end = () => { detached = true; reviewed = null; draft = ''; localNotice = null; subscription?.remove(); subscription = null; };
  const current = () => {
    if (detached) return false;
    if (controllerSession.ended || !isCurrentSession(sessionGeneration) || controller.getSnapshot().disposed) {
      controllerSession.ended = true; end(); return false;
    }
    return true;
  };
  const capture = () => {
    if (!current()) return;
    const next = identity(currentDetail(controller.getSnapshot(), groupId));
    if (!reviewed && next) { reviewed = next; draft = next.alias; }
  };
  const getSnapshot = (): AliasExitView => {
    const ended: AliasExitView = { ended: true, mode, detailStatus: 'idle', groupName: null, draft: '', canEdit: false,
      canSubmit: false, canRefresh: false, canReview: false, canClose: false, canRetry: false, pending: false,
      unresolved: false, receipt: null, notice: { kind: 'info', text: 'This Community session ended.' }, guidance: null };
    if (!current()) return ended;
    const snapshot = controller.getSnapshot(), command = snapshot.command, detail = currentDetail(snapshot, groupId);
    const unresolved = unresolvedCommand(command), pending = busy || command.status === 'pending' || command.intent?.state === 'pending';
    const matching = matchingCommand(command, groupId, mode);
    const receipt = command.key === reviewedReceiptKey ? null : confirmedReceipt(command, groupId, mode);
    const fresh = same(reviewed, identity(detail));
    const blocked = unresolved || busy || reading;
    const validation = mode === 'alias' ? aliasValidation(draft) : null;
    const canSubmit = !blocked && !receipt && (mode === 'leave' || fresh && (mode !== 'close' || detail?.role === 'owner')) && !validation;
    let availability: AliasExitNotice | null = null;
    if (canSubmit) availability = { kind: 'info', text: mode === 'alias' ? 'You can edit and save a new alias.'
      : mode === 'leave' ? 'You can submit a new leave request.' : 'You can confirm a new close request.' };
    else if (snapshot.detail.status === 'loading' || reading) availability = { kind: 'info', text: 'Loading the current group…' };
    else if (!detail) availability = { kind: 'info', text: snapshot.detail.status === 'stale'
      ? 'Group details are stale. Refresh to review the current membership.' : 'Current group details are unavailable. Refresh to check again.' };
    else if (!identity(detail)) availability = { kind: 'info', text: 'Your current membership details are missing. Refresh to check again.' };
    else if (!fresh) availability = { kind: 'warning', text: 'Membership details changed or are missing. Review current details before continuing.' };
    else if (mode === 'close' && detail.role !== 'owner') availability = { kind: 'info', text: 'Only the current group owner can close this group.' };
    else if (validation) availability = { kind: 'info', text: validation };
    let notice: AliasExitNotice | null = localNotice;
    let guidance: AliasExitNotice | null = null;
    if (unresolved) notice = { kind: 'warning', text: !matching
      ? 'Another Community change is unresolved. It must be reconciled on its original surface. New changes and navigation are blocked here.'
      : pending ? 'Your change is in progress. Wait before leaving this screen.'
        : 'The original change could not be confirmed. Retry that exact change before editing or leaving.' };
    else if (receipt) notice = { kind: 'success', text: receipt };
    else if (command.status === 'error' && matching) { notice = semanticNotice(command.error); guidance = availability; }
    else if (!canSubmit) notice = availability ?? notice;
    return { ended: false, mode, detailStatus: snapshot.detail.groupId === groupId ? snapshot.detail.status : 'idle',
      groupName: detail?.name ?? null, draft, pending, unresolved, receipt, notice, guidance,
      canEdit: mode === 'alias' && fresh && !blocked && !receipt,
      canSubmit,
      canRefresh: !blocked && snapshot.detail.status !== 'loading',
      canReview: !!detail && !!identity(detail) && !blocked && (!fresh && !receipt || mode === 'alias' && !!receipt),
      canClose: !blocked, canRetry: matching && unresolved && !pending && !!command.key && command.intent?.state === 'unknown' };
  };
  const refresh = async () => {
    if (!current() || !getSnapshot().canRefresh) return;
    reading = true; localNotice = null; emit();
    try { if (current() && !unresolvedCommand(controller.getSnapshot().command)) await controller.loadDetail(groupId); }
    catch { /* The controller retains the sanitized read state. */ }
    finally { if (current()) { reading = false; capture(); emit(); } }
  };
  const run = async (retry: boolean) => {
    if (!current()) return;
    const view = getSnapshot();
    if (retry ? !view.canRetry : !view.canSubmit) {
      if (!retry && mode === 'alias' && view.canEdit) { localNotice = { kind: 'error', text: aliasValidation(draft) ?? 'Review the current alias.' }; emit(); }
      return;
    }
    busy = true; localNotice = null;
    const original = controller.getSnapshot().command;
    const review = reviewed, alias = draft;
    try {
      const key = retry ? original.key! : makeKey();
      attemptedKey = key;
      emit();
      // Observers and key creation may end the binding synchronously.
      if (!current()) return;
      if (retry) {
        const command = controller.getSnapshot().command;
        if (command.key !== key || !matchingCommand(command, groupId, mode) || command.status === 'pending' || command.intent?.state !== 'unknown') return;
        await controller.retry(key);
      } else {
        const snapshot = controller.getSnapshot();
        if (unresolvedCommand(snapshot.command)) return;
        if (mode !== 'leave' && !same(review, identity(currentDetail(snapshot, groupId)))) return;
        if (!current()) return;
        if (mode === 'alias' && review) await controller.updateAlias(groupId, { alias, expectedRevision: review.memberRevision }, key);
        else if (mode === 'leave') await controller.leave(groupId, { confirmed: true }, key);
        else if (mode === 'close' && review) await controller.closeGroup(groupId, { expectedRevision: review.groupRevision, confirmed: true }, key);
      }
    } catch {
      if (current() && controller.getSnapshot().command.key !== attemptedKey)
        localNotice = { kind: 'error', text: 'The change could not start. Refresh and review before continuing.' };
    } finally { if (current()) { busy = false; emit(); } }
  };
  return {
    getSnapshot,
    subscribe(listener) { if (detached) return { remove() {} }; listeners.add(listener); return { remove() { listeners.delete(listener); } }; },
    attach() {
      if (attached || !current()) return;
      attached = true;
      subscription = controller.subscribe(() => { if (current()) { capture(); emit(); } else emit(); });
      capture(); emit();
      const snapshot = controller.getSnapshot();
      if (!unresolvedCommand(snapshot.command) && snapshot.detail.status === 'idle') void refresh();
    },
    detach() { end(); listeners.clear(); },
    setDraft(value) { if (current() && getSnapshot().canEdit) { draft = value; localNotice = null; emit(); } },
    review() {
      if (!current() || !getSnapshot().canReview) return;
      if (getSnapshot().receipt && mode === 'alias') reviewedReceiptKey = controller.getSnapshot().command.key;
      reviewed = identity(currentDetail(controller.getSnapshot(), groupId)); draft = reviewed?.alias ?? ''; localNotice = null; emit();
    },
    refresh, submit: () => run(false), retry: () => run(true),
    close() { if (current() && getSnapshot().canClose) { end(); listeners.clear(); onClose(); } },
  };
}
