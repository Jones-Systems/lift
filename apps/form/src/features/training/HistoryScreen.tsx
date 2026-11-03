// History and its shared row metadata (settings-training v2 DESIGN #training, flow.md, contracts.md#mode-matrix). Server data only; no sample numbers.
import type { AppMode, History, Preferences, WorkoutSession } from '../../api/domain';
import { EmptyBlock, LoadingSkeleton } from '../../variants/a/components';
import { Gutter, Nav, Notice, PlainAction, Screen, Section, Spinner, Title, Txt } from '../shared/ui';
import { TC } from './copy';
import { ErrorNotice } from './ErrorNotice';
import { loadLabel, plural, sessionDate, sessionTotals, type Remote, type ServerError } from './model';
import { SessionRow } from './parts';

type LoadUnit = Preferences['loadUnit'];

export function historyMeta(x: WorkoutSession, appMode: AppMode, unit: LoadUnit): string[] {
  const totals = sessionTotals(x);
  const items = [sessionDate(x.startedAt), plural(totals.confirmedSets, 'set logged', 'sets logged')];
  if (x.status === 'active') items.unshift('In progress');
  if (appMode === 'advanced') {
    items.push(plural(x.occurrences.length, 'movement', 'movements'));
    if (totals.volumeKg > 0) items.push(loadLabel(totals.volumeKg, unit)); // never "0 kg" for bodyweight sessions
  }
  return items;
}

/* ---------------- History ---------------- */

export function HistoryScreen({ appMode, pages, more, loadUnit, onBack, onOpen, onLoadMore, onRefresh, onStartWorkout }: {
  appMode: AppMode; pages: Remote<History>; more: { state: 'idle' | 'loading'; error: ServerError | null };
  loadUnit: LoadUnit; onBack: () => void; onOpen: (id: string) => void; onLoadMore: () => void; onRefresh: () => void; onStartWorkout: () => void;
}) {
  const nav = <Nav back="Progress" onBack={onBack} />;
  return (
    <Screen testID="screen-history" nav={nav}>
      <Gutter><Title text="History" testID="a-history-title" /></Gutter>
      <Section>
        <ErrorNotice remote={pages} onRetry={onRefresh} />
        {pages.status === 'loading' ? <LoadingSkeleton /> : null}
        {pages.status === 'ready' && pages.value.items.length === 0 ? (
          <EmptyBlock title={TC.statsEmptyTitle} body={TC.statsEmptyBody} action={TC.statsEmptyAction} onAction={onStartWorkout} />
        ) : null}
        {pages.status === 'ready' ? pages.value.items.map((x, i, list) => (
          <SessionRow key={x.id} session={x} meta={historyMeta(x, appMode, loadUnit)} onPress={() => onOpen(x.id)} last={i === list.length - 1} />
        )) : null}
        {pages.status === 'ready' && pages.value.items.length ? (
          pages.value.nextBefore === null ? <Txt role="meta" tone="secondary" testID="a-history-end">{TC.historyEnd}</Txt>
            : more.state === 'loading' ? <Spinner />
              : more.error ? <Notice kind="error" text={TC.getUnavailable} action={{ label: TC.tryAgain, onPress: onLoadMore }} />
                : <PlainAction label="Show more" captureId="a-history-more" chevron="chevron-down" onPress={onLoadMore} />
        ) : null}
      </Section>
    </Screen>
  );
}
