// settings-training v2 components ST-01 SetLogRow, ST-02 TargetTable, ST-03 ExerciseStatRow, plus real-data forms of the
// Open Mat HistoryRow and WeeklyChart (the Open Mat originals are bound to showcase fixtures). Values come from tokens only.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { PerformedSet, PlanItem, Preferences, WorkoutSession } from '../../api/domain';
import { tabular, useTextScale } from '../../variants/a/theme';
import { Icon } from '../shared/icons';
import { L, t } from '../shared/tokens';
import { MetaLine, PlainAction, Txt } from '../shared/ui';
import { TC } from './copy';
import { formatNumber, loadLabel, plural, repsRange, weekLabel, type CommandState } from './model';

type LoadUnit = Preferences['loadUnit'];

export type RowStatus = 'saved' | 'pending' | 'removing' | 'unknown' | 'draft' | 'voided';

export function rowStatus(set: PerformedSet | null, command: CommandState | null, removing: boolean): RowStatus {
  if (command?.status === 'pending' || command?.status === 'idle') return removing ? 'removing' : 'pending';
  if (command?.status === 'unknown' || command?.status === 'conflict') return 'unknown';
  if (set?.status === 'voided') return 'voided';
  if (set?.status === 'draft') return 'draft';
  return 'saved';
}

/* ---------------- ST-01 SetLogRow ---------------- */

export function SetLogRow({ n, reps, weightKg, unit, status, onPress, onRetry, onConfirm, testID }: {
  n: number; reps: number; weightKg: number; unit: LoadUnit; status: RowStatus;
  onPress?: () => void; onRetry?: () => void; onConfirm?: () => void; testID?: string;
}) {
  const struck = status === 'voided';
  const text = `Set ${n} · ${plural(reps, 'rep', 'reps')} · ${loadLabel(weightKg, unit)}`;
  const trailing: ReactNode = (() => {
    switch (status) {
      case 'pending': return <State icon="loader-circle" tone="secondary" text={TC.saving} />;
      case 'removing': return <State icon="loader-circle" tone="secondary" text={TC.removing} />;
      case 'unknown': return (
        <View style={s.stateCol}>
          <State icon="triangle-alert" tone="warning" text={TC.unconfirmed} />
          {onRetry ? <PlainAction label={TC.tryAgain} chevron={null} placement="trailing" onPress={onRetry} /> : null}
        </View>
      );
      case 'draft': return onConfirm
        ? <PlainAction label="Confirm" chevron={null} placement="trailing" onPress={onConfirm} />
        : <State icon="triangle-alert" tone="warning" text={TC.unconfirmed} />;
      case 'voided': return <Txt role="meta" tone="secondary">{TC.removed}</Txt>;
      default: return <State icon="circle-check" tone="success" text={TC.saved} />;
    }
  })();
  const label = `${text}, ${status === 'saved' ? TC.saved : status === 'voided' ? TC.removed
    : status === 'unknown' || status === 'draft' ? TC.unconfirmed : status === 'removing' ? TC.removing : TC.saving}`;
  const body = (
    <>
      <Txt role="body" style={[s.flex, tabular, struck && s.struck]} tone={struck ? 'secondary' : 'ink'}>{text}</Txt>
      {trailing}
    </>
  );
  if (!onPress) return <View testID={testID} accessible accessibilityLabel={label} style={s.setRow}>{body}</View>;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [s.setRow, pressed && s.pressed]}>
      {body}
    </Pressable>
  );
}

function State({ icon, tone, text }: { icon: 'loader-circle' | 'triangle-alert' | 'circle-check'; tone: 'secondary' | 'warning' | 'success'; text: string }) {
  return (
    <View style={s.state}>
      <Icon name={icon} size={L.icon.inline} color={t.color[tone]} />
      <Txt role="meta" tone={tone}>{text}</Txt>
    </View>
  );
}

/* ---------------- ST-02 TargetTable (Advanced) ---------------- */

export type TargetRow = { n: number; set: PerformedSet | null; status: RowStatus; current: boolean; reps?: number; weightKg?: number };

