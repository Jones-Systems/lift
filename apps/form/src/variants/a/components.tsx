// Open Mat reusable components CMP-A06…A11, A14, A16…A20 (A01–A05, A12, A13, A15 live in
// primitives.tsx / frame.tsx / art.tsx). Product screens and the showcase use these same components.
import { type ReactNode } from 'react';
import { Pressable, StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { CheckMark, Icon, OpenMatArt } from './art';
import { useCapture } from './capture';
import { fixtures } from './generatedfixtures';
import { MetaLine, PlainAction, PrimaryAction, Txt } from './primitives';
import { L, t, tabular, typeStyles, useEssentialOutline, useTextScale } from './theme';

export type Move = (typeof fixtures.moves)[number];
export type Day = (typeof fixtures.days)[number];
export type DayId = Day['id'];
export type PlanVariant = 'full' | 'short';

export const setsOf = (m: Move, variant: PlanVariant) => (variant === 'short' ? m.short : m.full);
export const setWord = (n: number) => `${n} ${n === 1 ? 'set' : 'sets'}`;
/** r3b: a 0 kg suggestion on a bodyweight movement reads "body weight", never "0 kg". */
export const loadText = (kg: number) => (kg === 0 ? 'body weight' : `${kg} kg`);
export const kgLabel = (m: Move, kg: number) => (kg === 0 ? loadText(kg) : `${kg} kg${m.each ? ' each' : ''}`);

/* ---------------- CMP-A06 DayPicker ---------------- */

const KIND_WORD: Record<Day['kind'], string> = { done: 'Recorded', today: 'Today', planned: 'Planned', rest: 'Rest' };
const KIND_SUFFIX: Record<Day['kind'], string> = { done: ', recorded', today: ', planned', planned: ', planned', rest: ', rest day' };

/** Seven-day strip (selected: ink 2 outline + selection, no weight change); a day list at large text. */
export function DayPicker({ selected, onSelect, register = true }: { selected: DayId; onSelect: (id: DayId) => void; register?: boolean }) {
  const { large } = useTextScale();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Days this week" style={large ? s.dayList : s.days}>
      {fixtures.days.map((d) => (
        <DayButton key={d.id} day={d} selected={selected === d.id} large={large} onPress={() => onSelect(d.id)} register={register} />
      ))}
    </View>
  );
}

function DayButton({ day, selected, large, onPress, register }: { day: Day; selected: boolean; large: boolean; onPress: () => void; register: boolean }) {
  const outline = useEssentialOutline();
  const id = `a-day-${day.id}`;
  const ref = useCapture(register ? id : undefined);
  if (large) {
    return (
      <Pressable ref={ref} testID={register ? id : undefined} accessibilityRole="radio" accessibilityState={{ checked: selected }}
        accessibilityLabel={`${day.long}, ${KIND_WORD[day.kind]}`} onPress={onPress} style={[s.dayRow, selected && s.daySelected]}>
        <Txt role="bodyStrong" style={s.shrink}>{day.long}</Txt>
        <Txt role="meta" tone="secondary">{KIND_WORD[day.kind]}</Txt>
      </Pressable>
    );
  }
  return (
    <Pressable ref={ref} testID={register ? id : undefined} accessibilityRole="radio" accessibilityState={{ checked: selected }}
      accessibilityLabel={day.long + KIND_SUFFIX[day.kind]} onPress={onPress} style={[s.day, selected && s.daySelected]}>
      <Txt role="caption" tone="secondary">{day.label}</Txt>
      <Txt role="bodyStrong" style={tabular}>{String(day.date)}</Txt>
      <View style={s.dayStatus}>
        {day.kind === 'done' ? <Icon name="check" size={L.dayPicker.statusSize} color={t.color.success} /> : null}
        {day.kind === 'today' || day.kind === 'planned' ? <View style={[s.ring, outline && { borderColor: t.color.ink }]} /> : null}
      </View>
    </Pressable>
  );
}

/* ---------------- CMP-A07 SessionSummary ---------------- */

