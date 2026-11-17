import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { AccountRow, Gutter, Nav, Notice, PlainAction, PrimaryAction, RowGroup, Screen, Subtitle, TextAnswer, Title, Txt } from '../../features/shared/ui';
import { t } from '../../features/shared/tokens';
import type { ActivityEntry, ActivityItemInput } from '../contracts';
import type { ActivityDraft, DraftItem, DraftLoad } from '../drafts/model';
import { loadText } from '../screens/model';
import { parseCivilDate, validTimeZone } from '../drafts/dates';
import { sameValue } from './draftEditing';
import { failureText, pendingChannels, type ActivityActions, type ActivitySnapshot } from './presentation';

export function ActivityAction({ label, onPress, reason, busy, secondary, id }: {
  label: string; onPress: () => void; reason?: string | null; busy?: boolean; secondary?: boolean; id?: string;
}) {
  const disabled = !!reason || !!busy;
  return <View accessible={disabled} accessibilityLabel={disabled ? label : undefined}
    accessibilityHint={disabled ? reason ?? 'Wait for the current request.' : undefined}
    accessibilityState={{ disabled, busy: !!busy }} style={{ gap: t.space.s4 }}>
    {secondary ? <PlainAction label={label} captureId={id} disabled={disabled} onPress={() => { if (!disabled) onPress(); }} chevron={null} />
      : <PrimaryAction label={label} captureId={id} disabled={disabled} loading={busy} onPress={() => { if (!disabled) onPress(); }} />}
    {reason ? <Txt role="meta" tone="secondary">{reason}</Txt> : null}
  </View>;
}
export function ActivityFrame({ title, back, onBack, children }: { title: string; back?: string; onBack?: () => void; children: ReactNode }) {
  return <Screen testID="screen-activity" nav={<Nav back={back} onBack={onBack} />}>
    <Gutter style={{ gap: t.space.s16 }}><Title text={title} />{children}</Gutter>
  </Screen>;
}
export function ActivityStatus({ snapshot, actions }: { snapshot: ActivitySnapshot; actions: ActivityActions }) {
  const state = snapshot.consumer;
  if (!snapshot.available || !state) return <Notice announce kind="warning" text={snapshot.notice ?? 'The account session changed. This Activity view is unavailable.'} />;
  const channels = pendingChannels(state);
  return <>
    {snapshot.notice ? <Notice announce kind={snapshot.integrityUnavailable || snapshot.custodyUnavailable ? 'warning' : 'info'} text={snapshot.notice} /> : null}
    {snapshot.busy && channels.length === 0 ? <Notice announce kind="info" text="Waiting for the current Activity operation. Navigation is temporarily unavailable." /> : null}
    {(state.draft.phase === 'saved' || state.voidIntent.phase === 'voided') && snapshot.receipt && snapshot.route !== 'detail' && !snapshot.integrityUnavailable
      ? <ActivityAction label="Show saved server receipt" busy={snapshot.busy} onPress={() => { void actions.showReceipt(); }} /> : null}
    {channels.map(channel => {
      const phase = channel === 'entry' ? state.draft.phase : channel === 'void' ? state.voidIntent.phase
        : channel === 'calendar' ? state.calendarIntent.phase : channel === 'schedule' ? state.scheduleIntent.phase
          : channel === 'personal-create' ? state.personalCreateIntent.phase : state.personalChangeIntent.phase;
      return <View key={channel} style={{ gap: t.space.s8 }}>
        <Notice announce kind="warning" text={phase === 'saving' ? `Waiting for the ${channel} request. Navigation and new intents are unavailable.`
          : `The ${channel} outcome is unknown. Only the retained original intent may be retried while its controller survives. Backgrounding, disposal or restart can lose this recovery.`} />
        {phase === 'unknown' && !snapshot.integrityUnavailable && !snapshot.custodyUnavailable
          ? <ActivityAction label={`Retry original ${channel} request`} onPress={() => { void actions.retry(channel); }}
            busy={snapshot.busy} reason={channels.length !== 1 ? 'Multiple unresolved command channels need their owning flow.' : null} /> : null}
      </View>;
    })}
    {state.draft.phase === 'rejected' || state.draft.phase === 'stale'
      ? <Notice announce kind="warning" text={failureText(state.draft.error?.code)} /> : null}
    {state.draft.phase === 'unknown' && state.draft.error?.code === 'activity_persistability_unavailable'
      ? <Notice kind="warning" text={failureText(state.draft.error.code)} /> : null}
    {(state.draft.phase === 'stale' && state.draft.editTarget !== null) || state.voidIntent.phase === 'stale'
      ? <ActivityAction secondary label="Load fresh review" onPress={() => { void actions.freshReview(); }} /> : null}
    {state.draft.phase === 'stale' && state.draft.editTarget === null
      ? <Notice kind="warning" text="This create intent was rejected as conflicting. No entry-target or receipt-lookup interface is available for a fresh review here. Do not replace it with a manual resend." /> : null}
  </>;
}
export function draftLoadText(load: DraftLoad): string {
  if (load.state === 'missing') return 'Missing — choose a load disposition before saving';
  const text = loadText(load) ?? '';
  if (load.state === 'knownValue') return `${text}; reported value ${load.value} ${load.unit}; basis: ${load.basis}`;
  if (load.state === 'notApplicable') return `${text}; not applicable: ${load.reason}`;
  return `${text}; explicitly confirmed unknown`;
}
function Metrics({ item }: { item: Pick<ActivityItemInput, 'durationSeconds' | 'distance' | 'pace' | 'speed'> }) {
  return <>
    {item.durationSeconds !== undefined ? <Txt role="body">{`Duration: ${item.durationSeconds} seconds`}</Txt> : null}
    {item.distance ? <Txt role="body">{`Distance: ${item.distance.value} ${item.distance.unit}`}</Txt> : null}
    {item.pace ? <Txt role="body">{`Pace: ${item.pace.secondsPerUnit} seconds per ${item.pace.unit}`}</Txt> : null}
    {item.speed ? <Txt role="body">{`Speed: ${item.speed.value} ${item.speed.unit}`}</Txt> : null}
  </>;
}
export function ActivityValues({ value }: { value: ActivityDraft | ActivityEntry }) {
  return <>
    <RowGroup heading="Date and capture provenance">
      <AccountRow label="Activity date" value={value.date?.localDate ?? 'Unresolved'} />
      <AccountRow label="Activity zone" value={value.date?.timeZone ?? 'Unavailable'} />
      <AccountRow label="Date source" value={value.date?.source ?? 'Unresolved'} />
      <AccountRow label="Captured at" value={value.date?.capturedAt ?? 'Unavailable'} />
      <AccountRow label="Frozen reference date" value={value.date?.referenceLocalDate ?? 'Unavailable'} last />
    </RowGroup>
    <Txt role="body">{`Kind: ${value.kind}; source: ${value.source}; draft: ${value.draftId}`}</Txt>
    <Txt role="meta" tone="secondary">Capture provenance is device-observed context, not authoritative subject-today evidence.</Txt>
    {value.items.map((raw, index) => {
      const draft = 'state' in raw.exercise;
      const item = raw as DraftItem;
      const snapshot = 'snapshot' in raw ? raw.snapshot : item.exercise.state === 'selected' ? item.exercise.snapshot : null;
      const ref = draft ? item.exercise.state === 'selected' ? item.exercise.ref : null : (raw as ActivityItemInput).exercise;
      return <View key={raw.id} style={{ gap: t.space.s8 }}>
        <Subtitle text={`${index + 1}. ${snapshot?.name ?? (item.exercise.state !== 'selected' ? item.exercise.mention : 'Unresolved exercise')}`} />
        <Txt role="meta">{`Item: ${raw.id}; exercise: ${ref ? `${ref.source}/${ref.id}${ref.source === 'personal' ? ` revision ${ref.revision}` : ''}` : 'unresolved'}`}</Txt>
        {snapshot ? <>
          <Txt role="body">{snapshot.description || 'No description reported'}</Txt>
          <Txt role="meta">{`Movement: ${snapshot.movement ?? 'unspecified'}; measurement: ${snapshot.measurementType}; kind: ${snapshot.kind}; load applicability: ${snapshot.loadApplicability}; load label: ${snapshot.loadLabel ?? 'none'}`}</Txt>
          <Txt role="meta">{`Guidance: ${snapshot.guidance}; cues: ${snapshot.cueStatus}; safety assessment: ${snapshot.safetyAssessment}`}</Txt>
        </> : null}
        <Txt role="body">{`Load: ${draftLoadText(raw.load)}`}</Txt>
        {raw.reportedSetCount !== undefined ? <Txt role="body">{`Reported set count: ${raw.reportedSetCount}`}</Txt> : null}
        {(raw.sets ?? []).map((set, setIndex) => <View key={set.id}>
          <Txt role="body">{`Set ${setIndex + 1} (${set.id}): ${draftLoadText(set.load)}`}</Txt>
          {set.repetitions !== undefined ? <Txt role="body">{`Repetitions: ${set.repetitions}`}</Txt> : null}
          {set.durationSeconds !== undefined ? <Txt role="body">{`Set duration: ${set.durationSeconds} seconds`}</Txt> : null}
        </View>)}
        <Metrics item={raw} />
        {raw.splitCoverage ? <Txt role="body">{`Split coverage: ${raw.splitCoverage}`}</Txt> : null}
        {(raw.splits ?? []).map(split => <View key={split.id}>
          <Txt role="body">{`Split ${split.sequence} (${split.id})`}</Txt><Metrics item={split} />
        </View>)}
      </View>;
    })}
    {'acknowledgedIssues' in value ? value.acknowledgedIssues.map((issue, index) => <Txt role="body" key={index}>{`Acknowledged: ${issue.fieldPath} — ${issue.code}`}</Txt>) : null}
  </>;
}
export function ActivityList({ snapshot, actions }: { snapshot: ActivitySnapshot; actions: ActivityActions }) {
  const [date, setDate] = useState(snapshot.selectedDate);
  const state = snapshot.consumer!;
  const calendar = state.calendar;
  const calendarReady = calendar.status === 'ready' && calendar.value !== null;
  const reason = !calendarReady ? 'Load and explicitly configure the Activity calendar first.' : null;
  return <>
    <Subtitle text="Record performed activity using the fixed Activity calendar zone. Choose an explicit civil date to backdate." />
    {calendar.status === 'ready' ? calendar.value === null
      ? <Notice kind="info" text="The server reports no Activity calendar. Review a zone before creating one." action={{ label: 'Set up Activity calendar', onPress: () => { void actions.setupCalendar(); } }} />
      : <Txt role="body">{`Fixed calendar: ${calendar.value.timeZone}; activated ${calendar.value.activationDate}; revision ${calendar.value.revision}`}</Txt>
      : <Notice kind="warning" text={calendar.status === 'loading' ? 'Loading Activity calendar.' : 'Activity calendar has not been established. A read failure does not mean setup is missing.'}
        action={calendar.status === 'loading' ? null : { label: 'Load Activity calendar', onPress: () => { void actions.reloadCalendar(); } }} />}
    <TextAnswer label="Civil date (YYYY-MM-DD)" value={date} onChangeText={setDate} testID="activity-list-date" autoCapitalize="none" />
    <ActivityAction secondary label="Load date" reason={!parseCivilDate(date) ? 'Enter a civil date in YYYY-MM-DD form.' : null} onPress={() => { void actions.loadDay(date); }} busy={snapshot.listStatus === 'loading'} />
    <ActivityAction label="Log activity" reason={reason ?? (date !== snapshot.selectedDate ? 'Load the entered civil date before logging.' : null)} onPress={() => { void actions.beginManual(); }} id="activity-log" />
    <ActivityAction secondary label="Use existing speech input" reason={reason ?? (date !== snapshot.selectedDate ? 'Load the entered date first.' : null)} onPress={() => { void actions.beginSpeech(); }} />
    <RowGroup heading={`Entries${snapshot.selectedDate ? ` for ${snapshot.selectedDate}` : ''}`}>
      {snapshot.rows.map(entry => <AccountRow key={entry.id} label={`${entry.date.localDate} · ${entry.kind === 'workout' ? 'Workout' : 'Exercise snack'}`}
        detail={`${entry.items.map(item => item.snapshot.name).join(', ')} · ${entry.status} · revision ${entry.revision}`}
        testID={`activity-entry-${entry.id}`} onPress={() => { void actions.openEntry(entry.id); }} />)}
    </RowGroup>
    {snapshot.listStatus === 'idle' ? <Txt role="body">Choose and load a civil date to read entries.</Txt> : null}
    {snapshot.listStatus === 'loading' ? <Notice kind="info" text="Loading dated entries." /> : null}
    {snapshot.listStatus === 'ready' && !snapshot.rows.length ? <Txt role="body">No entries were returned for this date.</Txt> : null}
    {snapshot.listError ? <Notice announce kind="warning" text={snapshot.listError} /> : null}
    {snapshot.nextCursor ? <ActivityAction secondary label="Load more entries" busy={snapshot.more} onPress={() => { void actions.loadMore(); }} /> : null}
    <Subtitle text="Adherence" />
    {state.adherence.status === 'ready' ? <>
      <Txt role="body">{`As of ${state.adherence.value.asOf}, zone ${state.adherence.value.timeZone}; through ${state.adherence.value.throughDate}`}</Txt>
      <Txt role="body">{`Coverage starts: ${state.adherence.value.coverageStart ?? 'unknown'}; current plan days: ${state.adherence.value.currentPlanDays}; longest: ${state.adherence.value.longestPlanDays}`}</Txt>
      <Txt role="body">{`Satisfied: ${state.adherence.value.satisfiedDaysInCurrentStreak}; protected: ${state.adherence.value.protectedDaysInCurrentStreak}; allowance ${state.adherence.value.monthlyAllowance.month}: ${state.adherence.value.monthlyAllowance.remaining} remaining; protected date ${state.adherence.value.monthlyAllowance.protectedDate ?? 'none reported'}`}</Txt>
      <Txt role="meta">{`Source activity generation ${state.adherence.value.sourceGeneration.activity}; projection ${state.adherence.value.sourceGeneration.projectionRevision}; legacy coverage ${state.adherence.value.sourceGeneration.legacyAvailable ? 'bound, unverified' : 'unavailable'}`}</Txt>
      {state.adherence.value.days.map(day => <Txt role="body" key={day.localDate}>{`${day.localDate}: ${day.state}; actual ${day.actual}; ${day.timeZone}; revision ${day.revision}${day.state === 'unknownPlan' ? ' — plan coverage is unknown' : ''}`}</Txt>)}
    </> : <Notice kind="info" text={state.adherence.status === 'loading' ? 'Loading adherence independently.' : 'Adherence is unavailable or has not been read. Entry rows do not establish adherence.'} />}
    <ActivityAction secondary label="Refresh adherence" reason={!snapshot.selectedDate ? 'Load a date first.' : null} onPress={() => { void actions.reloadAdherence(); }} />
  </>;
}
export function ActivityCalendarScreen({ snapshot, actions }: { snapshot: ActivitySnapshot; actions: ActivityActions }) {
  const [zone, setZone] = useState(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; } catch { return ''; } });
  const intent = snapshot.consumer!.calendarIntent;
  const calendar = snapshot.consumer!.calendar;
  const [reviewed, setReviewed] = useState<string | null>(null);
  return <>
    {intent.phase === 'configured' ? <>
      <Notice announce kind="success" text={`The server confirmed the Activity calendar in ${intent.calendar.timeZone}.`} />
      <ActivityAction label="Return to Activity" onPress={() => { void actions.calendarDone(); }} />
    </> : null}
    <Subtitle text="This zone is fixed for the Activity calendar. The device zone below is only a starting value to review; it is never saved automatically." />
    <TextAnswer label="IANA time zone" value={zone} onChangeText={value => { setZone(value); setReviewed(null); void actions.invalidateCalendarReview(); }} autoCapitalize="none" testID="activity-calendar-zone" />
    {calendar.status !== 'ready' ? <Notice kind="warning" text="Read the calendar before reviewing setup. A failed read does not establish a missing calendar."
      action={{ label: 'Read calendar', onPress: () => { void actions.reloadCalendar(); } }} /> : null}
    <ActivityAction secondary label="Review calendar zone" reason={calendar.status !== 'ready' || calendar.value !== null ? 'Setup requires a successful server read reporting no calendar.' : !validTimeZone(zone) ? 'Enter a valid IANA time zone.' : null}
      onPress={() => { setReviewed(zone); void actions.reviewCalendar(zone); }} />
    {intent.phase === 'review' && reviewed === zone && intent.timeZone === zone ? <>
      <Notice kind="info" text={`Create the fixed Activity calendar in ${intent.timeZone}. Its activation date will come from the server.`} />
      <ActivityAction label="Confirm Activity calendar" onPress={() => { void actions.confirmCalendar(); }} />
    </> : null}
    {intent.phase === 'rejected' ? <Notice announce kind="warning" text={failureText(intent.error.code)} /> : null}
  </>;
}
export function ActivityDetail({ snapshot, actions }: { snapshot: ActivitySnapshot; actions: ActivityActions }) {
  const entry = snapshot.detail.status === 'ready' ? snapshot.detail.value : snapshot.receipt;
  return <>
    {snapshot.receipt ? <Notice announce kind="success" text={snapshot.receipt.status === 'voided'
      ? `Server receipt: entry ${snapshot.receipt.id} voided at revision ${snapshot.receipt.revision}. History is retained.`
      : `Saved: entry ${snapshot.receipt.id}, revision ${snapshot.receipt.revision}.`} /> : null}
    {snapshot.detail.status === 'loading' ? <Notice kind="info" text="Reading server entry detail." /> : null}
    {snapshot.detail.status === 'unavailable' && !snapshot.notice ? <Notice kind="warning" text="Entry detail unavailable." /> : null}
    {entry ? <>
      {snapshot.receipt && snapshot.detail.status === 'ready' && !sameValue(snapshot.receipt, snapshot.detail.value) ? <>
        <Subtitle text="Saved server receipt" /><ActivityValues value={snapshot.receipt} /><Subtitle text="Fresh server entry detail" />
      </> : null}
      <Txt role="body">{`Entry ${entry.id}; revision ${entry.revision}; status ${entry.status}`}</Txt>
      <Txt role="meta">{`Created ${entry.createdAt}; updated ${entry.updatedAt}`}</Txt>
      <ActivityValues value={entry} />
      {entry.status === 'recorded' ? <>
        <ActivityAction secondary label="Correct activity" busy={snapshot.busy} reason={snapshot.busy ? 'Wait for the current entry read.' : null} onPress={() => { void actions.correction(); }} />
        <ActivityAction secondary label="Review void" busy={snapshot.busy} reason={snapshot.busy ? 'Wait for the current entry read.' : null} onPress={() => { void actions.beginVoid(); }} />
      </> : <Notice kind="info" text="This entry is voided. It no longer counts as active activity; history is retained. This is not exercise retirement or erasure." />}
    </> : null}
    <ActivityAction secondary label="Read entry again" busy={snapshot.busy} reason={!entry ? 'Return to the dated list and choose an entry.' : snapshot.busy ? 'Wait for the current entry read.' : null} onPress={() => { void actions.refreshDetail(); }} />
  </>;
}
export function ActivityVoidReview({ snapshot, actions }: { snapshot: ActivitySnapshot; actions: ActivityActions }) {
  const intent = snapshot.consumer!.voidIntent;
  return <>
    <Notice kind="warning" text="Void removes this entry from active activity and adherence while retaining history. It does not erase data, retire an exercise or undo another change." />
    {intent.phase === 'review' ? <>
      <Txt role="body">{`Freshly read entry ${intent.entry.id}, revision ${intent.entry.revision}`}</Txt>
      <ActivityValues value={intent.entry} />
      <ActivityAction label="Confirm void activity" onPress={() => { void actions.confirmVoid(); }} id="activity-confirm-void" />
    </> : null}
    {intent.phase === 'rejected' ? <Notice kind="warning" text={failureText(intent.error.code)} /> : null}
  </>;
}
export function ActivitySpeech({ snapshot, actions }: { snapshot: ActivitySnapshot; actions: ActivityActions }) {
  const draft = snapshot.consumer!.draft;
  const [text, setText] = useState<string | null>(null);
  return <>
    <Notice kind="info" text="Speech uses the existing configured Activity input. Review the final transcript, then review editable structured values. Accepting a transcript does not save activity." />
    {draft.phase === 'capture' ? <>
      <Txt role="body">{draft.transcript || 'Waiting for speech.'}</Txt>
      <ActivityAction label="Stop speech" onPress={() => { void actions.stopSpeech(); }} />
    </> : null}
    {draft.phase === 'transcriptReview' ? <>
      <Transcript key={draft.sessionId} initial={draft.transcript} onChange={setText} />
      <ActivityAction label="Accept reviewed transcript" onPress={() => { void actions.acceptTranscript(text ?? draft.transcript); }} />
    </> : null}
  </>;
}
function Transcript({ initial, onChange }: { initial: string; onChange: (text: string) => void }) {
  const [text, setText] = useState(initial);
  return <TextAnswer label="Final transcript to review" value={text} multiline onChangeText={value => { setText(value); onChange(value); }} testID="activity-transcript" />;
}
