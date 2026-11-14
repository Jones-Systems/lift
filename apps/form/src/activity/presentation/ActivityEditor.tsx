import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ChoiceRow, Notice, Subtitle, TextAnswer, Txt } from '../../features/shared/ui';
import { t } from '../../features/shared/tokens';
import type { ActivityItemInput, Distance, Pace, Speed } from '../contracts';
import type { DraftItem, DraftLoad, DraftResult } from '../drafts/model';
import { addItem, addSet, addSplit, changeDate, changeItem, changeLoad, changeSet, changeSplit, editDraft,
  optionalNumber, removeItem, removeSet, removeSplit } from './draftEditing';
import { ActivityAction, draftLoadText } from './ActivityScreens';
import type { ActivityActions, ActivitySnapshot } from './presentation';

export function NumberAnswer({ label, value, onChange, id }: { label: string; value: number | undefined; onChange: (text: string) => void; id?: string }) {
  const format = (number: number | undefined) => number === undefined || !Number.isFinite(number) ? '' : String(number);
  const [text, setText] = useState(() => format(value));
  useEffect(() => { setText(format(value)); }, [value]);
  return <TextAnswer label={label} value={text} onChangeText={next => { setText(next); onChange(next); }}
    keyboardType="decimal-pad" testID={id} error={value !== undefined && !Number.isFinite(value)} />;
}
function Choices<T extends string>({ label, values, value, onChange }: { label: string; values: readonly T[]; value?: T; onChange: (value: T) => void }) {
  return <View><Txt role="meta">{label}</Txt>{values.map(option => <ChoiceRow key={option} title={option}
    selected={value === option} onPress={() => onChange(option)} />)}</View>;
}
function LoadEditor({ value, onChange, label }: { value: DraftLoad; onChange: (load: DraftLoad) => void; label: string }) {
  return <View style={{ gap: t.space.s8 }}>
    <Txt role="bodyStrong">{label}</Txt><Txt role="body">{draftLoadText(value)}</Txt>
    <ChoiceRow title="Load missing — still to review" selected={value.state === 'missing'} onPress={() => onChange({ state: 'missing' })} />
    <ChoiceRow title="I confirm the load is unknown" selected={value.state === 'unknown'} onPress={() => onChange({ state: 'unknown', confirmed: true })} />
    {(['bodyweight', 'unloaded', 'timedActivity'] as const).map(reason => <ChoiceRow key={reason}
      title={`Load not applicable: ${reason}`} selected={value.state === 'notApplicable' && value.reason === reason}
      onPress={() => onChange({ state: 'notApplicable', reason })} />)}
    <ChoiceRow title="Enter a known load, including zero" selected={value.state === 'knownValue'}
      onPress={() => { if (value.state !== 'knownValue') onChange({ state: 'knownValue', value: NaN, unit: 'kg', basis: 'unspecified' }); }} />
    {value.state === 'knownValue' ? <>
      <NumberAnswer label={`${label} value`} value={value.value} onChange={text => onChange({ ...value, value: text.trim() ? Number(text) : NaN })} />
      <Choices<'kg' | 'lb'> label="Load unit" values={['kg', 'lb']} value={value.unit} onChange={unit => onChange({ ...value, unit })} />
      <Choices<'total' | 'perImplement' | 'perSide' | 'assistance' | 'unspecified'> label="Load basis" values={['total', 'perImplement', 'perSide', 'assistance', 'unspecified']} value={value.basis}
        onChange={basis => onChange({ ...value, basis })} />
    </> : null}
  </View>;
}
type Metrics = Pick<ActivityItemInput, 'durationSeconds' | 'distance' | 'pace' | 'speed'>;
function MetricsEditor({ value, onChange, duration = true, label }: { value: Metrics; onChange: (value: Metrics) => void; duration?: boolean; label: string }) {
  const metric = <K extends 'distance' | 'pace' | 'speed'>(key: K, next: Metrics[K]) => {
    const result = { ...value };
    if (next === undefined) delete result[key]; else result[key] = next;
    onChange(result);
  };
  return <View style={{ gap: t.space.s8 }}>
    {duration ? <NumberAnswer label={`${label} duration (seconds)`} value={value.durationSeconds}
      onChange={text => onChange(optionalNumber(value, 'durationSeconds', text))} /> : null}
    <NumberAnswer label={`${label} distance`} value={value.distance?.value} onChange={text => metric('distance', text.trim()
      ? { value: Number(text), unit: value.distance?.unit ?? 'km' } : undefined)} />
    <Choices<Distance['unit']> label="Distance unit" values={['m', 'km', 'mi']} value={value.distance?.unit ?? 'km'}
      onChange={unit => metric('distance', { value: value.distance?.value ?? NaN, unit })} />
    <NumberAnswer label={`${label} pace (seconds per unit)`} value={value.pace?.secondsPerUnit} onChange={text => metric('pace', text.trim()
      ? { secondsPerUnit: Number(text), unit: value.pace?.unit ?? 'km' } : undefined)} />
    <Choices<Pace['unit']> label="Pace unit" values={['km', 'mi']} value={value.pace?.unit ?? 'km'}
      onChange={unit => metric('pace', { secondsPerUnit: value.pace?.secondsPerUnit ?? NaN, unit })} />
    <NumberAnswer label={`${label} speed`} value={value.speed?.value} onChange={text => metric('speed', text.trim()
      ? { value: Number(text), unit: value.speed?.unit ?? 'km/h' } : undefined)} />
    <Choices<Speed['unit']> label="Speed unit" values={['m/s', 'km/h', 'mi/h']} value={value.speed?.unit ?? 'km/h'}
      onChange={unit => metric('speed', { value: value.speed?.value ?? NaN, unit })} />
  </View>;
}
function replaceMetrics<T extends Metrics>(item: T, metrics: Metrics): T {
  const next = { ...item }; delete next.durationSeconds; delete next.distance; delete next.pace; delete next.speed;
  return { ...next, ...metrics };
}
function metricsOf(item: Metrics): Metrics {
  return { ...(item.durationSeconds !== undefined ? { durationSeconds: item.durationSeconds } : {}),
    ...(item.distance ? { distance: item.distance } : {}), ...(item.pace ? { pace: item.pace } : {}), ...(item.speed ? { speed: item.speed } : {}) };
}
function ItemEditor({ item, index, snapshot, actions, advanced }: { item: DraftItem; index: number; snapshot: ActivitySnapshot; actions: ActivityActions; advanced: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const populated = item.reportedSetCount !== undefined || !!item.sets?.length || !!item.splits?.length
    || item.durationSeconds !== undefined || !!item.distance || !!item.pace || !!item.speed;
  const catalog = snapshot.consumer!.catalog;
  const run = item.exercise.state === 'selected' && item.exercise.snapshot.kind === 'run';
  const edit = (change: (result: DraftResult) => DraftResult) => { void actions.edit(change); };
  return <View style={{ gap: t.space.s16 }}>
    <Subtitle text={`Exercise ${index + 1}`} />
    <Txt role="body">{item.exercise.state === 'selected' ? item.exercise.snapshot.name : `Unresolved exercise: ${item.exercise.mention}`}</Txt>
    {catalog.status === 'ready' ? catalog.value.selectionUses.includes(snapshot.consumer!.draft.result!.candidate.source)
      ? catalog.value.items.map(exercise => <ChoiceRow key={`${exercise.ref.source}-${exercise.ref.id}-${exercise.ref.source === 'personal' ? exercise.ref.revision : ''}`}
        title={exercise.name} detail={`${exercise.ref.source}; ${exercise.guidance}; safety assessment not established`}
        selected={item.exercise.state === 'selected' && item.exercise.ref.source === exercise.ref.source && item.exercise.ref.id === exercise.ref.id
          && (item.exercise.ref.source !== 'personal' || (exercise.ref.source === 'personal' && item.exercise.ref.revision === exercise.ref.revision))}
        onPress={() => { void actions.chooseExercise(item.id, exercise.ref); }} />)
      : <Notice kind="warning" text="The catalog does not permit selection for this draft source." />
      : <Notice kind="warning" text={catalog.status === 'loading' ? 'Loading exercise catalog.' : 'Exercise catalog unavailable.'}
        action={catalog.status === 'loading' ? null : { label: 'Read catalog again', onPress: () => { void actions.reloadCatalog(); } }} />}
    <LoadEditor label={`Exercise ${index + 1} load`} value={item.load} onChange={load => edit(result => changeLoad(result, item.id, load))} />
    {run ? <NumberAnswer label={`Exercise ${index + 1} running duration (seconds)`} value={item.durationSeconds}
      onChange={text => edit(result => changeItem(result, item.id, current => optionalNumber(current, 'durationSeconds', text), 'durationSeconds'))} /> : null}
    {!advanced && !populated && !expanded ? <ActivityAction secondary label={`Show optional details for exercise ${index + 1}`} onPress={() => setExpanded(true)} /> : null}
    {advanced || populated || expanded ? <>
      <Notice kind="info" text="A reported set count does not create observed sets or repetitions. Leave optional numbers blank when not reported. Running metrics and splits are entered values, never calculated defaults." />
      <NumberAnswer label={`Exercise ${index + 1} reported set count`} value={item.reportedSetCount}
        onChange={text => edit(result => changeItem(result, item.id, current => optionalNumber(current, 'reportedSetCount', text), 'reportedSetCount'))} />
      {(item.sets ?? []).map((set, setIndex) => <View key={set.id} style={{ gap: t.space.s8 }}>
        <Txt role="bodyStrong">{`Observed set ${setIndex + 1}`}</Txt>
        <NumberAnswer label={`Set ${setIndex + 1} repetitions`} value={set.repetitions}
          onChange={text => edit(result => changeSet(result, item.id, set.id, current => optionalNumber(current, 'repetitions', text)))} />
        <NumberAnswer label={`Set ${setIndex + 1} duration (seconds)`} value={set.durationSeconds}
          onChange={text => edit(result => changeSet(result, item.id, set.id, current => optionalNumber(current, 'durationSeconds', text)))} />
        <LoadEditor label={`Set ${setIndex + 1} load`} value={set.load} onChange={load => edit(result => changeLoad(result, item.id, load, set.id))} />
        <ActivityAction secondary label={`Remove observed set ${setIndex + 1}`} onPress={() => edit(result => removeSet(result, item.id, set.id))} />
      </View>)}
      <ActivityAction secondary label={`Add observed set to exercise ${index + 1}`} onPress={() => { void actions.edit((result, key) => addSet(result, item.id, key)); }} />
      <MetricsEditor label={`Exercise ${index + 1}`} value={metricsOf(item)} duration={!run}
        onChange={metrics => edit(result => changeItem(result, item.id, current => replaceMetrics(current, metrics)))} />
      {(item.splits ?? []).map(split => <View key={split.id} style={{ gap: t.space.s8 }}>
        <Subtitle text={`Incremental split ${split.sequence}`} />
        <MetricsEditor label={`Split ${split.sequence}`} value={metricsOf(split)} onChange={metrics => edit(result => changeSplit(result, item.id, split.id,
          current => ({ ...replaceMetrics(current, metrics), durationSeconds: metrics.durationSeconds ?? NaN })))} />
        <ActivityAction secondary label={`Remove split ${split.sequence}`} onPress={() => edit(result => removeSplit(result, item.id, split.id))} />
      </View>)}
      {item.splits?.length ? <Choices<'partial' | 'complete'> label="Split coverage" values={['partial', 'complete']} value={item.splitCoverage}
        onChange={splitCoverage => edit(result => changeItem(result, item.id, current => ({ ...current, splitCoverage }), 'splitCoverage'))} /> : null}
      <ActivityAction secondary label={`Add split to exercise ${index + 1}`} onPress={() => { void actions.edit((result, key) => addSplit(result, item.id, key)); }} />
    </> : null}
    <ActivityAction secondary label={`Remove exercise ${index + 1}`} onPress={() => edit(result => removeItem(result, item.id))} />
  </View>;
}
export function ActivityEditor({ snapshot, actions, advanced }: { snapshot: ActivitySnapshot; actions: ActivityActions; advanced: boolean }) {
  const result = snapshot.consumer!.draft.result;
  const [date, setDate] = useState(result?.candidate.date?.localDate ?? '');
  if (!result) return <Notice kind="warning" text="No editable Activity draft is available." />;
  if (snapshot.consumer!.draft.phase === 'stale') return <Notice kind="warning" text="This correction is stale. Load a fresh review explicitly; the old revision cannot be saved." />;
  return <>
    <Notice kind="info" text="Draft only. Review all values and explicitly save activity after editing. Confirming a load or selecting an exercise never saves." />
    <Choices<'workout' | 'exerciseSnack'> label="Activity kind" values={['workout', 'exerciseSnack']} value={result.candidate.kind}
      onChange={kind => { void actions.edit(current => editDraft(current, value => ({ ...value, candidate: { ...value.candidate, kind } }), ['kind'])); }} />
    <TextAnswer label="Activity civil date (YYYY-MM-DD)" value={date} testID="activity-draft-date" onChangeText={value => {
      setDate(value);
      void actions.edit(current => editDraft(current, next => ({ ...next, candidate: { ...next.candidate,
        date: next.candidate.date ? { ...next.candidate.date, localDate: value, source: 'selected' } : null } }), ['date']));
    }} />
    <Txt role="body">{`Fixed zone: ${result.context.timeZone}; captured ${result.context.capturedAt}; frozen reference ${result.context.referenceLocalDate}`}</Txt>
    {result.candidate.date?.spokenDates.length ? <Txt role="body">{`Spoken date candidates: ${result.candidate.date.spokenDates.join(', ')}`}</Txt> : null}
    <ActivityAction secondary label="Use entered civil date" onPress={() => { void actions.edit(current => changeDate(current, date)); }} />
    {result.candidate.items.map((item, index) => <ItemEditor key={item.id} item={item} index={index} snapshot={snapshot} actions={actions} advanced={advanced} />)}
    <ActivityAction secondary label="Add exercise" onPress={() => { void actions.edit((current, key) => addItem(current, key)); }} id="activity-add-item" />
    <ActivityAction label="Review activity" onPress={() => { void actions.review(); }} id="activity-review" />
  </>;
}