export function SessionSummary({ title, meta, eyebrow, captureId }: { title: string; meta: readonly string[]; eyebrow?: string; captureId?: string }) {
  const ref = useCapture(captureId);
  return (
    <View ref={ref} testID={captureId} style={s.session}>
      {eyebrow ? <Txt role="meta" tone="secondary">{eyebrow}</Txt> : null}
      <Txt role="sectionTitle" accessibilityRole="header">{title}</Txt>
      <MetaLine items={meta} />
    </View>
  );
}

/* ---------------- CMP-A08 MovementRow ---------------- */

/** Workout-order numeral (Bricolage sectionTitle) in a column of sectionTitle size × ordinalColumn. */
function Ordinal({ n, compact }: { n: number; compact?: boolean }) {
  const { large, scaleFor } = useTextScale();
  const title = t.type.sectionTitle;
  const minWidth = title.fontSize * scaleFor('sectionTitle') * L.movementRow.ordinalColumn;
  // Top-aligned to the row title: centre of a bodyStrong line inside a sectionTitle line.
  const offset = (t.type.bodyStrong.lineHeight * scaleFor('bodyStrong') - title.lineHeight * scaleFor('sectionTitle')) / 2;
  return (
    <Txt role="sectionTitle" accessibilityElementsHidden importantForAccessibility="no"
      style={[{ minWidth }, compact
        ? [{ lineHeight: t.type.bodyStrong.lineHeight }, large ? s.ordTop : s.ordCenter]
        : [s.ordTop, { marginTop: offset }]]}>
      {String(n)}
    </Txt>
  );
}

export function MovementRow({ move, variant, ord, compact, detail, last }: {
  move: Move; variant: PlanVariant; ord?: number; compact?: boolean; detail?: string; last?: boolean;
}) {
  const { large } = useTextScale();
  const sets = setWord(setsOf(move, variant));
  if (compact) {
    return (
      <View accessible accessibilityRole="text" accessibilityLabel={`${ord ? `${ord}. ` : ''}${move.name}, ${sets}`} style={s.rowCompact}>
        {ord ? <Ordinal n={ord} compact /> : null}
        <Txt role="bodyStrong" style={s.rowText}>{move.name}</Txt>
        <Txt role="bodyStrong" style={[tabular, s.rowTrail]}>{sets}</Txt>
      </View>
    );
  }
  return (
    <View style={[s.row, large && s.rowLarge, last && s.rowLast]}>
      {ord ? <Ordinal n={ord} /> : null}
      <View style={s.rowText}>
        <Txt role="bodyStrong">{move.name}</Txt>
        {detail ? <Txt role="meta" tone="secondary">{detail}</Txt> : <MetaLine items={[`${move.reps} reps`, kgLabel(move, move.kg)]} />}
      </View>
      {detail ? null : <Txt role="bodyStrong" style={[tabular, s.rowTrail]}>{sets}</Txt>}
    </View>
  );
}

/* ---------------- CMP-A09 NumericField ---------------- */

export type FieldState = 'default' | 'focused' | 'error' | 'disabled';

