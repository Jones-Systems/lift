// Open Mat design-system showcase (developer route, outside the five tabs). Built from the same
// components and tokens as the product screens. Each of the five reference sections
// (color, type, controls, feedback, data) opens exactly as app/showcase.js draws it; the detailed
// system documentation and live interactive specimens follow below it, and three further
// sections (system, components, pages) cover thesis, sources, all 20 components and page flow.
// Labels such as "Pressed" annotate this surface only and never appear on product routes.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { CheckMark, Icon, OpenMatArt } from './art';
import { icons, type IconName } from './assets/generatedicons';
import { useCapture } from './capture';
import {
  ChatMessage, Composer, Cue, DayPicker, EmptyBlock, ErrorBlock, FieldError, HistoryRow, kgLabel, LoadingSkeleton, MovementRow, NumericField,
  ProposalBlock, RestPanel, SessionSummary, SetChips, WeeklyChart, COMPOSER_LIMIT, type ChipState, type DayId, type FieldState,
} from './components';
import { Compare, SheetActions, SheetLayer, SheetRow, SheetSection, SheetSpecimen, TabBar, type SheetClose, type SheetSpec } from './frame';
import { fixtures } from './generatedfixtures';
import { guide } from './generatedguide';
import {
  clock, COACH_REPLY, EXPLAIN_REPLY, FIXTURE_REST_SECONDS, MOVES, MS_PER_SECOND, planMoves, planTotals, REST_TICK_MS, restName, secondsLeft,
  stepValue, validate, weekCounts,
} from './model';
import { MetaLine, mt, NavRow, Notice, PageTitle, PlainAction, PrimaryAction, PromptChoice, Txt } from './primitives';
import { colorAt, DISPLAY_ROLES, L, t, useTextScale, type TypeRole } from './theme';

type SectionKey = 'color' | 'type' | 'controls' | 'feedback' | 'data' | 'system' | 'components' | 'pages';
const ORDER: readonly SectionKey[] = ['system', 'color', 'type', 'data', 'controls', 'feedback', 'components', 'pages'];
// Built from tuples so no style-named object key (e.g. "color") carries a string literal.
const TITLES = Object.fromEntries([
  ['color', 'Color and signature'],
  ['type', 'Type and voice'],
  ['controls', 'Controls and states'],
  ['feedback', 'Feedback and coach'],
  ['data', 'Records, space, shape'],
  ['system', 'Thesis and sources'],
  ['components', 'Components A01–A20'],
  ['pages', 'Pages, flow and states'],
] as const) as Record<SectionKey, string>;
const isSection = (value: unknown): value is SectionKey => typeof value === 'string' && (ORDER as readonly string[]).includes(value);

/* ---------------- specimen helpers (showcase.js label/spec/heading/sectionBox) ---------------- */

function Label({ children }: { children: string }) {
  return <Txt role="caption" tone="secondary">{children}</Txt>;
}

function Spec({ name, children, style }: { name: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.spec, style]}><Label>{name}</Label>{children}</View>;
}

function Heading({ title, sub }: { title: string; sub?: string }) {
  return (
    <View style={s.heading}>
      <Txt role="sectionTitle" accessibilityRole="header">{title}</Txt>
      {sub ? <Txt role="meta" tone="secondary">{sub}</Txt> : null}
    </View>
  );
}

function SectionBox({ children }: { children: ReactNode }) {
  return <View style={s.sectionBox}>{children}</View>;
}

function Swatch({ color, radius, border }: { color: string; radius?: number; border?: string }) {
  return <View style={[s.swatch, { backgroundColor: color }, radius !== undefined && { borderRadius: radius }, border ? { borderColor: border } : null]} />;
}

function Para({ children }: { children: string }) {
  return <Txt role="body">{children}</Txt>;
}

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <View style={s.bullets}>
      {items.map((item) => (
        <View key={item} style={s.bulletRow}>
          <Txt role="body" tone="secondary">–</Txt>
          <Txt role="body" style={s.shrink}>{item}</Txt>
        </View>
      ))}
    </View>
  );
}

/** A guide table on a phone: one stacked block per row (first column as the title). */
function GuideTable({ table }: { table: { readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] } }) {
  return (
    <View>
      {table.rows.map((row, i) => (
        <View key={`${row[0]}-${i}`} style={[s.tableRow, i === table.rows.length - 1 && s.tableRowLast]}>
          <Txt role="bodyStrong">{row[0]}</Txt>
          {row.slice(1).map((cell, j) => (cell ? (
            <Txt key={j} role="meta" tone="secondary">{`${table.columns[j + 1]}: ${cell}`}</Txt>
          ) : null))}
        </View>
      ))}
    </View>
  );
}

function Mark({ ok, children }: { ok: boolean; children: string }) {
  return (
    <View style={s.markRow}>
      <Icon name={ok ? 'check' : 'x'} size={L.icon.inline} color={ok ? t.color.success : t.color.error} />
      <Txt role="body" style={s.shrink}>{children}</Txt>
    </View>
  );
}

/* ---------------- live specimens ---------------- */

function LiveFields() {
  const [reps, setReps] = useState<number>(MOVES[0].defReps);
  const [kg, setKg] = useState<number>(MOVES[0].kg);
  const error = validate({ reps, kg, error: null, focus: null });
  const repsBad = error === 'reps';
  const kgBad = error === 'kg';
  const state = (bad: boolean): FieldState => (bad ? 'error' : 'default');
  return (
    <Spec name="Live · steppers edit a draft only; out-of-range values show the inline error and disable Confirm">
      <View style={s.fieldsRow}>
        <NumericField kind="reps" label="Reps" value={reps} state={state(repsBad)} moveName={MOVES[0].name} register={false}
          onStep={(d) => setReps((v) => stepValue('reps', v, d))} />
        <NumericField kind="kg" label="Weight, kg" value={kg} state={state(kgBad)} moveName={MOVES[0].name} register={false}
          onStep={(d) => setKg((v) => stepValue('kg', v, d))} />
      </View>
      {repsBad ? <FieldError text="Enter 1–99 reps." /> : kgBad ? <FieldError text="Use 0–200 kg in 0.5 kg steps." /> : null}
      <PrimaryAction label="Confirm set" disabled={repsBad || kgBad} />
    </Spec>
  );
}

