// plans + plan-edit (form-onboarding v1). Multiple account plans; edits are revision-guarded, creation is keyed.
// Past workouts keep their own plan snapshot on the server, so edits never rewrite history.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ApiError, commandKey } from '../../api/client';
import type { AppMode, Exercise, Plan, PlanItem } from '../../api/domain';
import type { FormResources } from '../../api/resources';
import type { SaveResult } from '../contract';
import { guardedSave, useCommandKey } from '../shared/commands';
import { COPY, errorCopy, loadText, movementWord, repsText, setWord } from '../shared/copy';
import { KG_PER_LB } from '../onboarding/model';
import { Icon } from '../shared/icons';
import { L, t } from '../shared/tokens';
import {
  AccountRow, Fields, Gutter, MetaLine, Nav, Notice, Panel, PlainAction, PrimaryAction, Screen, Section, Sheet,
  StepperField, Subtitle, Title, Txt,
} from '../shared/ui';

type Banner = { kind: 'error' | 'info'; text: string; retry?: () => void } | null;
type PlanCommand = { kind: 'create' | 'edit'; retry: () => Promise<SaveResult<Plan>>; wasUnknown: boolean };

export function PlansScreen({ plans, activePlanId, backLabel, onBack, onOpen, onCreate, error, onRetry }: {
  plans: Plan[]; activePlanId: string | null; backLabel: string; onBack: () => void;
  onOpen: (planId: string) => void; onCreate: () => void; error: string | null; onRetry: () => void;
}) {
  const active = plans.find((p) => p.id === activePlanId) ?? null;
  const others = plans.filter((p) => p.id !== active?.id);
  return (
    <Screen testID="screen-plans" nav={<Nav back={backLabel} onBack={onBack} />}>
      <Gutter>
        <Title text="Your plans" testID="a-plans-title" />
        <Subtitle text="Switch plans anytime. Your history stays with each workout." />
      </Gutter>
      <Section>
        {error ? <Notice kind="error" text={error} action={{ label: 'Try again', onPress: onRetry }} /> : null}
        {active ? (
          <Panel testID="a-plan-active">
            <Txt role="meta" tone="secondary">Active</Txt>
            <Txt role="sectionTitle">{active.name}</Txt>
            <MetaLine items={[`${active.minutes} minutes`, movementWord(active.items.length)]} />
            <View style={s.panelAction}><PlainAction label="Edit plan" captureId="a-plan-edit" onPress={() => onOpen(active.id)} /></View>
          </Panel>
        ) : null}
        {others.length ? (
          <View style={s.rows}>
            {others.map((p, i) => (
              <AccountRow key={p.id} label={p.name} detail={`${p.minutes} minutes, ${movementWord(p.items.length)}`}
                testID={`a-plan-${i + 2}`} last={i === others.length - 1} onPress={() => onOpen(p.id)} />
            ))}
          </View>
        ) : null}
      </Section>
      <Section style={s.bottom}>
        <PrimaryAction label="Create a plan" icon="plus" captureId="a-plan-create" onPress={onCreate} />
      </Section>
    </Screen>
  );
}

/** DGR-004 defaults for a newly added movement; confirmed in the movement sheet before it joins the plan. */
const NEW_ITEM = { setTarget: 3, repMin: 8, repMax: 10, targetKg: 0 } as const;