/** Value with 44 pt minus/plus steppers. Steppers edit the draft only; nothing here records a set. */
export function NumericField({ kind, label, value, state, moveName, onStep, register = true, fill = true }: {
  kind: 'reps' | 'kg'; label: string; value: number; state: FieldState; moveName: string;
  onStep?: (delta: -1 | 1) => void; register?: boolean; fill?: boolean;
}) {
  const { large } = useTextScale();
  const outline = useEssentialOutline();
  const id = register ? (kind === 'reps' ? 'a-workout-reps' : 'a-workout-weight') : undefined;
  const ref = useCapture(id);
  const unit = kind === 'reps' ? 'reps' : 'weight, kilograms';
  const disabled = state === 'disabled';
  return (
    <View ref={ref} testID={id} accessibilityLabel={`${moveName} ${kind === 'reps' ? 'reps' : 'kilograms'}, ${value}`}
      style={[s.field, fill && !large && s.fieldFill, outline, state === 'focused' && s.fieldFocused, state === 'error' && s.fieldError, disabled && s.fieldDisabled]}>
      <Txt role="meta" tone="secondary">{label}</Txt>
      <View style={s.fieldRow}>
        <Stepper icon="minus" label={`Decrease ${moveName.toLowerCase()} ${unit}`} captureId={register ? (kind === 'reps' ? 'a-reps-decrease' : 'a-weight-decrease') : undefined}
          disabled={disabled} onPress={() => onStep?.(-1)} />
        <Txt role="value" accessibilityLabel={`${moveName} ${kind === 'reps' ? 'reps' : 'kilograms'}, ${value}`} style={s.fieldValue}>{String(value)}</Txt>
        <Stepper icon="plus" label={`Increase ${moveName.toLowerCase()} ${unit}`} captureId={register ? (kind === 'reps' ? 'a-reps-increase' : 'a-weight-increase') : undefined}
          disabled={disabled} onPress={() => onStep?.(1)} />
      </View>
    </View>
  );
}

function Stepper({ icon, label, captureId, onPress, disabled }: { icon: 'minus' | 'plus'; label: string; captureId?: string; onPress: () => void; disabled?: boolean }) {
  const ref = useCapture(captureId);
  return (
    <Pressable ref={ref} testID={captureId} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }}
      disabled={disabled} onPress={onPress} style={({ pressed }) => [s.step, pressed && s.stepPressed]}>
      <Icon name={icon} size={L.icon.standard} color={t.color.ink} />
    </Pressable>
  );
}

/** Inline field / composer error: circle-alert 20 + body text in color.error. */
export function FieldError({ text, captureId, style }: { text: string; captureId?: string; style?: StyleProp<ViewStyle> }) {
  const ref = useCapture(captureId);
  return (
    <View ref={ref} testID={captureId} accessibilityRole="alert" accessibilityLiveRegion="polite" style={[s.fieldErrorRow, style]}>
      <View style={s.fieldErrorIcon}><Icon name="circle-alert" size={L.icon.notice} color={t.color.error} /></View>
      <Txt role="body" tone="error" style={s.shrink}>{text}</Txt>
    </View>
  );
}

/* ---------------- CMP-A10 SetChips ---------------- */

export type ChipState = 'done' | 'current' | 'not-started';

/** "Set N of M" + equal chips: done shows check AND number; current has the ink outline. */
export function SetChips({ label, chips, drawSet, reduceMotion, register = true }: {
  label: string; chips: readonly ChipState[]; drawSet?: number | null; reduceMotion: boolean; register?: boolean;
}) {
  const { large } = useTextScale();
  return (
    <View style={[s.setchips, large && s.setchipsLarge]}>
      <Txt role="bodyStrong">{label}</Txt>
      <View style={[s.chips, !large && s.chipsRow]}>
        {chips.map((state, i) => (
          <Chip key={i} n={i + 1} state={state} draw={drawSet === i + 1} reduceMotion={reduceMotion} register={register} />
        ))}
      </View>
    </View>
  );
}

function Chip({ n, state, draw, reduceMotion, register }: { n: number; state: ChipState; draw: boolean; reduceMotion: boolean; register: boolean }) {
  const id = register ? `a-set-${n}` : undefined;
  const ref = useCapture(id);
  const color = state === 'done' ? t.color.success : state === 'current' ? t.color.ink : t.color.secondary;
  const word = state === 'done' ? 'recorded' : state === 'current' ? 'current' : 'not started';
  return (
    <View ref={ref} testID={id} accessible accessibilityLabel={`Set ${n}, ${word}`}
      style={[s.chip, state === 'current' && s.chipCurrent, state === 'done' && s.chipDone]}>
      {state === 'done' ? <CheckMark size={L.icon.inline} color={color} draw={draw} reduceMotion={reduceMotion} /> : null}
      <View style={s.chipOrd}><Txt role="bodyStrong" style={[tabular, { color }]}>{String(n)}</Txt></View>
    </View>
  );
}