function LiveChips({ reduceMotion }: { reduceMotion: boolean }) {
  const [done, setDone] = useState(0);
  const [draw, setDraw] = useState<number | null>(null);
  const total = MOVES[0].full;
  const chips: ChipState[] = Array.from({ length: total }, (_, i) => (i < done ? 'done' : i === done ? 'current' : 'not-started'));
  return (
    <Spec name="Live · only the first confirmation of a session draws its check (motion.confirm); later ones change immediately">
      <SetChips label={`Set ${Math.min(done + 1, total)} of ${total}`} chips={chips} drawSet={draw} reduceMotion={reduceMotion} register={false} />
      <PrimaryAction label="Confirm set" disabled={done >= total}
        onPress={() => { setDraw(done === 0 ? 1 : null); setDone((n) => Math.min(n + 1, total)); }} />
      <PlainAction label="Start a new session" chevron={null} onPress={() => { setDone(0); setDraw(null); }} />
    </Spec>
  );
}

function LiveDays() {
  const [day, setDay] = useState<DayId>('wed');
  return (
    <Spec name="Live · tap a day (radio group; a day list at large text)">
      <DayPicker selected={day} onSelect={setDay} register={false} />
      <Txt role="meta" tone="secondary">{`Selected: ${fixtures.days.find((d) => d.id === day)?.long ?? ''}`}</Txt>
    </Spec>
  );
}

function LivePrompts() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Spec name="Live · prompt choice (selected state; grows to multiline)">
      <View style={s.promptRow}>
        {['I have 20 minutes', 'Why these movements?'].map((label) => (
          <PromptChoice key={label} label={label} selected={selected === label} onPress={() => setSelected(selected === label ? null : label)} />
        ))}
      </View>
    </Spec>
  );
}

function LiveDisclosure() {
  const [open, setOpen] = useState(false);
  const rows = open ? fixtures.history : fixtures.history.slice(0, 2);
  return (
    <Spec name="Live · disclosure PlainAction (chevron-down / chevron-up, expanded state)">
      <View>{rows.map((r) => <HistoryRow key={r.id} record={r} register={false} />)}</View>
      <PlainAction label={open ? 'Show less' : `Show all ${fixtures.history.length} workouts`} chevron={open ? 'chevron-up' : 'chevron-down'}
        expanded={open} onPress={() => setOpen((v) => !v)} />
    </Spec>
  );
}

function LivePrimary() {
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  return (
    <Spec name="Live · loading keeps the same size and dispatches once">
      <PrimaryAction label={loading ? 'Saving…' : 'Save 2 recorded sets'} loading={loading}
        onPress={() => { setLoading(true); setCount((n) => n + 1); }} />
      <Txt role="meta" tone="secondary">{`Dispatched ${count} ${count === 1 ? 'time' : 'times'}`}</Txt>
      <PlainAction label="Reset specimen" chevron={null} onPress={() => { setLoading(false); setCount(0); }} />
    </Spec>
  );
}

function LiveNotice() {
  const [applied, setApplied] = useState(true);
  return (
    <Spec name="Live · Undo restores; the notice never auto-dismisses">
      <Notice kind="success" captureId={null} text={applied ? '20-minute option applied.' : '35-minute workout restored.'}
        action={applied ? { label: 'Undo change', onPress: () => setApplied(false) } : null} />
      {applied ? null : <PlainAction label="Apply again" chevron={null} onPress={() => setApplied(true)} />}
    </Spec>
  );
}

function LiveRest() {
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsAt === null) return undefined;
    const id = setInterval(() => setNow(Date.now()), REST_TICK_MS);
    return () => clearInterval(id);
  }, [endsAt]);
  const seconds = endsAt === null ? fixtures.restSeconds : secondsLeft(endsAt, now);
  const running = endsAt !== null && seconds > 0;
  return (
    <Spec name="Live · real m:ss countdown from a stored end time; expiry records nothing">
      <RestPanel clock={clock(seconds)} accessibleName={restName(seconds)} next="Set 2" onSkip={() => setEndsAt(null)} />
      <PlainAction label={running ? 'Restart rest' : 'Start rest'} chevron={null}
        onPress={() => { const time = Date.now(); setNow(time); setEndsAt(time + fixtures.restSeconds * MS_PER_SECOND); }} />
    </Spec>
  );
}

function LiveComposer() {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [thread, setThread] = useState<{ who: 'user' | 'coach'; text: string }[]>([]);
  const send = () => {
    if (value.trim() === '' || value.length > COMPOSER_LIMIT) return;
    setThread((list) => [...list, { who: 'user', text: value }, { who: 'coach', text: COACH_REPLY }]);
    setValue('');
  };
  return (
    <Spec name="Live · composer wraps and grows to maxTextHeight; bounded canned reply">
      <View style={s.thread}>
        <ChatMessage from="coach" text={fixtures.seedLine} />
        {thread.map((m, i) => <ChatMessage key={i} from={m.who} text={m.text} />)}
      </View>
      <PromptChoice label="Why these movements?" onPress={() => setThread((list) => [...list, { who: 'user', text: 'Why these movements?' }, { who: 'coach', text: EXPLAIN_REPLY }])} />
      <Composer value={value} onChange={setValue} onSend={send} focused={focused} register={false}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
      {value.length > COMPOSER_LIMIT ? <FieldError text="Keep messages under 280 characters." /> : null}
    </Spec>
  );
}

function LiveChart() {
  const [week, setWeek] = useState<number>(fixtures.thisWeek);
  const counts = weekCounts(fixtures.history);
  return (
    <Spec name="Live · tap a week: its blocks take the 2 pt ink edge; the value stays printed">
      <WeeklyChart counts={counts} selected={week} onSelect={setWeek} register={false} />
      <Txt role="meta" tone="secondary">{`Week of ${fixtures.weeks[week]}: ${counts[week]} recorded`}</Txt>
    </Spec>
  );
}

function MotionReplay({ reduceMotion }: { reduceMotion: boolean }) {
  const [run, setRun] = useState(0);
  return (
    <Spec name={reduceMotion ? 'Live · Reduce Motion: 120 ms fade (motion.reduced)' : 'Live · check draw, 220 ms ease-out (motion.confirm, motion.easeOut)'}>
      <View style={s.motionRow}>
        <View style={[s.motionChip]}>
          <CheckMark key={run} size={L.icon.inline} color={t.color.success} draw={run > 0} reduceMotion={reduceMotion} />
          <Txt role="bodyStrong" tone="success">1</Txt>
        </View>
        <PlainAction label="Replay" chevron={null} onPress={() => setRun((n) => n + 1)} />
      </View>
    </Spec>
  );
}