export function TargetTable({ target, rows, unit, onPress, onRetry }: {
  target: PlanItem; rows: readonly TargetRow[]; unit: LoadUnit;
  onPress?: (row: TargetRow) => void; onRetry?: (row: TargetRow) => void;
}) {
  const { large } = useTextScale();
  const targetText = `${repsRange(target.repMin, target.repMax).replace(' reps', '')} × ${loadLabel(target.targetKg, unit)}`;
  return (
    <View accessibilityRole="list" testID="a-target-table">
      {large ? null : (
        <View style={[s.tRow, s.tHead]}>
          <Txt role="meta" tone="secondary" style={s.tSet}>Set</Txt>
          <Txt role="meta" tone="secondary" style={s.flex}>Target</Txt>
          <Txt role="meta" tone="secondary" style={s.flex}>Done</Txt>
        </View>
      )}
      {rows.map((row) => {
        const reps = row.set?.reps ?? row.reps;
        const kg = row.set?.weightKg ?? row.weightKg;
        const done = reps === undefined || kg === undefined ? '—' : `${formatNumber(reps)} × ${loadLabel(kg, unit)}`;
        const struck = row.status === 'voided';
        const note = row.status === 'voided' ? TC.removed : row.status === 'draft' || row.status === 'unknown' ? TC.unconfirmed
          : row.status === 'pending' ? TC.saving : row.status === 'removing' ? TC.removing : null;
        const label = `Set ${row.n}. Target ${targetText}. Done ${done}${note ? `, ${note}` : ''}`;
        const content = large ? (
          <View style={s.tCard}>
            <Txt role="bodyStrong">{`Set ${row.n}`}</Txt>
            <Txt role="body">{`Target ${targetText}`}</Txt>
            <Txt role="body" style={struck && s.struck}>{`Done ${done}`}</Txt>
            {note ? <Txt role="meta" tone={row.status === 'unknown' || row.status === 'draft' ? 'warning' : 'secondary'}>{note}</Txt> : null}
          </View>
        ) : (
          <>
            <Txt role="bodyStrong" style={[s.tSet, tabular]}>{String(row.n)}</Txt>
            <Txt role="body" style={[s.flex, tabular]}>{targetText}</Txt>
            <View style={s.flex}>
              <Txt role="body" tone={struck ? 'secondary' : 'ink'} style={[tabular, struck && s.struck]}>{done}</Txt>
              {note ? <Txt role="meta" tone={row.status === 'unknown' || row.status === 'draft' ? 'warning' : 'secondary'}>{note}</Txt> : null}
            </View>
          </>
        );
        const style = [s.tRow, row.current && s.tCurrent, large && s.tRowLarge];
        if (row.status === 'unknown' && onRetry) {
          return (
            <View key={row.n} style={style} accessible accessibilityLabel={label}>
              {content}
              <PlainAction label={TC.tryAgain} chevron={null} placement="trailing" onPress={() => onRetry(row)} />
            </View>
          );
        }
        if (!onPress || !row.set || row.status === 'voided') return <View key={row.n} style={style} accessible accessibilityLabel={label}>{content}</View>;
        return (
          <Pressable key={row.n} accessibilityRole="button" accessibilityLabel={label} onPress={() => onPress(row)}
            style={({ pressed }) => [...style, pressed && s.pressed]}>
            {content}
          </Pressable>
        );
      })}
    </View>
  );
}

/* ---------------- ST-03 ExerciseStatRow (Advanced Stats) ---------------- */

export function ExerciseStatRow({ name, sets, reps, volumeKg, bestKg, unit, last }: {
  name: string; sets: number; reps: number; volumeKg: number; bestKg: number; unit: LoadUnit; last?: boolean;
}) {
  const { large } = useTextScale();
  const values = [plural(sets, 'set', 'sets'), plural(reps, 'rep', 'reps')];
  if (volumeKg > 0) values.push(`${loadLabel(volumeKg, unit)} volume`);
  if (bestKg > 0) values.push(`best ${loadLabel(bestKg, unit)}`);
  return (
    <View accessible accessibilityLabel={`${name}, ${values.join(', ')}`} style={[s.statRow, last && s.last]}>
      <Txt role="bodyStrong">{name}</Txt>
      {large ? values.map((v) => <Txt key={v} role="meta" tone="secondary">{v}</Txt>) : <MetaLine items={values} />}
    </View>
  );
}

/* ---------------- HistoryRow (real data) ---------------- */