/* ---------------- CMP-A11 Cue ---------------- */

export function Cue({ cue, last }: { cue: string; last: string }) {
  return (
    <View style={s.cue}>
      <Txt role="body">{cue}</Txt>
      <Txt role="meta" tone="secondary">{last}</Txt>
    </View>
  );
}

/* ---------------- CMP-A14 ChatMessage ---------------- */

export function ChatMessage({ from, text, captureId }: { from: 'coach' | 'user'; text: string; captureId?: string }) {
  const ref = useCapture(captureId);
  if (from === 'user') {
    return (
      <View ref={ref} testID={captureId} accessible accessibilityLabel={`You: ${text}`} style={s.msgUser}>
        <Txt role="body">{text}</Txt>
      </View>
    );
  }
  return (
    <View ref={ref} testID={captureId} accessible accessibilityLabel={`Demo coach: ${text}`} style={s.msgCoach}>
      <Txt role="caption" tone="secondary">Demo coach</Txt>
      <Txt role="body">{text}</Txt>
    </View>
  );
}

/** Coach proposal: the short plan as numbered compact MovementRows (selection surface, radius 24). */
export function ProposalBlock({ moves, sets, captureId }: { moves: readonly Move[]; sets: number; captureId?: string }) {
  const ref = useCapture(captureId);
  return (
    <View ref={ref} testID={captureId} style={s.proposal}>
      <Txt role="sectionTitle" accessibilityRole="header">20 minutes, same focus.</Txt>
      <View accessibilityRole="list" accessibilityLabel={`${moves.length} movements, ${sets} planned sets`} style={s.proposalList}>
        {moves.map((m, i) => <MovementRow key={m.id} move={m} variant="short" ord={i + 1} compact />)}
      </View>
      <MetaLine items={[`${sets} planned sets`, '15 minutes shorter']} />
    </View>
  );
}

/* ---------------- CMP-A16 Composer ---------------- */

export const COMPOSER_LIMIT = 280;

/**
 * Multiline at every text size: grows from the 56 box up to layout.composer.maxTextHeight of
 * text, then scrolls inside. The accessible name is persistent; the placeholder is only a hint.
 * Return key Send submits.
 */
export function Composer({ value, onChange, onSend, focused, editable = true, onFocus, onBlur, register = true, forceError }: {
  value: string; onChange?: (text: string) => void; onSend?: () => void; focused?: boolean; editable?: boolean;
  onFocus?: () => void; onBlur?: () => void; register?: boolean;
  /** Showcase-only: draw the too-long state for a shortened specimen value. */
  forceError?: boolean;
}) {
  const tooLong = !!forceError || value.length > COMPOSER_LIMIT;
  const blocked = value.trim() === '' || tooLong;
  const inputCapture = useCapture(register ? 'a-coach-input' : undefined);
  const sendCapture = useCapture(register ? 'a-coach-send' : undefined);
  const outline = useEssentialOutline();
  return (
    <View style={[s.composer, outline, focused && s.composerFocused, tooLong && s.composerError]}>
      <TextInput
        ref={inputCapture}
        testID={register ? 'a-coach-input' : undefined}
        multiline
        editable={editable}
        value={value}
        onChangeText={onChange}
        placeholder="Ask about this workout"
        placeholderTextColor={t.color.secondary}
        accessibilityLabel="Message the demo coach"
        returnKeyType="send"
        submitBehavior="submit"
        onSubmitEditing={() => { if (!blocked) onSend?.(); }}
        onFocus={onFocus}
        onBlur={onBlur}
        scrollEnabled
        style={[typeStyles.body, s.composerInput]}
      />
      <Pressable ref={sendCapture} testID={register ? 'a-coach-send' : undefined} accessibilityRole="button" accessibilityLabel="Send message"
        accessibilityState={{ disabled: blocked }} disabled={blocked} onPress={onSend} style={[s.send, blocked && s.sendDisabled]}>
        <Icon name="send" size={L.icon.standard} color={blocked ? t.color.secondary : t.color.onAction} />
      </Pressable>
    </View>
  );
}