function LiveSheet({ open }: { open: (spec: SheetSpec) => void }) {
  const cur = planTotals('full');
  const pro = planTotals('short');
  return (
    <Spec name="Live · real modal sheet: Close, scrim tap, swipe down; Reduce Motion fades">
      <PrimaryAction label="Open adjust-review sheet" onPress={() => open({
        id: 'a-showcase-sheet', title: 'Make room for 20 minutes', closeId: 'a-showcase-sheet-close', large: true,
        body: (
          <>
            <SheetSection>
              <Compare label="Current" value={`${cur.minutes} minutes, ${cur.moves} movements, ${cur.sets} sets`} />
              <Compare label="Proposed" value={`${pro.minutes} minutes, ${pro.moves} movements, ${pro.sets} sets`} />
            </SheetSection>
            <SheetActions>
              <Txt role="body">Specimen: nothing here changes a plan.</Txt>
            </SheetActions>
          </>
        ),
      })} />
    </Spec>
  );
}

/* ---------------- reference sections (app/showcase.js) ---------------- */

const SWATCHES: readonly [keyof typeof t.color, string][] = [
  ['canvas', 'Root canvas, most of every screen'],
  ['surface', 'Inputs, sheets'],
  ['atmosphere', 'Open Mat art; selected plan panel'],
  ['ink', 'Headings, copy · 11.72:1 on canvas'],
  ['secondary', 'Metadata · 5.56:1 canvas, 4.90:1 atmosphere'],
  ['action', 'One filled primary action · white 6.61:1'],
  ['actionPressed', 'Pressed primary · white 9.51:1'],
  ['selection', 'Selected day, chips, user message'],
  ['controlBorder', 'Field and control outline · 3.44:1'],
  ['success', 'Confirmed state, always with words or check'],
];

function ColorReference() {
  return (
    <>
      <Para>Strength as an open mat in a welcoming community studio: one large paper-cut figure invites, plain unboxed space and blunt controls make the next step clear.</Para>
      <View style={[mt('s16'), s.center]}><OpenMatArt variant="today" /></View>
      <Label>Signature: Open Mat illustration. Content only — never a button, card, chart or mascot.</Label>
      <SectionBox>
        <Heading title="Color roles" sub="Daylight atmosphere, pale-blue mat, one deep-green action." />
        <View style={s.swatchList}>
          {SWATCHES.map(([key, use]) => (
            <View key={key} style={s.dsRow}>
              <Swatch color={String(t.color[key])} />
              <View style={s.shrink}>
                <Txt role="bodyStrong">{`color.${key}  ${String(t.color[key]).toUpperCase()}`}</Txt>
                <Txt role="meta" tone="secondary">{use}</Txt>
              </View>
            </View>
          ))}
        </View>
      </SectionBox>
      <SectionBox>
        <Heading title="Never pair" />
        <View style={s.tight}>{guide.neverPair.map((item) => <Mark key={item} ok={false}>{item}</Mark>)}</View>
      </SectionBox>
    </>
  );
}

const face = (role: TypeRole) => (t.type[role].fontFamily.startsWith('Bricolage') ? 'Bricolage' : 'Atkinson Next');
function typeSpec(role: TypeRole) {
  const v = t.type[role];
  const parts = [`${face(role)} ${v.fontWeight}`, `${v.fontSize}/${v.lineHeight}`];
  if (v.letterSpacing !== 0) parts.push(String(v.letterSpacing).replace('-', '−'));
  if (role === 'stat' || role === 'value') parts.push('tabular');
  return parts.join(' · ');
}
const LADDER: readonly [TypeRole, string][] = [
  ['display', 'Hello, Alex.'], ['pageTitle', 'Your week, your pace.'], ['exerciseTitle', 'Goblet squat'], ['sectionTitle', 'Full-body strength'],
  ['stat', '8'], ['value', '12'], ['button', 'Confirm set'], ['bodyStrong', 'One-arm dumbbell row'], ['body', 'Sit between your feet.'],
  ['meta', '35 minutes   5 movements'], ['caption', 'Demo coach'], ['tab', 'Progress'],
];

function TypeReference() {
  return (
    <>
      <Heading title="Type" sub="Recreation-poster display over a text face chosen for distinct digits and letters." />
      <View style={[s.ladder, mt('s16')]}>
        {LADDER.map(([role, sample]) => (
          <View key={role} style={s.tight}>
            <Label>{`type.${role} · ${typeSpec(role)}`}</Label>
            <Txt role={role}>{sample}</Txt>
          </View>
        ))}
      </View>
      <SectionBox>
        <Heading title="Voice" />
        <Mark ok>“2 sets recorded. The rest stays unrecorded.”</Mark>
        <Mark ok={false}>“Crush it.” “Perfect form.” “AI-powered.”</Mark>
      </SectionBox>
    </>
  );
}

function ControlsReference() {
  const m = MOVES[0];
  const chips: ChipState[] = ['done', 'current', 'not-started'];
  const field = (name: string, state: FieldState, reps: number) => (
    <Spec name={name}><NumericField kind="reps" label="Reps" value={reps} state={state} moveName={m.name} register={false} fill={false} /></Spec>
  );
  return (
    <>
      <Heading title="Actions" sub="CMP-A04 primary · CMP-A05 plain. One filled action per screen." />
      <Spec name="Primary · default"><PrimaryAction label="Start 35-minute workout" /></Spec>
      <Spec name="Primary · pressed"><PrimaryAction label="Start 35-minute workout" forced="pressed" /></Spec>
      <Spec name="Primary · focused (2 pt ink ring, offset 2)"><PrimaryAction label="Confirm set" forced="focused" /></Spec>
      <Spec name="Primary · disabled (border + readable text)"><PrimaryAction label="Confirm set" disabled /></Spec>
      <Spec name="Primary · loading (same size, single dispatch)"><PrimaryAction label="Saving…" loading /></Spec>
      <View style={s.wrapRow24}>
        <Spec name="Plain · default"><PlainAction label="Only have 20 minutes?" /></Spec>
        <Spec name="Plain · pressed"><PlainAction label="Keep going" chevron={null} forcedPressed /></Spec>
        <Spec name="Plain · disabled"><PlainAction label="Undo change" chevron={null} disabled /></Spec>
      </View>
      <SectionBox>
        <Heading title="Workout inputs" sub="CMP-A09 field · CMP-A10 set chips. Steppers never confirm." />
        <Spec name="Set chips · done, current, not started">
          <SetChips label="Set 2 of 3" chips={chips} reduceMotion register={false} />
        </Spec>
        <View style={s.fieldsRow}>{field('Field · default', 'default', m.defReps)}{field('Field · focused', 'focused', m.defReps + 1)}</View>
        <View style={s.fieldsRow}>{field('Field · error', 'error', 0)}{field('Field · disabled', 'disabled', m.defReps)}</View>
      </SectionBox>
      <SectionBox>
        <Heading title="Choosing" sub="CMP-A06 day picker · CMP-A15 prompt." />
        <Spec name="Days · recorded Mon, selected Wed, planned Fri"><DayPicker selected="wed" onSelect={() => undefined} register={false} /></Spec>
        <View style={s.wrapRow12}>
          <Spec name="Prompt · default"><PromptChoice label="I have 20 minutes" /></Spec>
          <Spec name="Prompt · selected"><PromptChoice label="Why these movements?" selected /></Spec>
        </View>
      </SectionBox>
    </>
  );
}

