// Today (settings-training v2 DESIGN #training, flow.md, contracts.md#mode-matrix). Server data only; no sample numbers.
import { Pressable, StyleSheet, View } from 'react-native';
import type { AppMode, History, Plan, Stats, WorkoutSession } from '../../api/domain';
import { SessionSummary } from '../../variants/a/components';
import { L, t } from '../shared/tokens';
import { AccountRow, Art, Gutter, MetaLine, Nav, PrimaryAction, Screen, Section, Subtitle, Title, Txt, Wordmark } from '../shared/ui';
import { historyCovers, plural, sessionTotals, startedTime, weekStart, type Remote } from './model';

/* ---------------- Today ---------------- */

export function TodayScreen({ name, appMode, activePlan, active, history, stats, onSettings, onStart, onResume, onCreatePlan,
  entries }: {
  name: string; appMode: AppMode; activePlan: Plan | null; active: WorkoutSession | null;
  history: Remote<History>; stats: Remote<Stats>;
  onSettings: () => void; onStart: () => void; onResume: (session: WorkoutSession) => void; onCreatePlan: () => void;
  entries: { label: string; onPress: () => void; testID: string }[];
}) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const week = weekStart(new Date()).getTime();
  const thisWeek = history.status === 'ready' && historyCovers(history.value, new Date(week))
    ? history.value.items.filter((s) => s.status === 'completed' && s.completedAt && Date.parse(s.completedAt) >= week) : null;
  return (
    <Screen testID="screen-today" nav={(
      <Nav leading={<Wordmark />} trailing={(
        <View style={s.navTrail}>
          <Txt role="meta" tone="secondary">{today}</Txt>
          {/* DGR-001 (v2): the avatar opens Settings directly. */}
          <Pressable testID="a-account-entry" accessibilityRole="button" accessibilityLabel={`Settings, ${name}`} onPress={onSettings} style={s.avatar}>
            <Txt role="bodyStrong">{(name.trim()[0] ?? '·').toUpperCase()}</Txt>
          </Pressable>
        </View>
      )} />
    )}>
      <Gutter>
        <Title display text={`Hello, ${name}.`} testID="a-today-title" />
        <Subtitle text="Let’s make room to move." />
      </Gutter>
      <Gutter style={s.gap32}><Art /></Gutter>
      <Section>
        {active ? (
          <>
            <SessionSummary eyebrow={`In progress · started ${startedTime(active.startedAt)}`} title={active.planSnapshot.name}
              meta={[plural(active.sets.filter((x) => x.status === 'confirmed').length, 'set logged', 'sets logged')]} />
            <PrimaryAction label="Resume workout" captureId="a-today-primary" onPress={() => onResume(active)} />
          </>
        ) : activePlan ? (
          <>
            <SessionSummary title={activePlan.name} meta={[`${activePlan.minutes} minutes`, plural(activePlan.items.length, 'movement', 'movements')]} />
            <PrimaryAction label="Start" captureId="a-today-primary" onPress={onStart} />
          </>
        ) : (
          <PrimaryAction label="Create a plan" icon="plus" captureId="a-today-primary" onPress={onCreatePlan} />
        )}
      </Section>
      {appMode === 'advanced' && thisWeek && stats.status === 'ready' ? (
        <Section tight>
          <Txt role="meta" tone="secondary">This week</Txt>
          <MetaLine items={[plural(thisWeek.length, 'workout finished', 'workouts finished'),
            plural(thisWeek.reduce((n, x) => n + sessionTotals(x).confirmedSets, 0), 'confirmed set', 'confirmed sets')]} />
        </Section>
      ) : null}
      {entries.length ? (
        <Section tight>
          {entries.map((e, i) => <AccountRow key={e.testID} label={e.label} testID={e.testID} onPress={e.onPress} last={i === entries.length - 1} />)}
        </Section>
      ) : null}
    </Screen>
  );
}

const s = StyleSheet.create({
  gap32: { marginTop: t.space.s32 },
  navTrail: { flexDirection: 'row', alignItems: 'center', gap: t.space.s12 },
  avatar: {
    width: L.account.avatar, height: L.account.avatar, borderRadius: t.radius.capsule, backgroundColor: t.color.selection,
    alignItems: 'center', justifyContent: 'center',
  },
});