/* ---------------- CMP-A17 WeeklyChart ---------------- */

/**
 * One stacked block (radius 8) per recorded workout; every value printed; the selected week's
 * blocks carry a 2 pt ink edge inside their own box. Zero state (every week 0): value, baseline
 * and date only, sized to content.
 */
export function WeeklyChart({ counts, selected, onSelect, register = true }: {
  counts: readonly number[]; selected: number; onSelect?: (week: number) => void; register?: boolean;
}) {
  const { large } = useTextScale();
  const zero = counts.every((c) => c === 0);
  const id = onSelect && register ? 'a-progress-chart' : undefined;
  const ref = useCapture(id);
  const summary = `Workouts per week. ${fixtures.weeks.map((w, i) => `${w}: ${counts[i]}`).join(', ')}.`;
  return (
    <View ref={ref} testID={id} accessibilityRole={onSelect ? undefined : 'image'} accessibilityLabel={onSelect ? undefined : summary}
      style={[s.chart, (zero || large) && s.chartAuto, large && s.chartLarge]}>
      {fixtures.weeks.map((w, i) => (
        <ChartColumn key={w} week={w} index={i} count={counts[i]} selected={selected === i} large={large}
          onPress={onSelect ? () => onSelect(i) : undefined} register={register} />
      ))}
    </View>
  );
}

function ChartColumn({ week, index, count, selected, large, onPress, register }: {
  week: string; index: number; count: number; selected: boolean; large: boolean; onPress?: () => void; register: boolean;
}) {
  const id = onPress && register ? `a-week-${index}` : undefined;
  const ref = useCapture(id);
  const units: ReactNode[] = [];
  for (let k = 0; k < count; k += 1) units.push(<View key={k} style={[s.unit, selected && s.unitSelected]} />);
  const body = (
    <>
      <Txt role="bodyStrong" style={[tabular, !large && s.chartValue, large && s.chartValueLarge]}>{String(count)}</Txt>
      <View style={s.barWrap}><View style={s.barStack}>{units}</View></View>
      {large ? (
        <View style={s.chartLabelStack}>
          {week.split(' ').map((part) => <Txt key={part} role="caption" tone={selected ? 'ink' : 'secondary'}>{part}</Txt>)}
        </View>
      ) : (
        <Txt role="caption" tone={selected ? 'ink' : 'secondary'} style={s.chartLabel}>{week}</Txt>
      )}
    </>
  );
  const label = `Week of ${week}, ${count} ${count === 1 ? 'workout' : 'workouts'}`;
  if (!onPress) return <View style={s.col}>{body}</View>;
  return (
    <Pressable ref={ref} testID={id} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }}
      onPress={onPress} style={s.col}>
      {body}
    </Pressable>
  );
}

/* ---------------- CMP-A18 HistoryRow ---------------- */

export type HistoryRecord = { id: string; day: string; min: number; sets: number; week: number; partial?: boolean };

export function HistoryRow({ record, onPress, register = true }: { record: HistoryRecord; onPress?: () => void; register?: boolean }) {
  const id = register ? `a-history-${record.id}` : undefined;
  const ref = useCapture(id);
  return (
    <Pressable ref={ref} testID={id} accessibilityRole="button" onPress={onPress}
      accessibilityLabel={`Full-body strength, ${record.day}, ${record.min} minutes, ${record.sets} sets${record.partial ? ', partial' : ''}`}
      style={({ pressed }) => [s.hrow, pressed && s.hrowPressed]}>
      <View style={s.hText}>
        <Txt role="bodyStrong">Full-body strength</Txt>
        <MetaLine items={[record.day, `${record.min} min`, `${record.sets} sets${record.partial ? ', partial' : ''}`]} />
      </View>
      <View style={s.chev}><Icon name="chevron-right" size={L.icon.inline} color={t.color.secondary} /></View>
    </Pressable>
  );
}

