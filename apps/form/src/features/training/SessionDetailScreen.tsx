// Read-only session detail (settings-training v2 DESIGN #training, flow.md, contracts.md#mode-matrix). Server data only; no sample numbers.
import { StyleSheet, View } from 'react-native';
import type { AppMode, Exercise, Preferences, WorkoutSession } from '../../api/domain';
import { LoadingSkeleton } from '../../variants/a/components';
import { t } from '../shared/tokens';
import { AccountRow, Gutter, MetaLine, Nav, PrimaryAction, Screen, Section, Title, Txt } from '../shared/ui';
import { TC } from './copy';
import { ErrorNotice } from './ErrorNotice';
import { loadLabel, orderedOccurrences, plural, sessionDate, sessionMinutes, sessionTotals, setsOf, type Remote } from './model';
import { rowStatus, TargetTable } from './parts';

type LoadUnit = Preferences['loadUnit'];

/* ---------------- Session detail (read-only) ---------------- */

export function SessionDetailScreen({ appMode, session, exercises, loadUnit, backLabel, onBack, onResume, onRetry }: {
  appMode: AppMode; session: Remote<WorkoutSession>; exercises: Record<string, Exercise>; loadUnit: LoadUnit; backLabel: string;
  onBack: () => void; onResume: (session: WorkoutSession) => void; onRetry: () => void;
}) {
  const nav = <Nav back={backLabel} onBack={onBack} />;
  if (session.status !== 'ready') {
    return (
      <Screen testID="screen-session" nav={nav}>
        <Section>{session.status === 'loading' ? <LoadingSkeleton /> : <ErrorNotice remote={session} onRetry={onRetry} />}</Section>
      </Screen>
    );
  }
  const x = session.value;
  const minutes = sessionMinutes(x);
  const totals = sessionTotals(x);
  return (
    <Screen testID="screen-session" nav={nav}>
      <Gutter>
        <Title text={x.planSnapshot.name} testID="a-session-title" />
        <MetaLine items={[sessionDate(x.startedAt), ...(minutes ? [`${minutes} min`] : []), x.status === 'completed' ? 'Completed' : TC.notFinished]} />
      </Gutter>
      {x.status === 'active' ? (
        <Section tight><PrimaryAction label="Resume workout" captureId="a-session-resume" onPress={() => onResume(x)} /></Section>
      ) : null}
      <Section>
        {orderedOccurrences(x).map((o, i, list) => {
          const sets = setsOf(x, o.id);
          const confirmed = sets.filter((y) => y.status === 'confirmed').length;
          const name = exercises[o.exerciseId]?.name ?? 'Movement';
          if (appMode !== 'advanced') {
            return <AccountRow key={o.id} label={name} value={plural(confirmed, 'set logged', 'sets logged')} last={i === list.length - 1} />;
          }
          return (
            <View key={o.id} style={s.movement}>
              <Txt role="bodyStrong">{name}</Txt>
              <TargetTable target={o.target} unit={loadUnit}
                rows={sets.map((set) => ({ n: set.setNumber, set, status: rowStatus(set, null, false), current: false }))} />
            </View>
          );
        })}
      </Section>
      {appMode === 'advanced' ? (
        <Section tight>
          <MetaLine items={[plural(totals.confirmedSets, 'confirmed set', 'confirmed sets'), plural(totals.repetitions, 'rep', 'reps'),
            ...(totals.volumeKg > 0 ? [`${loadLabel(totals.volumeKg, loadUnit)} volume`] : [])]} />
        </Section>
      ) : null}
    </Screen>
  );
}

const s = StyleSheet.create({
  movement: { gap: t.space.s8, paddingVertical: t.space.s12 },
});