function FeedbackReference() {
  return (
    <>
      <Heading title="Notices" sub="CMP-A12. Icon and words carry meaning; Undo never auto-dismisses." />
      <Notice kind="success" captureId={null} text="20-minute option applied." action={{ label: 'Undo change' }} />
      <Notice kind="warning" captureId={null} text="2 sets recorded. 9 planned sets remain unrecorded." />
      <Notice kind="error" captureId={null} text="Couldn’t save on this device. Your sets are still here." action={{ label: 'Try again' }} />
      <Notice kind="info" captureId={null} text="Nothing changes until you apply this option." />
      <SectionBox>
        <Heading title="Rest" sub="CMP-A19. Timer never records a set." />
        <RestPanel clock={clock(FIXTURE_REST_SECONDS)} accessibleName={restName(FIXTURE_REST_SECONDS)} next="Set 2" />
      </SectionBox>
      <SectionBox>
        <Heading title="Coach" sub="CMP-A14 message · CMP-A16 composer. Labeled demo; no avatar, no mic." />
        <View style={s.thread}>
          <ChatMessage from="coach" text={fixtures.seedLine} />
          <ChatMessage from="user" text="Why these movements?" />
        </View>
        <Spec name="Proposal · numbered compact MovementRows (short plan)">
          <ProposalBlock moves={planMoves('short')} sets={planTotals('short').sets} />
        </Spec>
        <Spec name="Composer · empty (Send disabled)"><Composer value="" editable={false} register={false} /></Spec>
        <Spec name="Composer · focused, ready"><Composer value="Can I swap the row?" focused editable={false} register={false} /></Spec>
        <Spec name="Composer · over 280 characters"><Composer value="I want to understand every option before…" forceError editable={false} register={false} /></Spec>
        <FieldError text="Keep messages under 280 characters." />
      </SectionBox>
      <SectionBox>
        <Heading title="Empty, error, loading" sub="CMP-A20. Deterministic local specimens, no invented outage." />
        <EmptyBlock title="No recorded workouts yet." body="Confirm a set during a workout and save it here." action="Go to workout" />
        <ErrorBlock />
        <Spec name="Loading skeleton · measured to the loaded session block"><LoadingSkeleton /></Spec>
      </SectionBox>
    </>
  );
}

const SPACES = ['s4', 's8', 's12', 's16', 's20', 's24', 's32', 's40', 's48', 's64'] as const;
const RADII: readonly [keyof typeof t.radius, string][] = [
  ['button', '28 · buttons, composer'], ['selectedPlan', '28 · plan panel'], ['chartUnit', '8 · stacked workout block'],
  ['message', '24 · proposal, prompt, bubble'], ['field', '20 · fields, rest'], ['day', '16 · day, notice 16'], ['small', '12 · swatch, skeleton'],
];
const ICON_ROW: readonly IconName[] = ['house', 'calendar-days', 'dumbbell', 'message-circle', 'chart-no-axes-combined', 'check', 'x', 'chevron-right',
  'chevron-down', 'plus', 'minus', 'send', 'clock-3', 'circle-question-mark', 'undo-2', 'circle-check', 'circle-alert', 'triangle-alert'];
const MOTION: readonly [string, string][] = [
  ['First confirmed set', 'Check draws in the done chip, 220 ms ease-out; number stays still. Reduce Motion: 120 ms fade.'],
  ['Primary press', 'Instant pressed color, 100 ms return. No scale.'],
  ['Sheets', 'Native 260 ms ease-out rise. Reduce Motion: 120 ms fade.'],
  ['Haptic', 'Optional light impact on confirm, same frame. Never the only signal.'],
];

function DataReference() {
  return (
    <>
      <Heading title="Records" sub="CMP-A17 chart · CMP-A18 history · CMP-A08 movement row." />
      <Spec name="Weekly chart · one block per recorded workout, selected week outlined, values always printed">
        <WeeklyChart counts={weekCounts(fixtures.history)} selected={fixtures.thisWeek} register={false} />
      </Spec>
      <View>
        <HistoryRow record={{ id: 'w8', day: 'Mon, Oct 5', min: 31, sets: 11, week: 3 }} register={false} />
        <HistoryRow record={{ id: 'w9', day: 'Wed, Oct 7', min: 18, sets: 2, week: 3, partial: true }} register={false} />
      </View>
      <Spec name="Movement rows · numbered in workout order; long name wraps">
        <View>
          <MovementRow move={MOVES[0]} variant="full" ord={1} />
          <MovementRow move={MOVES[3]} variant="full" ord={4} last />
        </View>
      </Spec>
      <SectionBox>
        <Heading title="Space" sub="4-pt scale. Group interiors 8/12; sections 24/32." />
        <View style={s.tight8}>
          {SPACES.map((key) => (
            <View key={key} style={s.dsRow}>
              <Txt role="caption" tone="secondary" style={s.spaceLabel}>{`${t.space[key]}px`}</Txt>
              <View style={[s.spacebar, { width: t.space[key] }]} />
            </View>
          ))}
        </View>
      </SectionBox>
      <SectionBox>
        <Heading title="Shape" sub="Round-ended controls; content boxes are exceptions, never nested." />
        <View style={s.tight8}>
          {RADII.map(([key, use]) => (
            <View key={key} style={s.dsRow}>
              <Swatch color={t.color.selection} radius={t.radius[key]} border={t.color.controlBorder} />
              <Txt role="meta">{`radius.${key} · ${use}`}</Txt>
            </View>
          ))}
        </View>
      </SectionBox>
      <SectionBox>
        <Heading title="Icons" sub="Lucide 2-pt outline; 24 standard, 22 tab, 16 inline, 44 target." />
        <View style={s.iconRow}>{ICON_ROW.map((name) => <Icon key={name} name={name} size={L.icon.standard} color={t.color.ink} />)}</View>
      </SectionBox>
      <SectionBox>
        <Heading title="Motion" sub="One orchestrated moment; everything else answers a tap." />
        {MOTION.map(([title, body]) => (
          <View key={title} style={s.tight}>
            <Txt role="bodyStrong">{title}</Txt>
            <Txt role="meta" tone="secondary">{body}</Txt>
          </View>
        ))}
      </SectionBox>
    </>
  );
}

