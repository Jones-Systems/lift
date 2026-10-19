// Active-session state and the per-session set command queue (settings-training v2 contracts.md#training, DESIGN #remove-set).
//
// - Set writes go one at a time. Each request carries the current session revision, and every response advances it.
// - Each command owns one key. After an unknown result the SAME key and the SAME body (including the expected revision
//   it was first sent with) are resent, or the session is reloaded to reconcile. Nothing is shown as saved until the
//   server says so; removal is never optimistic.
// - Completion excludes set writes until its result settles. An active readback cannot disprove an unknown completion.
// - A definite 409 stale_revision on a first attempt means nothing applied: reload, then resend once with the fresh
//   revision under a new key (the server fingerprints key + body, so the old key cannot carry a new revision).
import { useEffect, useReducer, useRef } from 'react';
import { ApiError, commandKey } from '../../api/client';
import type { PerformedSet, WorkoutSession, SavedSet, SourcePerformedSet, SourceWorkoutSession, StoredWorkoutSession } from '../../api/domain';
import type { FormResources } from '../../api/resources';
import type { SourceTrainingResources } from '../../api/sourceTrainingResources';
import {
  commandStateFrom, toServerError, freezeSetDraft, freezeSetChanges, freezeSavedSet, setValuesMatch, sourceExecution,
  type CommandState, type PendingCommand, type ServerError, type LegacySetChanges, type LegacySetDraft,
  type SetChanges, type SetDraft, type SourceSetChanges, type SourceSetDraft,
} from './model';
import { TC, trainingErrorCopy } from './copy';
import { createSourceRest, type RestTiming } from './source-rest';

type AddPayload<D> = { kind: 'add'; set: D };
type EditPayload<C> = { kind: 'edit'; setId: string; changes: C };
type VoidPayload = { kind: 'void'; setId: string };

export type SetCommand<T extends SavedSet = PerformedSet, D extends SetDraft = LegacySetDraft, C extends SetChanges = LegacySetChanges> = PendingCommand<AddPayload<D> | EditPayload<C> | VoidPayload> & {
  /** Original session revision and, for edit/void, the detached set used for the first request. */
  sentRevision: number | null;
  sentSet: T | null;
  /** True after any unknown result: a later 409 may then mean the earlier attempt applied. */
  wasUnknown: boolean;
};

export type WorkoutNotice = { kind: 'info' | 'warning' | 'error'; text: string; retryKey?: string } | null;

export type CompleteCommand = PendingCommand<{ expectedRevision: number }>;

const idle: CommandState = { status: 'idle' };

type WorkoutOptions<S, R> = {
  resources: R; initial: S; onUnauthenticated: () => void;
  /** Confirmed completion of the original session only. */
  onCompleted: (session: S) => void;
  onChanged: () => void;
};
type QueueSession<T extends SavedSet> = Omit<WorkoutSession, 'sets' | 'occurrences' | 'planSnapshot'> & {
  sets: T[]; occurrences: WorkoutSession['occurrences'] | SourceWorkoutSession['occurrences'];
  planSnapshot: WorkoutSession['planSnapshot'] | SourceWorkoutSession['planSnapshot'];
};
type WorkoutPort<S, T, D, C> = {
  workout(id: string): Promise<S>;
  addSet(session: S, set: D, key: string): Promise<{ set: T; sessionRevision: number }>;
  editSet(sessionId: string, current: T, changes: C, key: string): Promise<{ set: T; sessionRevision: number }>;
  voidSet(sessionId: string, current: T, key: string): Promise<{ set: T; sessionRevision: number }>;
  completeWorkout(session: S, key: string): Promise<S>;
};

export function useWorkout(options: WorkoutOptions<WorkoutSession, FormResources>) {
  return useWorkoutQueue<PerformedSet, WorkoutSession, LegacySetDraft, LegacySetChanges>(options, options.resources);
}

function requireSourceSession(value: StoredWorkoutSession, write = false): SourceWorkoutSession {
  if (!isSourceSession(value)) throw new ApiError(502, 'training_response_invalid', 'The source workout could not be verified.', write);
  return value;
}
function isSourceSession(value: StoredWorkoutSession): value is SourceWorkoutSession {
  return 'schema' in value.planSnapshot && value.planSnapshot.schema === 'form.source-prescription-plan/v1';
}

