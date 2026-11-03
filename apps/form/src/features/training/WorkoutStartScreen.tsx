// Workout start, the Workout tab root (settings-training v2 DESIGN #training, flow.md, contracts.md#mode-matrix). Server data only; no sample numbers.
import { StyleSheet, View } from 'react-native';
import type { AppMode, Exercise, Plan, WorkoutSession } from '../../api/domain';
import { LoadingSkeleton, SessionSummary } from '../../variants/a/components';
import { t } from '../shared/tokens';
import { ChoiceRow, Choices, Gutter, Nav, Notice, PlainAction, PrimaryAction, Screen, Section, Title, Txt } from '../shared/ui';
import { TC, trainingErrorCopy } from './copy';
import { ErrorNotice } from './ErrorNotice';
import { plural, repsRange, startedTime, type PendingCommand, type Remote } from './model';

/* ---------------- Workout start (tab root) ---------------- */

export function WorkoutStartScreen({ appMode, plans, exercises, active, selectedId, start, onSelect, onStart, onRetryStart, onResume,
  onOpenPlans, onRetryLoad }: {
  appMode: AppMode; plans: Plan[]; exercises: Record<string, Exercise>; active: Remote<WorkoutSession | null>; selectedId: string | null;
  start: PendingCommand<{ planId: string; expectedPlanRevision: number }> | null;
  onSelect: (planId: string) => void; onStart: (plan: Plan) => void; onRetryStart: () => void;
  onResume: (session: WorkoutSession) => void; onOpenPlans: () => void; onRetryLoad: () => void;
}) {
  const advanced = appMode === 'advanced';
  const selected = plans.find((p) => p.id === selectedId) ?? plans[0] ?? null;
  const resume = active.status === 'ready' ? active.value : null;
  const startState = start?.state;
  const meta = (p: Plan) => [`${p.minutes} min`,
    ...(advanced ? [plural(p.items.length, 'movement', 'movements'), plural(p.items.reduce((n, i) => n + i.setTarget, 0), 'set', 'sets')] : [])];
  return (
    <Screen testID="screen-workout-start" nav={<Nav leading={<Txt role="bodyStrong">Workout</Txt>} />}>
      <Gutter><Title text="Workout" testID="a-workout-start-title" /></Gutter>
      <Section>
        <ErrorNotice remote={active} onRetry={onRetryLoad} />
        {active.status === 'loading' ? <LoadingSkeleton /> : null}
        {resume ? (
          <>
            <SessionSummary eyebrow={`In progress · started ${startedTime(resume.startedAt)}`} title={resume.planSnapshot.name}
              meta={[plural(resume.sets.filter((x) => x.status === 'confirmed').length, 'set logged', 'sets logged')]} />
            <PrimaryAction label={`Resume ${resume.planSnapshot.name}`} captureId="a-resume" onPress={() => onResume(resume)} />
          </>
        ) : null}
      </Section>
      {plans.length === 0 ? (
        <Section>
          <Txt role="sectionTitle" accessibilityRole="header">{TC.plansEmpty}</Txt>
          <PrimaryAction label="Create a plan" icon="plus" captureId="a-create-plan" onPress={onOpenPlans} />
        </Section>
      ) : (
        <Section>
          <Choices>
            {plans.map((p) => (
              <ChoiceRow key={p.id} title={p.name} detail={meta(p).join(' · ')} selected={selected?.id === p.id}
                testID={`a-start-plan-${p.id}`} onPress={() => onSelect(p.id)} />
            ))}
          </Choices>
          {advanced && selected ? (
            <View style={s.targets}>
              {selected.items.map((item) => (
                <Txt key={item.id} role="meta" tone="secondary">
                  {`${exercises[item.exerciseId]?.name ?? 'Movement'} · ${plural(item.setTarget, 'set', 'sets')} · ${repsRange(item.repMin, item.repMax)}`}
                </Txt>
              ))}
            </View>
          ) : null}
          {startState?.status === 'unknown' ? (
            <Notice kind="warning" text={TC.writeUnknown} announce action={{ label: TC.tryAgain, onPress: onRetryStart }} />
          ) : null}
          {startState?.status === 'failed' || startState?.status === 'conflict' ? (
            <Notice kind="error" text={trainingErrorCopy(startState.error, true)} announce />
          ) : null}
          {selected ? (resume
            ? <PlainAction label={`Start ${selected.name}`} captureId="a-start" disabled={startState?.status === 'pending' || startState?.status === 'unknown'} onPress={() => onStart(selected)} />
            : <PrimaryAction label="Start" captureId="a-start" loading={startState?.status === 'pending'}
              disabled={startState?.status === 'unknown'} onPress={() => onStart(selected)} />) : null}
          {resume ? <Txt role="meta" tone="secondary">{TC.resumeFootnote}</Txt> : null}
        </Section>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  targets: { gap: t.space.s4 },
});
