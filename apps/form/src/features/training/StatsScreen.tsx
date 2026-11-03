// Stats, the Progress tab root (settings-training v2 DESIGN #training, flow.md, contracts.md#mode-matrix). Server data only; no sample numbers.
import { StyleSheet, View } from 'react-native';
import type { AppMode, Exercise, History, Preferences, Stats, WorkoutSession } from '../../api/domain';
import { EmptyBlock, LoadingSkeleton, SummaryRow } from '../../variants/a/components';
import { t } from '../shared/tokens';
import { Gutter, Nav, Notice, PlainAction, Screen, Section, Spinner, Title, Txt } from '../shared/ui';
import { TC } from './copy';
import { ErrorNotice } from './ErrorNotice';
import { historyMeta } from './HistoryScreen';
import { completedPerWeek, historyCovers, loadLabel, weekStart, WEEK_MS, type Remote } from './model';
import { ExerciseStatRow, SessionRow, WeekBars } from './parts';

type LoadUnit = Preferences['loadUnit'];

/* ---------------- Stats (Progress tab root) ---------------- */

export function StatsScreen({ appMode, stats, history, active, exercises, loadUnit, onRefresh, onOpenHistory, onOpenSession,
  onStartWorkout }: {
  appMode: AppMode; stats: Remote<Stats>; history: Remote<History>; active: WorkoutSession | null;
  exercises: Record<string, Exercise>; loadUnit: LoadUnit;
  onRefresh: () => void; onOpenHistory: () => void; onOpenSession: (id: string) => void; onStartWorkout: () => void;
}) {
  const advanced = appMode === 'advanced';
  const nav = <Nav leading={<Txt role="bodyStrong">Progress</Txt>} />;
  if (stats.status === 'loading') return <Screen testID="screen-stats" nav={nav}><Section><LoadingSkeleton /></Section></Screen>;
  if (stats.status === 'error') return <Screen testID="screen-stats" nav={nav}><Section><ErrorNotice remote={stats} onRetry={onRefresh} /></Section></Screen>;
  const value = stats.value;
  const empty = value.completedSessions === 0 && value.confirmedSets === 0;
  const since = new Date(weekStart(new Date()).getTime() - 3 * WEEK_MS);
  const weeks = advanced && history.status === 'ready' && historyCovers(history.value, since)
    ? completedPerWeek(history.value.items, new Date(), 4) : null;
  return (
    <Screen testID="screen-stats" nav={nav}>
      <Gutter><Title text="Look what adds up." testID="a-progress-heading" /></Gutter>
      {stats.refreshError ? (
        <Section tight><Notice kind="info" text={TC.statsStale} action={{ label: 'Retry', onPress: onRefresh }} /></Section>
      ) : null}
      {empty ? (
        <Section>
          <EmptyBlock title={TC.statsEmptyTitle} body={TC.statsEmptyBody} action={TC.statsEmptyAction} onAction={onStartWorkout}
            captureId="a-progress-empty" actionId="a-progress-primary" />
        </Section>
      ) : (
        <>
          <Section>
            <View accessible accessibilityLabel={`${value.completedSessions} workouts finished`} style={s.stat} testID="a-progress-stat">
              <Txt role="stat">{String(value.completedSessions)}</Txt>
              <Txt role="body">{value.completedSessions === 1 ? 'workout finished' : 'workouts finished'}</Txt>
            </View>
            <SummaryRow value={value.confirmedSets} text={value.confirmedSets === 1 ? ' confirmed set' : ' confirmed sets'} />
            <SummaryRow value={value.repetitions} text={value.repetitions === 1 ? ' rep' : ' total reps'} />
            {advanced && value.volumeKg > 0 ? <Txt role="body">{`${loadLabel(value.volumeKg, loadUnit)} total volume`}</Txt> : null}
          </Section>
          {weeks ? (
            <Section>
              <Txt role="sectionTitle" accessibilityRole="header">Last 4 weeks</Txt>
              <WeekBars weeks={weeks} />
            </Section>
          ) : null}
          {advanced && value.byExercise.length ? (
            <Section>
              <Txt role="sectionTitle" accessibilityRole="header">By movement</Txt>
              {value.byExercise.map((b, i) => (
                <ExerciseStatRow key={b.exerciseId} name={exercises[b.exerciseId]?.name ?? 'Movement'} sets={b.confirmedSets} reps={b.repetitions}
                  volumeKg={b.volumeKg} bestKg={b.maxWeightKg} unit={loadUnit} last={i === value.byExercise.length - 1} />
              ))}
              {value.includesActiveConfirmedSets && active ? <Txt role="meta" tone="secondary">{TC.statsActiveIncluded}</Txt> : null}
            </Section>
          ) : null}
        </>
      )}
      <Section>
        <Txt role="sectionTitle" accessibilityRole="header">Recent workouts</Txt>
        <ErrorNotice remote={history} onRetry={onRefresh} />
        {history.status === 'loading' ? <Spinner /> : null}
        {history.status === 'ready' ? history.value.items.slice(0, 3).map((x, i, list) => (
          <SessionRow key={x.id} session={x} meta={historyMeta(x, appMode, loadUnit)} onPress={() => onOpenSession(x.id)} last={i === list.length - 1} />
        )) : null}
        {history.status === 'ready' && history.value.items.length ? (
          <PlainAction label="See all workouts" captureId="a-history-all" onPress={onOpenHistory} />
        ) : null}
      </Section>
    </Screen>
  );
}

const s = StyleSheet.create({
  stat: { flexDirection: 'row', alignItems: 'baseline', gap: t.space.s8, flexWrap: 'wrap' },
});