/** Same queue policy as legacy training; the additive facade is acquired from bound FormResources. */
export function useSourceWorkout(options: WorkoutOptions<SourceWorkoutSession, SourceTrainingResources> & {
  restTiming?: RestTiming; isCurrent?: () => boolean;
}) {
  const [, renderRest] = useReducer((n: number) => n + 1, 0);
  const rest = useRef<ReturnType<typeof createSourceRest> | null>(null);
  const owner = useRef({ resources: options.resources, sessionId: options.initial.id, expired: false });
  const alive = useRef(true);
  if (owner.current.resources !== options.resources || owner.current.sessionId !== options.initial.id) {
    owner.current.expired = true; rest.current?.dispose();
  }
  const latest = useRef(options); latest.current = options;
  const current = () => alive.current && !owner.current.expired && (latest.current.isCurrent?.() ?? true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; rest.current?.dispose(); }; }, []);
  const resources = options.resources;
  const port: WorkoutPort<SourceWorkoutSession, SourcePerformedSet, SourceSetDraft, SourceSetChanges> = {
    ...resources,
    workout: async id => requireSourceSession(await resources.workout(id)),
    completeWorkout: async (session, key) => requireSourceSession(await resources.completeWorkout(session, key), true),
  };
  const workout = useWorkoutQueue<SourcePerformedSet, SourceWorkoutSession, SourceSetDraft, SourceSetChanges>(
    { ...options, resources: port,
      onCompleted: session => { rest.current?.dispose(); if (current()) options.onCompleted(session); },
      onChanged: () => { if (current()) options.onChanged(); },
      onUnauthenticated: () => { if (current()) options.onUnauthenticated(); },
    }, resources);
  const latestWorkout = useRef(workout); latestWorkout.current = workout;
  const completionHold = useRef(false);
  completionHold.current = workout.complete?.state.status === 'pending' || workout.complete?.state.status === 'unknown';
  const canRest = () => current() && latestWorkout.current.session.status === 'active'
    && !completionHold.current;
  const timerCurrent = () => current() && latestWorkout.current.session.status === 'active';
  if (!rest.current) rest.current = createSourceRest(options.initial.occurrences, timerCurrent,
    () => { if (current()) renderRest(); }, options.restTiming);
  if (!timerCurrent()) rest.current.dispose();
  const timer = rest.current;
  return { ...workout, rest: timer.snapshot(), execution: sourceExecution(workout.session),
    logSet: (set: SourceSetDraft) => { if (current()) workout.logSet(set); },
    editSet: (set: SourcePerformedSet, changes: SourceSetChanges) => { if (current()) workout.editSet(set, changes); },
    voidSet: (set: SourcePerformedSet) => { if (current()) workout.voidSet(set); },
    retryCommand: (key: string) => { if (current()) workout.retryCommand(key); },
    reconcile: async () => { if (current()) await workout.reconcile(); },
    resetFinish: () => { if (current()) workout.resetFinish(); },
    dismissNotice: () => { if (current()) workout.dismissNotice(); },
    startRest: (occurrenceId: string) => canRest() ? timer.start(occurrenceId) : false,
    pauseRest: () => canRest() ? timer.pause() : false,
    resumeRest: () => canRest() ? timer.resume() : false,
    dismissRest: () => current() ? timer.dismiss() : false,
    finish: async () => { if (current()) { completionHold.current = true; timer.dismiss(); await workout.finish(); } },
  };
}