/* ---------------- CMP-A19 RestPanel ---------------- */

export function RestPanel({ clock, accessibleName, next, onSkip, captureId }: {
  clock: string; accessibleName: string; next: string; onSkip?: () => void; captureId?: string;
}) {
  const ref = useCapture(captureId);
  return (
    <View ref={ref} testID={captureId} style={s.rest}>
      <View style={s.restHead}>
        {/* The timer's accessible name is derived from the same value as the visible text; it is read on focus, not announced every second. */}
        <Txt role="value" accessibilityRole="timer" accessibilityLabel={accessibleName}>{clock}</Txt>
        <Txt role="bodyStrong">Rest between sets</Txt>
      </View>
      <Txt role="meta" tone="secondary">{`Nothing is recorded while you rest. ${next} starts when you choose.`}</Txt>
      <PlainAction label="Skip rest" captureId={onSkip ? 'a-rest-skip' : undefined} onPress={onSkip} />
    </View>
  );
}

/* ---------------- CMP-A20 EmptyErrorBlock ---------------- */

export function EmptyBlock({ title, body, action, onAction, captureId, actionId, art = true }: {
  title: string; body: string; action: string; onAction?: () => void; captureId?: string; actionId?: string; art?: boolean;
}) {
  const ref = useCapture(captureId);
  return (
    <View ref={ref} testID={captureId} style={s.empty}>
      {art ? <OpenMatArt variant="small" /> : null}
      <Txt role="sectionTitle" accessibilityRole="header">{title}</Txt>
      <Txt role="body">{body}</Txt>
      <PrimaryAction label={action} captureId={actionId} onPress={onAction} style={s.emptyAction} />
    </View>
  );
}

export function ErrorBlock({ onRetry }: { onRetry?: () => void }) {
  return (
    <View style={s.empty}>
      <Txt role="sectionTitle" accessibilityRole="header">This plan didn’t load.</Txt>
      <Txt role="body">Try again. Recorded sets are not affected.</Txt>
      <PrimaryAction label="Try again" icon="undo-2" onPress={onRetry} style={s.emptyAction} />
    </View>
  );
}

/** Loading skeleton measured to the loaded session block (title line, meta line, primary). */
export function LoadingSkeleton() {
  return (
    <View accessible accessibilityLabel="Loading" accessibilityState={{ busy: true }} style={s.skeletonStack}>
      <View style={[s.skeleton, s.skeletonTitle]} />
      <View style={[s.skeleton, s.skeletonMeta]} />
      <View style={[s.skeleton, s.skeletonButton]} />
    </View>
  );
}

/* ---------------- Progress summary row ---------------- */

export function SummaryRow({ value, text }: { value: number; text: string }) {
  const { scaleFor } = useTextScale();
  const minWidth = t.type.bodyStrong.fontSize * scaleFor('bodyStrong') * t.page.progress.summaryValueColumn;
  return (
    <View accessible accessibilityLabel={`${value}${text}`} style={s.sumrow}>
      <Txt role="bodyStrong" style={[tabular, { minWidth }]}>{String(value)}</Txt>
      <Txt role="body" style={s.shrink}>{text.trim()}</Txt>
    </View>
  );
}

/* ---------------- styles ---------------- */

const D = L.dayPicker;