/* ---------------- detailed documentation (below each reference section) ---------------- */

function DetailIntro() {
  return <View style={s.detailRule}><Label>Detail · from DESIGN.md, the system and the handoff (v2)</Label></View>;
}

function ColorDetail() {
  return (
    <>
      <DetailIntro />
      <SectionBox>
        <Heading title="Semantic roles" sub="Every role, its value and its only allowed use." />
        <View>
          {guide.colorSystem.rows.map((row, i) => (
            <View key={row[0]} style={[s.tableRow, i === guide.colorSystem.rows.length - 1 && s.tableRowLast]}>
              <View style={s.dsRow}>
                {row[0].split(' / ').map((part) => {
                  const base = row[0].split('.').slice(0, -1).join('.');
                  const path = part.includes('.') ? part : `${base}.${part}`;
                  return <Swatch key={part} color={colorAt(path.replace(/^color\./, ''))} />;
                })}
                <View style={s.shrink}>
                  <Txt role="bodyStrong">{row[0]}</Txt>
                  <Txt role="meta" tone="secondary">{row[1]}</Txt>
                </View>
              </View>
              <Txt role="meta">{row[2]}</Txt>
            </View>
          ))}
        </View>
      </SectionBox>
      <SectionBox>
        <Heading title="Measured contrast" sub="WCAG 2.x ratios computed from tokens.json for every declared pair." />
        {guide.contrast.map((pair) => (
          <View key={`${pair.fg}-${pair.bg}`} style={s.dsRow}>
            <View style={[s.contrastChip, { backgroundColor: colorAt(pair.bg) }]}>
              <Txt role="bodyStrong" style={{ color: colorAt(pair.fg) }}>Aa</Txt>
            </View>
            <View style={s.shrink}>
              <Txt role="bodyStrong">{`${pair.fg} on ${pair.bg}`}</Txt>
              <Txt role="meta" tone="secondary">{`${pair.ratio}:1 · minimum ${pair.min} · ${pair.pass ? 'passes' : 'fails'}`}</Txt>
            </View>
          </View>
        ))}
      </SectionBox>
      <SectionBox>
        <Heading title="Illustration palette" sub="Art only; never status, action or clothing for UI." />
        <View style={s.swatchList}>
          {(Object.keys(t.color.art) as (keyof typeof t.color.art)[]).map((key) => (
            <View key={key} style={s.dsRow}>
              <Swatch color={t.color.art[key]} />
              <Txt role="bodyStrong">{`color.art.${key}  ${t.color.art[key].toUpperCase()}`}</Txt>
            </View>
          ))}
        </View>
      </SectionBox>
      <SectionBox>
        <Heading title="Color rules" />
        {guide.colorRules.map((p) => <Para key={p}>{p}</Para>)}
        {guide.colorNotes.map((p) => <Para key={p}>{p}</Para>)}
      </SectionBox>
      <SectionBox>
        <Heading title="Signature element" />
        {guide.signature.map((p) => <Para key={p}>{p}</Para>)}
        <Spec name="Today 320 × 168 · Workout 200 × 105 · empty mat 120 × 63 (rest days, empty Progress)">
          <View style={s.center}><OpenMatArt variant="today" /></View>
          <View style={s.artRow}><OpenMatArt variant="workout" /><OpenMatArt variant="small" /></View>
        </Spec>
      </SectionBox>
    </>
  );
}

function TypeDetail() {
  const { fontScale, large, scaleFor } = useTextScale();
  return (
    <>
      <DetailIntro />
      <SectionBox>
        <Heading title="Roles and Dynamic Type" sub="Bricolage roles cap at ×1.5 (accessibility.displayMaxMultiplier); text roles grow freely." />
        <Txt role="meta" tone="secondary">{`This device now: text scale ×${fontScale.toFixed(2)} · large-text layout ${large ? 'on' : 'off'}`}</Txt>
        {guide.typeRoles.map((r) => (
          <View key={r.token} style={s.tableRow}>
            <Txt role="bodyStrong">{`type.${r.token}`}</Txt>
            <Txt role="meta" tone="secondary">{`${r.face} · ${r.scale} pt · native ${r.nativeStyle}`}</Txt>
            <Txt role="meta" tone="secondary">
              {`${DISPLAY_ROLES.includes(r.token as TypeRole) ? 'Display cap ×1.5' : r.token === 'tab' ? 'Tab label: system large-content viewer, no growth' : 'Grows with text size'} · now ×${scaleFor(r.token as TypeRole).toFixed(2)}`}
            </Txt>
          </View>
        ))}
      </SectionBox>
      <SectionBox>
        <Heading title="Typography decisions" />
        <Bullets items={guide.typeNotes} />
        {guide.typeRules.map((p) => <Para key={p}>{p}</Para>)}
      </SectionBox>
      <SectionBox>
        <Heading title="Voice" sub="Capable companion; specific verbs; no praise inflation." />
        {guide.motionVoice.slice(1).map((p) => <Para key={p}>{p}</Para>)}
      </SectionBox>
    </>
  );
}

function DataDetail({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <>
      <DetailIntro />
      <SectionBox>
        <Heading title="Live records" />
        <LiveChart />
        <LiveDisclosure />
      </SectionBox>
      <SectionBox>
        <Heading title="Layout and grid" sub="402 × 874 reference, 440 × 956 check; 24 gutter; flexbox only." />
        <Bullets items={guide.layout} />
        {guide.space.map((p) => <Para key={p}>{p}</Para>)}
      </SectionBox>
      <SectionBox>
        <Heading title="Surfaces and elevation" />
        <Bullets items={guide.shape} />
        <Bullets items={guide.glass} />
      </SectionBox>
      <SectionBox>
        <Heading title="Motion" />
        <MotionReplay reduceMotion={reduceMotion} />
        <Bullets items={guide.motion} />
        <Para>{guide.motionVoice[0]}</Para>
      </SectionBox>
      <SectionBox>
        <Heading title="Art and icons" />
        {guide.art.map((p) => <Para key={p}>{p}</Para>)}
        <View>
          {(Object.keys(icons) as IconName[]).map((name) => (
            <View key={name} style={s.dsRow}>
              <Icon name={name} size={L.icon.standard} color={t.color.ink} />
              <Txt role="meta" style={s.shrink}>{`${icons[name].lucide ?? name}${icons[name].use ? ` · ${icons[name].use}` : ''}`}</Txt>
            </View>
          ))}
        </View>
      </SectionBox>
      <SectionBox>
        <Heading title="Token additions" sub="Values added in the package, each used by the render." />
        <GuideTable table={guide.tokenAdditions} />
      </SectionBox>
    </>
  );
}