export function SessionRow({ session, meta, onPress, last }: {
  session: WorkoutSession; meta: readonly string[]; onPress: () => void; last?: boolean;
}) {
  return (
    <Pressable testID={`a-history-${session.id}`} accessibilityRole="button" onPress={onPress}
      accessibilityLabel={`${session.planSnapshot.name}, ${meta.join(', ')}`}
      style={({ pressed }) => [s.hrow, last && s.last, pressed && s.pressed]}>
      <View style={s.hText}>
        <Txt role="bodyStrong">{session.planSnapshot.name}</Txt>
        <MetaLine items={meta} />
      </View>
      <View style={s.chev}><Icon name="chevron-right" size={L.icon.inline} color={t.color.secondary} /></View>
    </Pressable>
  );
}

/* ---------------- WeeklyChart (real data, Advanced) ---------------- */

export function WeekBars({ weeks }: { weeks: readonly { start: Date; count: number }[] }) {
  const { large } = useTextScale();
  const summary = `Workouts finished per week. ${weeks.map((w) => `Week of ${weekLabel(w.start)}: ${w.count}`).join(', ')}.`;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={summary} style={[s.chart, large && s.chartAuto]}>
      {weeks.map((w) => (
        <View key={w.start.toISOString()} style={s.col}>
          <Txt role="bodyStrong" style={[tabular, s.chartValue]}>{String(w.count)}</Txt>
          <View style={s.barWrap}>
            <View style={s.barStack}>
              {Array.from({ length: w.count }, (_, k) => <View key={k} style={s.unit} />)}
            </View>
          </View>
          <Txt role="caption" tone="secondary" style={s.chartLabel}>{weekLabel(w.start)}</Txt>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  pressed: { backgroundColor: t.color.selection },
  struck: { textDecorationLine: 'line-through' },
  last: { borderBottomWidth: 0 },
  setRow: {
    flexDirection: 'row', alignItems: 'center', gap: t.space.s12, minHeight: L.setLog.minHeight,
    paddingVertical: L.setLog.paddingY, borderBottomWidth: t.stroke.divider, borderBottomColor: t.color.line,
  },
  state: { flexDirection: 'row', alignItems: 'center', gap: t.space.s4, minHeight: L.setLog.statusTarget },
  stateCol: { alignItems: 'flex-end' },
  tRow: {
    flexDirection: 'row', alignItems: 'center', gap: L.targetTable.columnGap, minHeight: L.targetTable.rowMinHeight,
    paddingHorizontal: t.space.s8, borderRadius: t.radius.small,
  },
  tRowLarge: { paddingVertical: t.space.s8 },
  tHead: { minHeight: L.frame.minimumTarget },
  tSet: { width: L.targetTable.setColumn },
  tCurrent: { backgroundColor: t.color.selection },
  tCard: { flex: 1, gap: t.space.s4 },
  statRow: {
    gap: t.space.s4, paddingVertical: t.space.s12, borderBottomWidth: t.stroke.divider, borderBottomColor: t.color.line,
  },
  hrow: {
    flexDirection: 'row', alignItems: 'center', gap: t.space.s12, minHeight: L.historyRow.minHeight,
    paddingVertical: L.historyRow.paddingY, borderBottomWidth: t.stroke.divider, borderBottomColor: t.color.line,
  },
  hText: { flex: 1, gap: L.historyRow.titleDetailGap },
  chev: { width: L.historyRow.chevronTarget, height: L.historyRow.chevronTarget, alignItems: 'center', justifyContent: 'center' },
  chart: { height: L.chart.height, flexDirection: 'row', alignItems: 'flex-end', gap: L.chart.columnGap },
  chartAuto: { height: 'auto' },
  col: { flex: 1, alignItems: 'center', minWidth: L.chart.minTargetWidth },
  chartValue: { marginBottom: L.chart.valueGap },
  barWrap: {
    alignSelf: 'stretch', alignItems: 'center', borderBottomWidth: L.chart.baselineWidth, borderBottomColor: t.color.controlBorder,
  },
  barStack: { width: L.chart.barWidth, gap: L.chart.unitGap },
  unit: { height: L.chart.unitHeight, backgroundColor: t.color.chart, borderRadius: t.radius.chartUnit, borderCurve: 'continuous' },
  chartLabel: { marginTop: L.chart.labelGap },
});