function useWorkoutQueue<T extends SavedSet, S extends QueueSession<T>, D extends SetDraft, C extends SetChanges>(
  { resources, initial, onUnauthenticated, onCompleted, onChanged }: WorkoutOptions<S, WorkoutPort<S, T, D, C>>,
  resourceOwner: object,
) {
  const [, render] = useReducer((n: number) => n + 1, 0);
  // Latest callbacks; queued work started in an earlier render must report through the current ones.
  const cb = useRef({ onUnauthenticated, onCompleted, onChanged });
  cb.current = { onUnauthenticated, onCompleted, onChanged };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const owner = useRef({ resources: resourceOwner, sessionId: initial.id, expired: false });
  if (owner.current.resources !== resourceOwner || owner.current.sessionId !== initial.id) owner.current.expired = true;
  const isCurrent = () => alive.current && !owner.current.expired;
  const session = useRef(initial);
  const commands = useRef<SetCommand<T, D, C>[]>([]);
  const complete = useRef<CompleteCommand | null>(null);
  const notice = useRef<WorkoutNotice>(null);
  const reloading = useRef<{ state: 'idle' | 'refreshing'; error: ServerError | null }>({ state: 'idle', error: null });
  const flight = useRef(false);
  const completionFlight = useRef(false);

  const canWriteSets = () => isCurrent() && session.current.status === 'active' && !completionFlight.current
    && complete.current?.state.status !== 'pending' && complete.current?.state.status !== 'unknown';

  const commit = () => { if (isCurrent()) render(); };
  const setSession = (next: S) => { session.current = next; commit(); };
  const setNotice = (next: WorkoutNotice) => { notice.current = next; commit(); };
  const update = (key: string, patch: Partial<SetCommand<T, D, C>>) => {
    commands.current = commands.current.map((c) => (c.key === key ? { ...c, ...patch } : c));
    commit();
  };
  const drop = (key: string) => { commands.current = commands.current.filter((c) => c.key !== key); commit(); };

  const applySet = (set: T, sessionRevision: number) => {
    const current = session.current;
    const exists = current.sets.some((s) => s.id === set.id);
    setSession({
      ...current,
      revision: Math.max(current.revision, sessionRevision),
      sets: exists ? current.sets.map((s) => (s.id === set.id ? set : s)) : [...current.sets, set],
    });
    cb.current.onChanged();
  };

  /** GET the session. Returns null (and records the error) when it cannot be read. */
  const reload = async (): Promise<S | null> => {
    const requestedId = session.current.id;
    reloading.current = { state: 'refreshing', error: null }; commit();
    try {
      const fresh = await resources.workout(requestedId);
      if (!isCurrent()) return null;
      if (fresh.id !== requestedId) throw new Error('The workout readback does not match the requested session.');
      reloading.current = { state: 'idle', error: null };
      const wasCompleted = session.current.status === 'completed';
      if (fresh.status === 'completed') {
        commands.current = [];
        complete.current = null;
      }
      setSession(fresh);
      if (fresh.status === 'completed' && !wasCompleted) cb.current.onCompleted(fresh);
      return fresh;
    } catch (error) {
      if (!isCurrent()) return null;
      const e = toServerError(error);
      if (e.status === 401) cb.current.onUnauthenticated();
      reloading.current = { state: 'idle', error: e }; commit();
      return null;
    }
  };

  /** Was this command's effect already applied on the server, judging by a freshly read session? */
  const appliedIn = (fresh: S, command: SetCommand<T, D, C>): boolean | null => {
    if (fresh.id !== owner.current.sessionId) return null;
    const p = command.payload;
    if (p.kind === 'add') {
      const found = fresh.sets.filter(s => s.occurrenceId === p.set.occurrenceId).find((s) => s.setNumber === p.set.setNumber);
      if (!found) return false;
      return setValuesMatch(found, p.set) && Number.isSafeInteger(found.revision) && found.revision >= 1
        && (command.sentRevision === null || fresh.revision > command.sentRevision);
    }
    const found = fresh.sets.find((s) => s.id === p.setId);
    if (!found) return null;
    if (command.sentSet && (found.occurrenceId !== command.sentSet.occurrenceId || found.setNumber !== command.sentSet.setNumber)) return false;
    if (p.kind === 'void') return found.status === 'voided' && !!command.sentSet
      && found.revision > command.sentSet.revision
      && setValuesMatch({ ...found, status: command.sentSet.status }, command.sentSet);
    return setValuesMatch(found, p.changes)
      && (!command.sentSet || found.revision > command.sentSet.revision);
  };

  const send = async (command: SetCommand<T, D, C>) => {
    const current = session.current;
    const p = command.payload;
    update(command.key, { state: { status: 'pending' } });
    try {
      if (p.kind === 'add') {
        const revision = command.sentRevision ?? current.revision;
        update(command.key, { sentRevision: revision });
        const result = await resources.addSet({ ...current, revision }, p.set, command.key);
        if (!isCurrent()) return;
        drop(command.key);
        applySet(result.set, result.sessionRevision);
      } else {
        const base = command.sentSet ?? current.sets.find((s) => s.id === p.setId) ?? null;
        if (!base) { drop(command.key); setNotice({ kind: 'info', text: TC.removeConflict }); return; }
        const captured = freezeSavedSet(base);
        const revision = command.sentRevision ?? current.revision;
        update(command.key, { sentSet: captured, sentRevision: revision });
        const result = p.kind === 'edit'
          ? await resources.editSet(current.id, captured, p.changes, command.key)
          : await resources.voidSet(current.id, captured, command.key);
        if (!isCurrent()) return;
        if ('schema' in captured && result.sessionRevision <= revision) throw new ApiError(502,
          'training_response_invalid', 'The source set revision could not be verified.', true);
        drop(command.key);
        applySet(result.set, result.sessionRevision);
      }
    } catch (error) {
      if (!isCurrent()) return;
      await settleError(commands.current.find(item => item.key === command.key) ?? command, toServerError(error));
    }
  };

  const settleError = async (command: SetCommand<T, D, C>, error: ServerError) => {
    const p = command.payload;
    const n = p.kind === 'add' ? p.set.setNumber : session.current.sets.find((s) => s.id === p.setId)?.setNumber ?? 0;
    if (error.status === 401) { drop(command.key); cb.current.onUnauthenticated(); return; }
    if (error.effectUnknown || command.wasUnknown) {
      // A later rejection does not settle the original unknown write or release its queued successors.
      if (command.wasUnknown && !error.effectUnknown
        && ['session_completed', 'stale_revision', 'set_voided', 'set_number_exists'].includes(error.code)) {
        const fresh = await reload();
        if (!isCurrent() || fresh?.status === 'completed') return;
        if (fresh && appliedIn(fresh, command)) {
          drop(command.key); cb.current.onChanged(); setNotice(null); return;
        }
      }
      update(command.key, { state: { status: 'unknown', error: { ...error, effectUnknown: true } }, wasUnknown: true });
      setNotice({ kind: 'warning', text: p.kind === 'void' ? TC.removeUnknown(n) : TC.setUnknown(n), retryKey: command.key });
      return;
    }
    if (error.code === 'session_completed') {
      drop(command.key);
      setNotice({ kind: 'info', text: trainingErrorCopy(error, true) });
      await reload();
      return;
    }
    if (p.kind === 'add' && error.code === 'set_number_exists') {
      const fresh = await reload();
      if (!fresh) { update(command.key, { state: { status: 'unknown', error } }); return; }
      const applied = appliedIn(fresh, command);
      if (applied) { drop(command.key); cb.current.onChanged(); setNotice(null); return; }
      drop(command.key); cb.current.onChanged(); setNotice({ kind: 'info', text: TC.setExists });
      return;
    }
    if (p.kind === 'add' && error.code === 'stale_revision') {
      // Definitely not applied: requeue the same intent with the fresh revision and a new key.
      const fresh = await reload();
      if (!fresh) { update(command.key, { state: { status: 'failed', error } }); setNotice({ kind: 'error', text: trainingErrorCopy(error, true) }); return; }
      commands.current = commands.current.map((c) => (c.key === command.key
        ? { ...c, key: commandKey(), state: idle, sentRevision: null, sentSet: null } : c));
      commit();
      return;
    }
    if (error.code === 'stale_revision' || error.code === 'set_voided') {
      drop(command.key);
      await reload();
      setNotice({ kind: 'info', text: error.code === 'stale_revision' ? TC.removeConflict : trainingErrorCopy(error, true) });
      return;
    }
    drop(command.key);
    setNotice({ kind: 'error', text: trainingErrorCopy(error, true) });
  };

  /** Sends the head of the queue while it is queued; an unresolved head blocks later commands. */
  const pump = async (): Promise<void> => {
    if (flight.current || !canWriteSets()) return;
    const head = commands.current[0];
    if (!head || head.state.status !== 'idle') return;
    flight.current = true;
    try { await send(head); } finally { flight.current = false; }
    void pump();
  };

  const enqueue = (payload: SetCommand<T, D, C>['payload']) => {
    if (!canWriteSets()) return;
    commands.current = [...commands.current, { key: commandKey(), payload: Object.freeze(payload), state: idle, sentRevision: null, sentSet: null, wasUnknown: false }];
    setNotice(null);
    void pump();
  };

  const logSet = (set: D) => enqueue({ kind: 'add', set: freezeSetDraft(set) });
  const editSet = (set: T, changes: C) => enqueue({ kind: 'edit', setId: set.id, changes: freezeSetChanges(changes) });
  const voidSet = (set: T) => enqueue({ kind: 'void', setId: set.id });

  /** Same key and same body for an unknown result; a conflicted add starts over as a new command. */
  const retryCommand = (key: string) => {
    if (!canWriteSets()) return;
    const command = commands.current.find((c) => c.key === key);
    if (!command) return;
    setNotice(null);
    if (command.state.status === 'unknown') update(key, { state: idle });
    else if (command.state.status === 'conflict' || command.state.status === 'failed') {
      update(key, { key: commandKey(), state: idle, sentRevision: null, sentSet: null, wasUnknown: false });
    }
    void pump();
  };

  /** Reload and clear unknown commands whose effect is now visible. */
  const reconcile = async () => {
    if (!isCurrent() || flight.current || completionFlight.current || reloading.current.state === 'refreshing') return;
    const fresh = await reload();
    if (!fresh) return;
    for (const command of commands.current) {
      if (command.state.status === 'unknown' && appliedIn(fresh, command)) drop(command.key);
    }
    if (!commands.current.some((c) => c.state.status === 'unknown')) setNotice(null);
    cb.current.onChanged();
    void pump();
  };

  /* ---------------- finish ---------------- */

  const finish = async () => {
    if (!isCurrent() || session.current.status !== 'active' || completionFlight.current || flight.current
      || reloading.current.state === 'refreshing') return;
    if (commands.current.length) return; // sets must settle first; the sheet explains this
    const current = session.current;
    const command = complete.current?.state.status === 'unknown' ? complete.current
      : { key: commandKey(), payload: { expectedRevision: current.revision }, state: idle };
    completionFlight.current = true;
    complete.current = { ...command, state: { status: 'pending' } }; commit();
    try {
      const done = await resources.completeWorkout({ ...current, revision: command.payload.expectedRevision }, command.key);
      if (!isCurrent()) return;
      complete.current = null;
      setSession(done);
      cb.current.onChanged();
      cb.current.onCompleted(done);
    } catch (error) {
      if (!isCurrent()) return;
      const e = toServerError(error);
      if (e.status === 401) { complete.current = null; cb.current.onUnauthenticated(); return; }
      if (e.effectUnknown) { complete.current = { ...command, state: { status: 'unknown', error: e } }; commit(); return; }
      if (e.code === 'session_completed' || e.code === 'stale_revision') {
        const fresh = await reload();
        if (!isCurrent() || fresh?.status === 'completed') return;
      }
      if (command.state.status === 'unknown' || e.code === 'session_completed') {
        // A later rejection cannot settle an earlier unknown effect without a completed readback.
        complete.current = { ...command, state: { status: 'unknown', error: { ...e, effectUnknown: true } } };
        commit(); return;
      }
      complete.current = { ...command, state: commandStateFrom(e) };
      commit();
    } finally {
      completionFlight.current = false;
    }
  };

  /** Clears a terminal finish error so the next confirm builds a fresh command from the current revision. */
  const resetFinish = () => {
    if (complete.current && complete.current.state.status !== 'unknown' && complete.current.state.status !== 'pending') {
      complete.current = null; commit();
    }
  };

  return {
    session: session.current,
    commands: commands.current,
    complete: complete.current,
    notice: notice.current,
    refresh: reloading.current,
    logSet, editSet, voidSet, retryCommand, reconcile, finish, resetFinish,
    dismissNotice: () => setNotice(null),
  };
}