function ControlsDetail({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <>
      <DetailIntro />
      <SectionBox>
        <Heading title="Live controls" sub="The same components as the product screens, with local specimen state." />
        <LivePrimary />
        <LiveFields />
        <LiveChips reduceMotion={reduceMotion} />
        <LiveDays />
        <LivePrompts />
      </SectionBox>
    </>
  );
}

function FeedbackDetail({ open }: { open: (spec: SheetSpec) => void }) {
  return (
    <>
      <DetailIntro />
      <SectionBox>
        <Heading title="Live feedback" />
        <LiveNotice />
        <LiveRest />
        <LiveComposer />
        <LiveSheet open={open} />
      </SectionBox>
    </>
  );
}

function SystemSection() {
  return (
    <>
      <Heading title="Thesis" />
      <Para>{guide.thesis}</Para>
      {guide.idea.map((p) => <Para key={p}>{p}</Para>)}
      <View style={[mt('s8'), s.center]}><OpenMatArt variant="today" /></View>
      <SectionBox>
        <Heading title="Person and job" />
        {guide.person.map((p) => <Para key={p}>{p}</Para>)}
        {guide.primaryJob.map((p) => <Para key={p}>{p}</Para>)}
        {guide.emotionalTarget.map((p) => <Txt key={p} role="bodyStrong">{p}</Txt>)}
        <Bullets items={guide.earnAvoid} />
      </SectionBox>
      <SectionBox>
        <Heading title="Intake" />
        {guide.intake.map((p) => <Para key={p}>{p}</Para>)}
      </SectionBox>
      <SectionBox>
        <Heading title="Sources → decisions" sub="Observed conventions kept, deliberate decisions, and what was rejected. No reference pixels are copied." />
        <GuideTable table={guide.sources} />
      </SectionBox>
      <SectionBox>
        <Heading title="Patterns studied" sub="Page URLs only." />
        <GuideTable table={guide.references} />
      </SectionBox>
      <SectionBox>
        <Heading title="Conventions" />
        <Txt role="bodyStrong">Keep</Txt>
        <View style={s.tight}>{guide.conventions.keep.map((c) => <Mark key={c} ok>{c}</Mark>)}</View>
        <Txt role="bodyStrong">Break</Txt>
        <View style={s.tight}>{guide.conventions.break.map((c) => <Mark key={c} ok={false}>{c}</Mark>)}</View>
      </SectionBox>
      <SectionBox>
        <Heading title="Do and don’t" />
        <Bullets items={guide.doDont} />
        <Heading title="Do not change" />
        <Bullets items={guide.doNotChange} />
      </SectionBox>
      <SectionBox>
        <Heading title="Deliberate refinements" sub="Where the rendered package refines the system contract, with reasons." />
        <Bullets items={guide.refinements} />
      </SectionBox>
    </>
  );
}

function ComponentSpecimen({ id, reduceMotion, open }: { id: string; reduceMotion: boolean; open: (spec: SheetSpec) => void }) {
  const m = MOVES[0];
  switch (id) {
    case 'CMP-A01':
      return (
        <Spec name="Opaque tab bar fallback with selection pill (native glass is not installed)">
          <TabBar current="today" bottomInset={t.space.s0} onSelect={() => undefined} register={false} />
        </Spec>
      );
    case 'CMP-A02':
      return (
        <Spec name="Nav row with trailing meta, then page title 16 below">
          <View style={s.bleed}>
            <NavRow title="Plan" trailing={<Txt role="meta" tone="secondary">Oct 5–11</Txt>} />
            <View style={s.gutter}><PageTitle text={'Your week,\nyour pace.'} /></View>
          </View>
        </Spec>
      );
    case 'CMP-A03':
      return <Spec name="Decorative; hidden from VoiceOver"><View style={s.artRow}><OpenMatArt variant="workout" /><OpenMatArt variant="small" /></View></Spec>;
    case 'CMP-A04':
      return (
        <>
          <Spec name="Default · pressed · focused · disabled · loading">
            <PrimaryAction label="Start 35-minute workout" />
            <PrimaryAction label="Start 35-minute workout" forced="pressed" />
            <PrimaryAction label="Confirm set" forced="focused" />
            <PrimaryAction label="Confirm set" disabled />
            <PrimaryAction label="Saving…" loading />
          </Spec>
          <LivePrimary />
        </>
      );
    case 'CMP-A05':
      return (
        <>
          <Spec name="Default · pressed · disabled · trailing nav">
            <PlainAction label="Only have 20 minutes?" />
            <PlainAction label="Keep going" chevron={null} forcedPressed />
            <PlainAction label="Undo change" chevron={null} disabled />
            <View style={s.bleed}><NavRow title="Workout" trailing={<PlainAction label="Finish" placement="trailing" chevron={null} />} /></View>
          </Spec>
          <LiveDisclosure />
        </>
      );
    case 'CMP-A06':
      return <LiveDays />;
    case 'CMP-A07':
      return (
        <Spec name="Full · short · active">
          <SessionSummary title="Full-body strength" meta={['35 minutes', '5 movements', '11 sets']} />
          <SessionSummary title="Full-body strength, short" meta={['20 minutes', '3 movements', '7 sets']} />
          <SessionSummary title="Full-body strength" meta={['35 minutes', '5 movements', '2 of 11 sets recorded']} />
        </Spec>
      );
    case 'CMP-A08':
      return (
        <Spec name="Numbered · long name wraps · recorded detail · compact (Coach proposal)">
          <View>
            <MovementRow move={MOVES[0]} variant="full" ord={1} />
            <MovementRow move={MOVES[3]} variant="full" ord={4} />
            <MovementRow move={MOVES[1]} variant="full" ord={2} detail="3 × 10 reps at 8 kg each" last />
          </View>
          <MovementRow move={MOVES[2]} variant="short" ord={3} compact />
        </Spec>
      );
    case 'CMP-A09':
      return (
        <>
          <Spec name="Default · focused · error · disabled">
            <View style={s.fieldsRow}>
              <NumericField kind="reps" label="Reps" value={m.defReps} state="default" moveName={m.name} register={false} />
              <NumericField kind="kg" label="Weight, kg" value={m.kg} state="focused" moveName={m.name} register={false} />
            </View>
            <View style={s.fieldsRow}>
              <NumericField kind="reps" label="Reps" value={0} state="error" moveName={m.name} register={false} />
              <NumericField kind="kg" label="Weight, kg" value={m.kg} state="disabled" moveName={m.name} register={false} />
            </View>
          </Spec>
          <LiveFields />
        </>
      );
    case 'CMP-A10':
      return <LiveChips reduceMotion={reduceMotion} />;
    case 'CMP-A11':
      return <Spec name="Instruction + last time"><Cue cue={m.cue} last={`Last time: ${m.defReps} reps at ${kgLabel(m, m.kg)}`} /></Spec>;
    case 'CMP-A12':
      return (
        <>
          <Spec name="Success · warning · error · info">
            <Notice kind="success" captureId={null} text="Workout saved." />
            <Notice kind="warning" captureId={null} text="2 sets recorded. 9 planned sets remain unrecorded." />
            <Notice kind="error" captureId={null} text="Couldn’t save on this device. Your sets are still here." />
            <Notice kind="info" captureId={null} text="Finish or save this workout before changing its plan." />
          </Spec>
          <LiveNotice />
        </>
      );
    case 'CMP-A13':
      return (
        <>
          <Spec name="Sheet anatomy: handle 36 × 5, title, Close 44, sections 24 apart">
            <SheetSpecimen title="Save what you did?">
              <Txt role="body" style={mt('s12')}>2 sets recorded. 9 planned sets remain unrecorded.</Txt>
              <SheetSection>
                <SheetRow left={<Txt role="body">Goblet squat, set 1</Txt>} right={<Txt role="bodyStrong">10 × 12 kg</Txt>} />
                <SheetRow last left={<Txt role="body">Goblet squat, set 2</Txt>} right={<Txt role="bodyStrong">10 × 12 kg</Txt>} />
              </SheetSection>
            </SheetSpecimen>
          </Spec>
          <LiveSheet open={open} />
        </>
      );
    case 'CMP-A14':
      return (
        <Spec name="Demo coach (unboxed, labelled) · user (selection bubble)">
          <View style={s.thread}>
            <ChatMessage from="coach" text={fixtures.seedLine} />
            <ChatMessage from="user" text="Why these movements?" />
          </View>
        </Spec>
      );
    case 'CMP-A15':
      return (
        <>
          <Spec name="Default · pressed · selected">
            <View style={s.wrapRow12}>
              <PromptChoice label="I have 20 minutes" />
              <PromptChoice label="I have 20 minutes" forcedPressed />
              <PromptChoice label="Why these movements?" selected />
            </View>
          </Spec>
          <LivePrompts />
        </>
      );
    case 'CMP-A16':
      return <LiveComposer />;
    case 'CMP-A17':
      return (
        <>
          <LiveChart />
          <Spec name="Zero state: value, baseline and date only (no empty bar band)">
            <WeeklyChart counts={[0, 0, 0, 0]} selected={fixtures.thisWeek} register={false} />
          </Spec>
        </>
      );
    case 'CMP-A18':
      return (
        <Spec name="Complete · partial">
          <View>
            <HistoryRow record={{ id: 'w8', day: 'Mon, Oct 5', min: 31, sets: 11, week: 3 }} register={false} />
            <HistoryRow record={{ id: 'w9', day: 'Wed, Oct 7', min: 18, sets: 2, week: 3, partial: true }} register={false} />
          </View>
        </Spec>
      );
    case 'CMP-A19':
      return <LiveRest />;
    case 'CMP-A20':
      return (
        <Spec name="Empty · error with retry · loading skeleton">
          <EmptyBlock title="No recorded workouts yet." body="Confirm a set during a workout and save it here." action="Go to workout" />
          <ErrorBlock />
          <LoadingSkeleton />
        </Spec>
      );
    default:
      return null;
  }
}