const s = StyleSheet.create({
  shrink: { flexShrink: 1 },
  days: { flexDirection: 'row', gap: D.gap, alignSelf: 'stretch' },
  day: {
    flex: 1, minWidth: D.targetWidth, minHeight: D.minHeight, paddingVertical: D.padY, paddingHorizontal: t.space.s0,
    alignItems: 'center', gap: D.innerGap, borderRadius: t.radius.day, borderCurve: 'continuous',
    borderWidth: t.stroke.selection, borderColor: t.color.transparent,
  },
  daySelected: { borderColor: t.color.ink, backgroundColor: t.color.selection },
  dayStatus: { width: D.statusSize, height: D.statusSize, alignItems: 'center', justifyContent: 'center' },
  ring: {
    width: D.statusSize, height: D.statusSize, borderRadius: t.radius.capsule,
    borderWidth: t.stroke.focus, borderColor: t.color.controlBorder,
  },
  dayList: { gap: t.space.s8 },
  dayRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.s12,
    minHeight: L.frame.minimumTarget, paddingVertical: t.space.s8, paddingHorizontal: t.space.s16,
    borderRadius: t.radius.day, borderCurve: 'continuous', borderWidth: t.stroke.selection, borderColor: t.color.transparent,
  },
  session: { gap: t.space.s8 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: L.movementRow.gap, minHeight: L.movementRow.minHeight,
    paddingVertical: L.movementRow.paddingY, borderBottomWidth: t.stroke.divider, borderBottomColor: t.color.line,
  },
  rowLarge: { alignItems: 'flex-start' },
  rowLast: { borderBottomWidth: 0 },
  rowCompact: { flexDirection: 'row', alignItems: 'center', gap: L.movementRow.gap },
  rowText: { flex: 1, gap: L.movementRow.detailGap, minWidth: 0 },
  rowTrail: { minWidth: L.movementRow.trailingWidth, textAlign: 'right' },
  ordTop: { alignSelf: 'flex-start' },
  ordCenter: { alignSelf: 'center' },
  fieldFill: { flex: 1 },
  field: {
    minHeight: L.field.minHeight, borderWidth: t.stroke.control, borderColor: t.color.controlBorder,
    borderRadius: t.radius.field, borderCurve: 'continuous', padding: L.field.padding, backgroundColor: t.color.surface,
    gap: L.field.labelGap,
  },
  fieldFocused: { borderWidth: t.stroke.focus, borderColor: t.color.ink, padding: t.space.s12 },
  fieldError: { borderWidth: t.stroke.focus, borderColor: t.color.error, padding: t.space.s12 },
  fieldDisabled: { backgroundColor: t.color.disabledSurface },
  fieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: L.field.innerGap },
  fieldValue: { flex: 1, minWidth: L.field.valueMinWidth, textAlign: 'center' },
  step: {
    width: L.field.controlTarget, height: L.field.controlTarget, borderRadius: t.radius.capsule,
    backgroundColor: t.color.selection, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  stepPressed: { backgroundColor: t.color.line },
  fieldErrorRow: { marginTop: L.field.errorGap, flexDirection: 'row', gap: t.space.s8, alignItems: 'flex-start' },
  fieldErrorIcon: { marginTop: t.space.s2 },
  setchips: { flexDirection: 'row', alignItems: 'center', gap: L.setChips.labelGap, minHeight: L.setChips.height },
  setchipsLarge: { flexDirection: 'column', alignItems: 'stretch', gap: t.space.s8 },
  chips: { flexDirection: 'row', gap: L.setChips.gap },
  chipsRow: { flex: 1 },
  chip: {
    flex: 1, minHeight: L.setChips.target, borderRadius: t.radius.chip, borderCurve: 'continuous',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.space.s4,
    borderWidth: t.stroke.control, borderColor: t.color.line,
  },
  chipCurrent: { borderWidth: t.stroke.selection, borderColor: t.color.ink },
  chipDone: { backgroundColor: t.color.successSurface, borderColor: t.color.successSurface },
  chipOrd: {
    width: L.setChips.circle, height: L.setChips.circle, borderRadius: t.radius.capsule,
    alignItems: 'center', justifyContent: 'center',
  },
  cue: { gap: t.space.s4 },
  msgCoach: { gap: t.space.s4 },
  msgUser: {
    alignSelf: 'flex-end', maxWidth: L.message.maxWidth, backgroundColor: t.color.selection,
    borderRadius: t.radius.message, borderCurve: 'continuous', padding: L.message.padding,
  },
  proposal: {
    backgroundColor: t.color.selection, borderRadius: t.radius.message, borderCurve: 'continuous',
    paddingVertical: t.space.s16, paddingHorizontal: t.page.coach.proposalPadding, gap: t.space.s8,
  },
  proposalList: { gap: t.space.s4 },
  composer: {
    minHeight: L.composer.minHeight, borderRadius: t.radius.button, borderCurve: 'continuous',
    borderWidth: t.stroke.control, borderColor: t.color.controlBorder, backgroundColor: t.color.surface,
    paddingTop: L.composer.paddingY, paddingBottom: L.composer.paddingY, paddingRight: t.space.s8, paddingLeft: L.composer.paddingX,
    flexDirection: 'row', alignItems: 'center', gap: t.space.s8,
  },
  composerFocused: { borderWidth: t.stroke.focus, borderColor: t.color.ink },
  composerError: { borderWidth: t.stroke.focus, borderColor: t.color.error },
  composerInput: {
    flex: 1, minWidth: 0, maxHeight: L.composer.maxTextHeight, color: t.color.ink,
    paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0,
  },
  send: {
    width: L.composer.sendTarget, height: L.composer.sendTarget, borderRadius: t.radius.capsule,
    backgroundColor: t.color.action, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  sendDisabled: { backgroundColor: t.color.disabledSurface },
  chart: { height: L.chart.height, flexDirection: 'row', alignItems: 'flex-end', gap: L.chart.columnGap },
  chartAuto: { height: 'auto' },
  chartLarge: { minHeight: L.chart.height },
  col: { flex: 1, alignItems: 'center', minWidth: L.chart.minTargetWidth },
  chartValue: { height: L.chart.valueHeight, marginBottom: L.chart.valueGap },
  chartValueLarge: { marginBottom: L.chart.valueGap },
  barWrap: {
    alignSelf: 'stretch', alignItems: 'center', borderBottomWidth: L.chart.baselineWidth, borderBottomColor: t.color.controlBorder,
  },
  barStack: { width: L.chart.barWidth, gap: L.chart.unitGap },
  unit: { height: L.chart.unitHeight, backgroundColor: t.color.chart, borderRadius: t.radius.chartUnit, borderCurve: 'continuous' },
  unitSelected: { borderWidth: L.chart.selectionWidth, borderColor: t.color.chartSelected },
  chartLabel: { height: L.chart.labelHeight, marginTop: L.chart.labelGap },
  chartLabelStack: { marginTop: L.chart.labelGap, alignItems: 'center' },
  hrow: {
    flexDirection: 'row', alignItems: 'center', gap: t.space.s12, minHeight: L.historyRow.minHeight,
    paddingVertical: L.historyRow.paddingY, borderBottomWidth: t.stroke.divider, borderBottomColor: t.color.line,
  },
  hrowPressed: { backgroundColor: t.color.selection },
  hText: { flex: 1, gap: L.historyRow.titleDetailGap },
  chev: { width: L.historyRow.chevronTarget, height: L.historyRow.chevronTarget, alignItems: 'center', justifyContent: 'center' },
  rest: {
    backgroundColor: t.color.selection, borderRadius: t.radius.rest, borderCurve: 'continuous', padding: L.restPanel.padding,
    minHeight: L.restPanel.minHeight, gap: L.restPanel.gap,
  },
  restHead: { flexDirection: 'row', gap: t.space.s16, alignItems: 'baseline', flexWrap: 'wrap' },
  empty: { gap: L.empty.gap, minHeight: L.empty.minHeight },
  emptyAction: { marginTop: t.space.s12 },
  skeletonStack: { gap: t.space.s8 },
  skeleton: { backgroundColor: t.color.disabledSurface, borderRadius: t.radius.small },
  skeletonTitle: { height: t.type.sectionTitle.lineHeight, width: L.art.smallWidth },
  skeletonMeta: { height: t.type.meta.lineHeight },
  skeletonButton: { height: L.button.minHeight, borderRadius: t.radius.button, marginTop: t.space.s12 },
  sumrow: { minHeight: t.page.progress.summaryRowMinHeight, flexDirection: 'row', alignItems: 'center', gap: t.space.s12 },
});