export function PlanEditScreen({ resources, plan, exercises, appMode, loadUnit, defaultMinutes, onBack, onSaved, onUnauthenticated }: {
  resources: FormResources;
  /** null creates a new plan (DGR-004). */
  plan: Plan | null;
  exercises: Exercise[];
  appMode: AppMode;
  loadUnit: 'kg' | 'lb';
  defaultMinutes: number;
  onBack: () => void;
  onSaved: (plan: Plan) => void;
  onUnauthenticated: () => void;
}) {
  const [current, setCurrent] = useState<Plan | null>(plan);
  const [items, setItems] = useState<PlanItem[]>(plan?.items ?? []);
  const [editing, setEditing] = useState<{ item: PlanItem; isNew: boolean } | null>(null);
  const [picking, setPicking] = useState(plan === null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const pending = useRef<PlanCommand | null>(null);
  const alive = useRef(true);
  const [banner, setBanner] = useState<Banner>(null);
  const create = useCommandKey();
  const currentResources = useRef(resources);
  currentResources.current = resources;
  const originalAuth = useMemo(() => resources.api.captureAuthContext(), [resources]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const names = useMemo(() => new Map(exercises.map((e) => [e.id, e.name])), [exercises]);
  const original = useMemo(() => new Map((current?.items ?? []).map((i) => [i.id, i])), [current]);
  const dirty = !current || JSON.stringify(current.items) !== JSON.stringify(items);
  const title = current?.name ?? 'New plan';
  const blocked = busy || pending.current !== null;
  const canEdit = () => alive.current && !sending.current && pending.current === null;
  const leave = () => { if (canEdit()) onBack(); };

  const reload = async (): Promise<Plan> => {
    const originalResources = resources, planId = current?.id;
    const assertCurrent = () => {
      if (!alive.current || currentResources.current !== originalResources || !originalAuth.isCurrent()) {
        throw new ApiError(409, 'session_changed', 'The original plan session is no longer available.');
      }
    };
    assertCurrent();
    const training = await originalResources.sourceTraining();
    assertCurrent();
    const plans = await training.plans();
    assertCurrent();
    const matches = plans.items.filter(p => p.id === planId);
    const latest = matches.length === 1 ? matches[0] : undefined;
    if (!latest || latest.archived || 'schema' in latest) throw new ApiError(404, 'not_found', 'This plan is no longer available.');
    return latest;
  };

  const release = (command: PlanCommand) => {
    pending.current = null;
    if (command.kind === 'create') create.settle();
  };

  const showUnknown = (command: PlanCommand) => {
    setBanner({ kind: 'error', text: 'The result could not be confirmed. Retry this same action without changing it.',
      retry: () => void perform(command) });
  };

  const settle = (result: SaveResult<Plan>, command: PlanCommand) => {
    switch (result.status) {
      case 'saved': release(command); setCurrent(result.value); onSaved(result.value); return;
      case 'stale':
        if (command.kind === 'create' && command.wasUnknown) { showUnknown(command); return; }
        release(command);
        setCurrent(result.latest); // local items stay as edited; the next Done saves against the latest revision
        setBanner({ kind: 'info', text: COPY.stale });
        return;
      case 'unknown':
        command.wasUnknown = true;
        command.retry = result.retry;
        showUnknown(command);
        return;
      default:
        if (result.error.status === 401) { release(command); onUnauthenticated(); return; }
        // A later rejection cannot settle an earlier unknown write; only retry or successful readback can.
        if (command.wasUnknown) { showUnknown(command); return; }
        release(command);
        setBanner({ kind: 'error', text: errorCopy(result.error) });
    }
  };

  const perform = async (command: PlanCommand) => {
    // Refs guard callbacks retained from older renders as well as repeated taps before the next render.
    if (!alive.current || sending.current || pending.current !== command) return;
    sending.current = true;
    setBusy(true);
    setBanner(null);
    try {
      const result = await command.retry();
      if (alive.current && pending.current === command) settle(result, command);
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const done = () => {
    if (!canEdit()) return;
    if (!dirty) { leave(); return; }
    const capturedItems = items.map((item) => ({ ...item }));
    let command: PlanCommand;
    if (current) {
      const base = { ...current, items: current.items.map((item) => ({ ...item })) };
      const body = { items: capturedItems };
      command = { kind: 'edit', wasUnknown: false, retry: () => guardedSave(() => resources.editPlan(base, body), reload) };
    } else {
      const fields = { name: title, minutes: defaultMinutes, items: capturedItems };
      const key = create.keyFor({ op: 'create-plan', fields });
      command = { kind: 'create', wasUnknown: false, retry: () => guardedSave(() => resources.createPlan(fields, key),
        () => Promise.reject(new ApiError(409, 'conflict', 'Plan creation conflicted.'))) };
    }
    pending.current = command;
    void perform(command);
  };

  const addMovement = (exercise: Exercise) => {
    if (!canEdit()) return;
    setPicking(false);
    setEditing({ isNew: true, item: { id: `item-${commandKey()}`, exerciseId: exercise.id, ...NEW_ITEM } });
  };

  return (
    <>
      <Screen testID="screen-plan-edit"
        nav={<Nav back="Plans" onBack={leave} trailing={<PlainAction label="Done" captureId="a-plan-done" chevron={null} placement="trailing"
          disabled={blocked || items.length === 0} onPress={done} />} />}>
        <Gutter>
          <Title text={title} testID="a-plan-title" />
          <Subtitle text="Edits apply to your next workout. Past workouts keep what you did." />
        </Gutter>
        <Section>
          {banner ? <Notice kind={banner.kind} text={banner.text} announce action={banner.retry ? { label: 'Try again', onPress: banner.retry } : null} /> : null}
          <View accessibilityRole="list">
            {items.map((item, i) => (
              <Pressable key={item.id} testID={`a-plan-move-${i + 1}`} accessibilityRole="button" disabled={blocked}
                onPress={() => { if (canEdit()) setEditing({ item, isNew: false }); }} style={({ pressed }) => [s.mrow, i === items.length - 1 && s.mrowLast, pressed && s.pressed]}>
                <Txt role="sectionTitle" style={s.ord} accessibilityElementsHidden importantForAccessibility="no">{String(i + 1)}</Txt>
                <View style={s.mtext}>
                  <Txt role="bodyStrong">{names.get(item.exerciseId) ?? item.exerciseId}</Txt>
                  <MetaLine items={itemMeta(item, appMode, loadUnit)} />
                </View>
                <Icon name="chevron-right" size={L.icon.inline} color={t.color.secondary} />
              </Pressable>
            ))}
          </View>
          <PlainAction label="Add a movement" captureId="a-plan-add" chevron={null} lead="plus" disabled={blocked}
            onPress={() => { if (canEdit()) setPicking(true); }} />
        </Section>
      </Screen>
      <MovementSheet
        editing={editing}
        name={editing ? names.get(editing.item.exerciseId) ?? editing.item.exerciseId : ''}
        previousKg={editing && !editing.isNew ? original.get(editing.item.id)?.targetKg ?? null : null}
        loadUnit={loadUnit}
        onClose={() => setEditing(null)}
        onSave={(next) => {
          if (!canEdit()) return;
          const saved = { ...next };
          setItems((list) => (editing?.isNew ? [...list, saved] : list.map((x) => (x.id === saved.id ? saved : x))));
          setEditing(null);
        }}
        onRemove={(id) => { if (!canEdit()) return; setItems((list) => list.filter((x) => x.id !== id)); setEditing(null); }}
      />
      <Sheet visible={picking} large title="Add a movement" onClose={() => { setPicking(false); if (!current && items.length === 0) leave(); }}
        closeTestID="a-pick-close" testID="a-pick-sheet">
        {exercises.filter((e) => !e.retired).map((e, i, list) => (
          <AccountRow key={e.id} label={e.name} onPress={() => addMovement(e)} last={i === list.length - 1} />
        ))}
      </Sheet>
    </>
  );
}

/** DGR-002: Advanced shows sets, rep range and target weight; Basic leaves out the target weight. Data is unchanged. */
export function itemMeta(item: PlanItem, mode: AppMode, unit: 'kg' | 'lb'): string[] {
  const base = [setWord(item.setTarget), repsText(item.repMin, item.repMax)];
  return mode === 'advanced' ? [...base, loadText(item.targetKg, unit)] : base;
}

function MovementSheet({ editing, name, previousKg, loadUnit, onClose, onSave, onRemove }: {
  editing: { item: PlanItem; isNew: boolean } | null; name: string; previousKg: number | null; loadUnit: 'kg' | 'lb';
  onClose: () => void; onSave: (item: PlanItem) => void; onRemove: (id: string) => void;
}) {
  const [draft, setDraft] = useState<PlanItem | null>(null);
  const item = draft && editing && draft.id === editing.item.id ? draft : editing?.item ?? null;
  if (!editing || !item) return <Sheet visible={false} title="" onClose={onClose}>{null}</Sheet>;
  const update = (next: Partial<PlanItem>) => setDraft({ ...item, ...next });
  const kgStep = (d: -1 | 1) => (loadUnit === 'kg'
    ? Math.round((item.targetKg + d * 0.5) * 2) / 2 // 0.5 kg client convention
    : Math.round((Math.round(item.targetKg / KG_PER_LB) + d) * KG_PER_LB * 100) / 100);
  const weight = loadUnit === 'kg' ? String(item.targetKg) : String(Math.round(item.targetKg / KG_PER_LB));
  return (
    <Sheet visible title={name} onClose={() => { setDraft(null); onClose(); }} closeTestID="a-move-close" testID="a-move-sheet"
      actions={(
        <>
          <PrimaryAction label={editing.isNew ? 'Add to plan' : 'Save changes'} captureId="a-move-save"
            onPress={() => { setDraft(null); onSave(item); }} />
          {editing.isNew ? null : (
            <View style={s.center}><RemoveAction onPress={() => { setDraft(null); onRemove(item.id); }} /></View>
          )}
        </>
      )}>
      <Fields>
        <StepperField label={loadUnit === 'kg' ? 'Weight, kg' : 'Weight, lb'} value={weight} testID="a-move-weight" focused full
          onStep={(d) => update({ targetKg: Math.min(500, Math.max(0, kgStep(d))) })} />
      </Fields>
      <Fields>
        <StepperField label="Reps from" value={String(item.repMin)} testID="a-move-rep-min"
          onStep={(d) => { const repMin = Math.min(100, Math.max(1, item.repMin + d)); update({ repMin, repMax: Math.max(repMin, item.repMax) }); }} />
        <StepperField label="Reps to" value={String(item.repMax)} testID="a-move-rep-max"
          onStep={(d) => { const repMax = Math.min(100, Math.max(1, item.repMax + d)); update({ repMax, repMin: Math.min(repMax, item.repMin) }); }} />
      </Fields>
      <Fields>
        <StepperField label="Sets" value={String(item.setTarget)} testID="a-move-sets"
          onStep={(d) => update({ setTarget: Math.min(20, Math.max(1, item.setTarget + d)) })} />
      </Fields>
      {previousKg !== null && previousKg !== item.targetKg ? <Txt role="meta" tone="secondary">{`Was ${loadText(previousKg, loadUnit)}.`}</Txt> : null}
    </Sheet>
  );
}

function RemoveAction({ onPress }: { onPress: () => void }) {
  return (
    <Pressable testID="a-move-remove" accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.remove, pressed && s.pressed]}>
      <Txt role="bodyStrong" tone="error">Remove from plan</Txt>
    </Pressable>
  );
}

const s = StyleSheet.create({
  panelAction: { marginTop: t.space.s4 },
  rows: { marginTop: t.space.s8 },
  bottom: { marginBottom: t.space.s24 },
  mrow: {
    flexDirection: 'row', alignItems: 'center', gap: L.movementRow.gap, minHeight: L.movementRow.minHeight,
    paddingVertical: L.movementRow.paddingY, borderBottomWidth: t.stroke.divider, borderBottomColor: t.color.line,
  },
  mrowLast: { borderBottomWidth: 0 },
  ord: { minWidth: t.type.sectionTitle.fontSize * L.movementRow.ordinalColumn, alignSelf: 'flex-start' },
  mtext: { flex: 1, minWidth: 0, gap: L.movementRow.detailGap },
  pressed: { backgroundColor: t.color.selection },
  center: { alignItems: 'center' },
  remove: { minHeight: L.plainAction.minHeight, justifyContent: 'center', paddingHorizontal: L.plainAction.paddingX, borderRadius: t.radius.small },
});