function ComponentsSection({ reduceMotion, open }: { reduceMotion: boolean; open: (spec: SheetSpec) => void }) {
  return (
    <>
      <Para>Every reusable component, its anatomy, its states and a specimen rendered by the same code as the five product screens.</Para>
      {guide.components.map((c) => (
        <SectionBox key={c.id}>
          <Heading title={`${c.id} ${c.name}`} sub={c.shown} />
          {c.anatomy ? <Txt role="meta">{`Anatomy: ${c.anatomy}`}</Txt> : null}
          {c.states ? <Txt role="meta">{`States and semantics: ${c.states}`}</Txt> : null}
          {c.variants.length ? <Txt role="meta" tone="secondary">{`Variants: ${c.variants.join(' · ')}`}</Txt> : null}
          <Txt role="meta" tone="secondary">{`Tokens: ${c.keyTokens}`}</Txt>
          <ComponentSpecimen id={c.id} reduceMotion={reduceMotion} open={open} />
        </SectionBox>
      ))}
    </>
  );
}

const PLATFORM_NOTES: readonly string[] = [
  'Tab bar: opaque color.surface fallback (the package’s Reduce Transparency appearance). No glass module is installed, so native Regular glass is not shown.',
  'Sheets: an in-tree modal layer with grabber, labelled Close, scrim tap, swipe-down and VoiceOver escape; not UIKit sheet presentation.',
  'Status bar, island and home indicator: drawn by the OS natively; the web preview draws the mockup’s simulated chrome.',
  'Icons: the package’s Lucide 1.34.0 SVG nodes rendered with react-native-svg (lucide-react-native is not installed).',
  'Dynamic Type: React Native’s uniform text scale with the display cap; the large-text layout switches at text scale ×2.0.',
  'Haptics: optional light impact on confirm, apply and save; selection on day change (expo-haptics, native only).',
  'Data: fixed fictional fixtures and a canned local Demo coach. Nothing is saved beyond this session or sent anywhere.',
];

function PagesSection() {
  return (
    <>
      <Heading title="Page purposes" />
      <GuideTable table={guide.pageJobs} />
      <SectionBox>
        <Heading title="Flow" sub="Five tab roots, four presented sheets, no pushed screens." />
        <Bullets items={guide.flowEntry} />
        <GuideTable table={guide.flowScreens} />
        <GuideTable table={guide.flowSheets} />
        <Bullets items={guide.transitions} />
      </SectionBox>
      <SectionBox>
        <Heading title="State coverage" sub="Declared reference states per screen and text size." />
        {guide.screens.map((sc) => (
          <View key={sc.id} style={s.tableRow}>
            <Txt role="bodyStrong">{sc.id}</Txt>
            <Txt role="meta" tone="secondary">{`States: ${sc.states.join(', ')} · text sizes: ${sc.textSizes.join(', ')}`}</Txt>
          </View>
        ))}
        {guide.stateCoverage.map((p) => <Para key={p}>{p}</Para>)}
        <Bullets items={guide.stateRules} />
      </SectionBox>
      <SectionBox>
        <Heading title="Interactions" sub="Trigger → effect, with motion, haptic and Reduce Motion behaviour." />
        {guide.interactions.map((i) => (
          <View key={i.id} style={s.tableRow}>
            <Txt role="bodyStrong">{i.id}</Txt>
            <Txt role="meta">{`${i.trigger} → ${i.effect}`}</Txt>
            <Txt role="meta" tone="secondary">{`Motion ${i.motion} · haptic ${i.haptic} · Reduce Motion ${i.reduceMotion}`}</Txt>
          </View>
        ))}
      </SectionBox>
      <SectionBox>
        <Heading title="Edge cases" />
        <Bullets items={guide.edgeCases} />
      </SectionBox>
      <SectionBox>
        <Heading title="Accessibility" />
        {guide.accessibility.map((p) => <Para key={p}>{p}</Para>)}
        <Bullets items={guide.platformRules} />
        <Heading title="Stable identifiers" />
        <Bullets items={guide.evidenceIds} />
      </SectionBox>
      <SectionBox>
        <Heading title="Native intent" sub="What the HTML mockup could not show, as handed off." />
        <Bullets items={guide.intentNotInMockup} />
      </SectionBox>
      <SectionBox>
        <Heading title="This React Native build" sub="Platform mapping within installed dependencies." />
        <Bullets items={PLATFORM_NOTES} />
      </SectionBox>
    </>
  );
}

/* ---------------- showcase root ---------------- */

export function Showcase({ initialSection, topInset, bottomInset, reduceMotion }: {
  initialSection?: string; topInset: number; bottomInset: number; reduceMotion: boolean;
}) {
  const [section, setSection] = useState<SectionKey>(isSection(initialSection) ? initialSection : 'color');
  const [sheet, setSheet] = useState<SheetSpec | null>(null);
  const closer = useRef<SheetClose | null>(null);
  const scroll = useRef<ScrollView | null>(null);
  const pageId = `a-ds-${section}`;
  const pageRef = useCapture(pageId);
  const choose = (key: SectionKey) => {
    setSection(key);
    scroll.current?.scrollTo({ y: 0, animated: false });
  };
  const open = (spec: SheetSpec) => setSheet(spec);
  return (
    <View style={s.fill}>
      <ScrollView ref={scroll} style={[s.fill, { marginBottom: bottomInset }]} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View ref={pageRef} testID={pageId} style={s.page}>
          <NavRow title="Open Mat system" trailing={<Txt role="meta" tone="secondary">v1 specimen</Txt>} />
          <View style={[s.gutter, s.pageStack]}>
            <PageTitle text={TITLES[section]} />
            {section === 'color' ? <><ColorReference /><ColorDetail /></> : null}
            {section === 'type' ? <><TypeReference /><TypeDetail /></> : null}
            {section === 'controls' ? <><ControlsReference /><ControlsDetail reduceMotion={reduceMotion} /></> : null}
            {section === 'feedback' ? <><FeedbackReference /><FeedbackDetail open={open} /></> : null}
            {section === 'data' ? <><DataReference /><DataDetail reduceMotion={reduceMotion} /></> : null}
            {section === 'system' ? <SystemSection /> : null}
            {section === 'components' ? <ComponentsSection reduceMotion={reduceMotion} open={open} /> : null}
            {section === 'pages' ? <PagesSection /> : null}
            <SectionBox>
              <Heading title="Design system sections" sub={`Package ${guide.package.id} v${guide.package.version} (${guide.package.status}).`} />
              <View style={s.wrapRow12}>
                {ORDER.map((key) => <PromptChoice key={key} label={TITLES[key]} selected={key === section} onPress={() => choose(key)} />)}
              </View>
            </SectionBox>
          </View>
          <View style={s.scrollPad} />
        </View>
      </ScrollView>
      {sheet ? (
        <SheetLayer key={sheet.id} spec={sheet} topInset={topInset} bottomInset={bottomInset} reduceMotion={reduceMotion}
          onDismiss={() => setSheet(null)} closeRef={closer} />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  page: { paddingTop: L.frame.navGap },
  pageStack: { gap: t.space.s16 },
  gutter: { paddingHorizontal: L.frame.gutter },
  bleed: { marginHorizontal: -L.frame.gutter },
  scrollPad: { height: L.frame.scrollBottomGap },
  center: { alignItems: 'center' },
  shrink: { flexShrink: 1 },
  spec: { gap: t.space.s8 },
  heading: { gap: t.space.s4 },
  sectionBox: { marginTop: L.showcase.sectionGap, gap: L.showcase.specimenGap },
  swatch: {
    width: L.showcase.swatchSize, height: L.showcase.swatchSize, borderRadius: t.radius.small, borderCurve: 'continuous',
    borderWidth: t.stroke.divider, borderColor: t.color.line, flexShrink: 0,
  },
  swatchList: { gap: L.showcase.swatchGap },
  dsRow: { flexDirection: 'row', alignItems: 'center', gap: L.showcase.swatchGap },
  tight: { gap: t.space.s4 },
  tight8: { gap: t.space.s8 },
  markRow: { flexDirection: 'row', alignItems: 'center', gap: t.space.s8 },
  ladder: { gap: t.space.s16 },
  wrapRow24: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.s24 },
  wrapRow12: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.s12 },
  promptRow: { gap: L.prompt.gap, alignItems: 'flex-start' },
  fieldsRow: { flexDirection: 'row', gap: L.field.pairGap },
  thread: { gap: L.message.gap },
  spaceLabel: { width: L.showcase.sectionGap },
  spacebar: { height: L.showcase.spaceBarHeight, backgroundColor: t.color.chart, borderRadius: t.radius.none },
  iconRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.s16 },
  bullets: { gap: t.space.s8 },
  bulletRow: { flexDirection: 'row', gap: t.space.s8 },
  tableRow: { gap: t.space.s4, paddingVertical: t.space.s12, borderBottomWidth: t.stroke.divider, borderBottomColor: t.color.line },
  tableRowLast: { borderBottomWidth: 0 },
  detailRule: { marginTop: L.showcase.sectionGap, paddingTop: t.space.s16, borderTopWidth: t.stroke.divider, borderTopColor: t.color.line },
  contrastChip: {
    width: L.showcase.swatchSize, height: L.showcase.swatchSize, borderRadius: t.radius.small, borderCurve: 'continuous',
    borderWidth: t.stroke.divider, borderColor: t.color.line, alignItems: 'center', justifyContent: 'center',
  },
  artRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: t.space.s16 },
  motionRow: { flexDirection: 'row', alignItems: 'center', gap: t.space.s16 },
  motionChip: {
    minHeight: L.setChips.target, paddingHorizontal: t.space.s16, borderRadius: t.radius.chip, borderCurve: 'continuous',
    flexDirection: 'row', alignItems: 'center', gap: t.space.s4, backgroundColor: t.color.successSurface,
  },
});
