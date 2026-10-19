// Club Circuit design system and live component catalogue. Every specimen is the
// production component, driven by the same reducer and fixtures as the five pages;
// guide prose is generated from the sealed package (generatedguide.ts).
import React, { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  Chart, Composer, ConversationTurn, Counts, Disclosure, Dock, Heading, Icon, IconButton, Notice, NumericEntry, OutlineAction, PrimaryButton,
  Rail, Segment, SessionBoard, SetRow, StatusLabel, Summary, TABS, TabBar, TextAction, TrainingRow, WeekRow,
} from './components';
import { CoachProposal, ExerciseSummaryList, PAGES, planReviewSheet, type Api } from './screens';
import { SheetPanel } from './sheet';
import { EnvProvider, dividerColor, t, Txt, useEnv, type TypeRole } from './theme';
import { guide } from './generatedguide';
import { icons, type IconName } from './generatedicons';
import { fixtures as FX } from './generatedfixtures';
import {
  COPY, canStep, captureWorkout, chartMax, currentExercise, dayInfo, exerciseById, initialState, isConfirmed, longDate, plural, preset, presc,
  recordsFor, reducer, sessionById, sets, weeklySummary, PRESETS, type Action, type State, type StatusText,
} from './model';

type Table = { columns: readonly string[]; rows: readonly (readonly string[])[] };

function useLive(make: () => State): [State, Api] {
  const [state, setState] = useState(make);
  const act = (action: Action) => setState((prev) => reducer(prev, action));
  return [state, { act, go: () => undefined }];
}

function tokenValue(path: string): string {
  let node: unknown = t;
  for (const key of path.split('.')) node = (node as Record<string, unknown>)[key];
  return String(node);
}

// ---------- documentation building blocks ----------
function Group({ code, title, anatomy, children }: { code: string; title: string; anatomy?: string; children: ReactNode }) {
  return (
    <View style={s.group}>
      <View style={s.groupHead}>
        <Txt type="support" tone="secondary">{code}</Txt>
        <Txt type="sectionTitle" accessibilityRole="header">{title}</Txt>
        {anatomy ? <Txt type="support" tone="secondary">{anatomy}</Txt> : null}
      </View>
      {children}
    </View>
  );
}
function Spec({ label, children }: { label: string; children: ReactNode }) {
  return <View style={s.spec}><Txt type="caption" tone="secondary">{label}</Txt>{children}</View>;
}
function Paras({ items }: { items: readonly string[] }) {
  return <View style={s.spec}>{items.map((p) => <Txt key={p} type="body">{p}</Txt>)}</View>;
}
function Bullets({ items }: { items: readonly string[] }) {
  return <View style={s.spec}>{items.map((p) => <Txt key={p} type="support">• {p}</Txt>)}</View>;
}
function DocTable({ table }: { table: Table }) {
  const env = useEnv();
  return (
    <View style={[s.table, { borderTopColor: dividerColor(env) }]}>
      {table.rows.map((row) => (
        <View key={row.join('|')} style={[s.tableRow, { borderBottomColor: dividerColor(env) }]}>
          <Txt type="bodyStrong">{row[0]}</Txt>
          {row.slice(1).map((cell, i) => (cell ? <Txt key={i} type="support"><Txt type="support" tone="secondary">{table.columns[i + 1]}: </Txt>{cell}</Txt> : null))}
        </View>
      ))}
    </View>
  );
}
function Frame({ children }: { children: ReactNode }) {
  const env = useEnv();
  return <View style={[s.frame, { borderColor: dividerColor(env) }]}>{children}</View>;
}

// ---------- foundations ----------
const TYPE_SAMPLES: Partial<Record<TypeRole, string>> = {
  display: 'Full-body strength', pageTitle: 'Today', sectionTitle: 'Your training week', station: '01 02 03 04 05', metric: '11', number: '10',
  rowTitle: 'Supported dumbbell row', body: 'Keep your whole foot on the floor. Stand tall between reps.', bodyStrong: 'Set 2 of 3',
  support: '3 sets of 8–10 reps', control: 'Confirm set', caption: '0 / 40 sets', tab: 'Today  Plan  Workout  Coach  Progress',
};

function Swatches() {
  const groups = Object.entries(t.color).filter(([group]) => group !== 'device');
  return (
    <>
      {groups.map(([group, values]) => (
        <Spec key={group} label={`color.${group}`}>
          <View style={s.swatches}>
            {Object.entries(values).map(([name, value]) => (
              <View key={name} style={s.swatch}>
                <View style={[s.chip, { backgroundColor: value }]} />
                <Txt type="caption">{name}</Txt>
                <Txt type="caption" tone="secondary">{value}</Txt>
              </View>
            ))}
          </View>
        </Spec>
      ))}
    </>
  );
}

function ContrastPairs() {
  return (
    <View style={s.spec}>
      {guide.contrast.map((pair) => (
        <View key={`${pair.fg}/${pair.bg}`} style={[s.contrast, { backgroundColor: tokenValue(pair.bg) }]}>
          <Txt type="bodyStrong" style={{ color: tokenValue(pair.fg) }}>Aa {pair.ratio}:1</Txt>
          <Txt type="caption" style={[s.shrink, { color: tokenValue(pair.fg) }]}>{pair.fg} on {pair.bg} · minimum {pair.min}:1</Txt>
        </View>
      ))}
    </View>
  );
}

function TypeLadder() {
  const ax = t.dynamicType.accessibilityLarge as Record<string, { fontSize: number; lineHeight: number }>;
  return (
    <>
      {guide.typeRoles.map((row) => {
        const role = row.token as TypeRole;
        const large = ax[role];
        return (
          <Spec key={role} label={`type.${role} · ${row.face} · ${row.scale} pt · ${row.dynamicType}${large ? ` · AX2 ${large.fontSize}/${large.lineHeight}` : ''} — ${row.use}`}>
            <Txt type={role}>{TYPE_SAMPLES[role] ?? role}</Txt>
          </Spec>
        );
      })}
      <Spec label="type.wordmark (specimen and gallery header only)"><Txt type="wordmark">form</Txt></Spec>
    </>
  );
}

function SpaceScale() {
  return (
    <View style={s.spec}>
      {Object.entries(t.space).map(([name, value]) => (
        <View key={name} style={s.measureRow}>
          <Txt type="caption" style={s.measureLabel}>space.{name} {value}</Txt>
          {value ? <View style={[s.bar, { width: value }]} /> : null}
        </View>
      ))}
    </View>
  );
}

function Geometry() {
  const groups = ['screen', 'rail', 'board', 'button', 'tabBar', 'dock', 'sheet', 'chart'] as const;
  return (
    <>
      <Spec label="radius">
        <View style={s.swatches}>
          {Object.entries(t.radius).map(([name, value]) => (
            <View key={name} style={s.swatch}>
              <View style={[s.radiusBox, { borderRadius: value }]} />
              <Txt type="caption">radius.{name} {value}</Txt>
            </View>
          ))}
        </View>
      </Spec>
      <Spec label="stroke">
        {Object.entries(t.stroke).map(([name, value]) => (
          <View key={name} style={s.measureRow}>
            <Txt type="caption" style={s.measureLabel}>stroke.{name} {value}</Txt>
            <View style={[s.strokeBar, { height: value }]} />
          </View>
        ))}
      </Spec>
      {groups.map((group) => (
        <Spec key={group} label={`layout.${group}`}>
          <Txt type="support">{Object.entries(t.layout[group]).map(([k, v]) => `${k} ${v}`).join(' · ')}</Txt>
        </Spec>
      ))}
    </>
  );
}

function IconGrid() {
  return (
    <View style={s.swatches}>
      {(Object.keys(icons) as IconName[]).map((name) => (
        <View key={name} style={s.swatch} accessible accessibilityLabel={`${name} icon, SF Symbol ${icons[name].sfSymbol}`}>
          <Icon name={name} size={t.layout.icon.control} />
          <Txt type="caption">{name}</Txt>
          <Txt type="caption" tone="secondary">{icons[name].sfSymbol}</Txt>
          {icons[name].label ? <Txt type="caption" tone="secondary">“{icons[name].label}”</Txt> : null}
        </View>
      ))}
    </View>
  );
}

// ---------- showcase ----------
export function Showcase({ bottomInset }: { bottomInset: number }) {
  const env = useEnv();
  const [live, liveApi] = useLive(() => captureWorkout(initialState('workout')));
  const [coachLive, coachApi] = useLive(() => initialState('coach'));
  const [planLive, planApi] = useLive(() => preset('plan', 'move-sheet') ?? initialState('plan'));
  const [composer, setComposer] = useState('');
  const [filingRun, setFilingRun] = useState(0);
  const [pressCount, setPressCount] = useState(0);

  const squat = exerciseById('goblet-squat');
  const day = (date: string, st?: State) => dayInfo(st ?? initialState(), date);
  const recorded = preset('today', 'recorded')!;
  const monday = sessionById(initialState(), FX.schedule[0].sessionId)!;
  const moved = preset('plan', 'moved')!;
  const partial = preset('workout', 'partial-summary')!.finished!;
  const full = preset('workout', 'recorded-summary')!.finished!;
  const w = live.workout, cur = currentExercise(live);
  const currentDone = isConfirmed(live, cur.id, w.setNumber);
  const metric = live.progress.metric;

  const setRows = Array.from({ length: cur.sets }, (_, i) => i + 1).map((k) => {
    const rec = recordsFor(live, cur.id).find((x) => x.setNumber === k);
    const isCur = k === w.setNumber && !rec;
    const status: StatusText = rec ? { tone: 'recorded', icon: 'check', text: 'Recorded' } : isCur ? { tone: 'current', text: 'Current' } : { tone: 'plain', text: 'Not recorded' };
    return <SetRow key={k} ordinal={k} current={isCur} status={status} title={rec ? `${rec.repetitions} reps × ${rec.loadKg} kg` : `Target ${cur.targetRepsMin}–${cur.targetRepsMax} reps`}
      valuesType={rec ? 'rowTitle' : 'body'} valuesTone={rec ? 'primary' : 'secondary'} ariaLabel={`Set ${k}, ${rec ? 'recorded' : isCur ? 'current' : 'not recorded'}`} />;
  });

  const coachSheet = coachLive.sheet?.kind === 'plan-review' ? planReviewSheet(coachApi, false) : null;
  const moveSheet = PAGES.plan(planLive, planApi).sheet;

  const specimens: Record<string, [string, ReactNode][]> = {
    'CMP-01': [
      ...TABS.map((tab): [string, ReactNode] => [`Selected: ${tab.label}`, <Frame key={tab.id}><TabBar current={tab.id} tabIds={false} bottomInset={t.layout.tabBar.topPadding} /></Frame>]),
      ['Action dock (contributes its own height above the tabs)', <Frame key="dock"><Dock><PrimaryButton label="Confirm set" /></Dock></Frame>],
    ],
    'CMP-02': [
      ['Plain', <Heading key="a" title="Your training week" />],
      ['With description', <Heading key="b" title="Three days for strength" desc="Space between sessions is part of this sample week." />],
      ['With action', <Heading key="c" title="Wednesday's workout" action={<TextAction label="Move session" align="center" />} />],
      ['Long heading', <Heading key="d" title="Supported single-arm dumbbell row with a bench" />],
    ],
    'CMP-03': [
      ['Board rail: filled, 2 pt leading rule, L-mark', <View key="b" style={s.railDemo}><Rail num={1} board mark /></View>],
      ['Planned', <TrainingRow key="p" num={2} title="Dumbbell floor press" prescription={presc(exerciseById('floor-press'))} />],
      ['Current (2 pt ink outline + word)', <TrainingRow key="c" num={1} current title="Goblet squat" prescription={presc(squat)} status={{ tone: 'current', text: 'Current' }} />],
      ['Partial', <TrainingRow key="pa" num={1} title="Goblet squat" prescription={presc(squat)} status={{ tone: 'plain', text: '1 of 3 sets recorded' }} />],
      ['Recorded', <TrainingRow key="r" num={1} title="Goblet squat" prescription={presc(squat)} status={{ tone: 'recorded', icon: 'check', text: '3 sets recorded' }} />],
    ],
    'CMP-04': [
      ['Planned', <SessionBoard key="1" num={1} label="Your next workout" minutes={35} title="Full-body strength" counts={['5 exercises', '11 planned sets']} action={<PrimaryButton label="Review workout" />} />],
      ['Shorter plan applied', <SessionBoard key="2" num={1} label="Your next workout" minutes={20} title="Full-body strength" counts={['3 exercises', '7 planned sets']} status={{ tone: 'current', text: 'Shorter plan applied' }} action={<PrimaryButton label="Review workout" />} />],
      ['In progress', <SessionBoard key="3" num={1} label="Workout in progress" minutes={35} title="Full-body strength" counts={['1 set recorded', '11 planned sets']} action={<PrimaryButton label="Continue workout" />} />],
      ['Finished (partial)', <SessionBoard key="4" num={1} label="Partial workout recorded" minutes={35} title="Full-body strength" counts={[`${sets(recorded.finished!.confirmedSets.length)} recorded`]} action={<PrimaryButton label="Review your session" />} />],
      ['Empty', <SessionBoard key="5" label="Today" titleType="sectionTitle" title="No workout planned for today." note="You can choose a session from your week." action={<PrimaryButton label="View plan" />} />],
      ['Loading example', <SessionBoard key="6" kind="loading" num={1} action={<PrimaryButton label="Review workout" disabled />} />],
      ['Error example', <SessionBoard key="7" kind="error" label="Today" titleType="sectionTitle" title="Your plan did not load." action={<PrimaryButton label="Try again" />} />],
      ['Long title', <SessionBoard key="8" num={1} label="Your next workout" minutes={35} title="Full-body strength with a supported single-arm row" counts={['5 exercises', '11 planned sets']} action={<PrimaryButton label="Review workout" />} />],
    ],
    'CMP-05': [
      ['Upcoming', <TrainingRow key="u" num={4} title="Dumbbell hinge" prescription={presc(exerciseById('dumbbell-hinge'))} />],
      ['Omitted by shorter plan (proposal only)', <TrainingRow key="o" num={5} title="Standing calf raise" prescription="Not in this session" />],
      ['Long name', <TrainingRow key="l" num={3} title={FX.longTextFixture.exerciseName} prescription={presc(exerciseById('supported-row'))} />],
      ['Compact on the field surface (proposal, recorded sets)', <View key="c" style={s.fieldDemo}><TrainingRow num={1} title="Goblet squat" trailing="3 sets" compact onField /></View>],
    ],
    'CMP-06': [
      [`Default — press to see the pressed fill (pressed ${pressCount} times)`, <PrimaryButton key="d" label="Review workout" onPress={() => setPressCount((n) => n + 1)} />],
      ['Disabled with reason', <View key="x" style={s.spec}><PrimaryButton label="Move session" disabled reason="Choose a day." /></View>],
      ['Long label wraps', <PrimaryButton key="l" label="Finish and keep 2 sets from this partial workout" />],
    ],
    'CMP-07': [
      ['Text action', <TextAction key="t" label="Move session" />],
      ['Text action with icon', <TextAction key="u" label="Undo move" icon="undo" />],
      ['Outline', <OutlineAction key="o" label="Keep current plan" full />],
      ['Icon only (label: Close)', <IconButton key="i" icon="close" label="Close" />],
    ],
    'CMP-08': [
      ['Recorded', <WeekRow key="r" info={day('2026-09-28')} onPress={() => undefined} />],
      ['Selected today', <WeekRow key="s" info={day('2026-09-30')} selected selectable onPress={() => undefined} />],
      ['Planned', <WeekRow key="p" info={day('2026-10-02')} onPress={() => undefined} />],
      ['Rest day (compact, R20)', <WeekRow key="rest" info={day('2026-09-29')} />],
      ['Moved session (Thursday)', <WeekRow key="m" info={day('2026-10-01', moved)} selected selectable onPress={() => undefined} />],
    ],
    'CMP-09': [
      ['Live: Sets / Sessions (drives CMP-16 below)', <Segment key="seg" label="Measure" selected={metric} onSelect={(value) => liveApi.act({ type: 'set-metric', metric: value })}
        items={[{ value: 'sets', label: 'Sets' }, { value: 'sessions', label: 'Sessions' }]} />],
    ],
    'CMP-10': [
      ['Live: editable values; steppers and Confirm set work; Undo returns the values', currentDone ? (
        <View key="done" style={s.spec}>
          <Notice tone="recorded" title={`Set ${w.setNumber} recorded.`} body="Undo returns its values to the fields."
            action={<TextAction label="Undo set" icon="undo" onPress={() => liveApi.act({ type: 'undo-set' })} />} />
          <PrimaryButton label={w.setNumber < cur.sets ? 'Next set' : 'Next exercise'} onPress={() => liveApi.act({ type: 'next' })} />
        </View>
      ) : (
        <View key="entry" style={s.spec}>
          <View style={s.entry}>
            <NumericEntry label="Repetitions" hint={`Target ${cur.targetRepsMin}–${cur.targetRepsMax} reps`} value={w.draft.reps} unit="reps" id="sc.reps"
              decLabel="Decrease repetitions" incLabel="Increase repetitions" canDec={canStep(live, 'reps', -t.dataVisual.repStep)} canInc={canStep(live, 'reps', t.dataVisual.repStep)}
              error={w.errors.reps} keyboard="number-pad" step={t.dataVisual.repStep}
              onChange={(value) => liveApi.act({ type: 'edit', field: 'reps', value })} onStep={(delta) => liveApi.act({ type: 'step', field: 'reps', delta })} />
            <NumericEntry label="Weight" hint={cur.loadLabel} value={w.draft.kg} unit="kg" id="sc.kg"
              decLabel="Decrease weight" incLabel="Increase weight" canDec={canStep(live, 'kg', -t.dataVisual.loadStepKg)} canInc={canStep(live, 'kg', t.dataVisual.loadStepKg)}
              error={w.errors.kg} keyboard="decimal-pad" step={t.dataVisual.loadStepKg}
              onChange={(value) => liveApi.act({ type: 'edit', field: 'kg', value })} onStep={(delta) => liveApi.act({ type: 'step', field: 'kg', delta })} />
          </View>
          <PrimaryButton label="Confirm set" onPress={() => liveApi.act({ type: 'confirm-set' })} />
        </View>
      )],
      ['Invalid (0 repetitions): linked error, input preserved', <View key="bad" style={s.entry}>
        <NumericEntry label="Repetitions" hint="Target 8–10 reps" value="0" unit="reps" id="sc.bad" decLabel="Decrease repetitions" incLabel="Increase repetitions"
          canDec={false} canInc error="Enter 1–100 repetitions." keyboard="number-pad" step={t.dataVisual.repStep} />
      </View>],
    ],
    'CMP-11': [['Live: recorded / current / not recorded', <View key="sets">{setRows}</View>]],
    'CMP-12': [
      ['Live', <Disclosure key="live" summary="One cue for this set" content={cur.cue} open={w.cueOpen} onToggle={() => liveApi.act({ type: 'toggle-cue' })} />],
      ['Long cue, expanded', <Disclosure key="long" summary="One cue for this set" content={FX.longTextFixture.cue} open />],
    ],
    'CMP-13': [
      ['Live: review, apply, undo (nothing changes until Use this plan)', <View key="live" style={s.spec}>
        <CoachProposal state={coachLive} api={coachApi} ids={false} />
        {coachSheet ? <View style={s.sheetFrame}><SheetPanel spec={coachSheet} onClose={() => coachApi.act({ type: 'close-sheet' })} bottomInset={t.layout.screen.safeBottom} /></View> : null}
      </View>],
      ['Applied (Undo change)', <CoachProposal key="a" state={preset('coach', 'applied')!} api={coachApi} ids={false} />],
      ['Undone', <CoachProposal key="u" state={preset('coach', 'undone')!} api={coachApi} ids={false} />],
      ['Active-workout guard', <CoachProposal key="g" state={preset('coach', 'active-workout-guard')!} api={coachApi} ids={false} />],
    ],
    'CMP-14': [
      ['You', <ConversationTurn key="y" speaker="you" text="I have 20 minutes today." />],
      ['Form coach', <ConversationTurn key="c" speaker="coach" text={COPY.coachExplain} />],
      ['Long message', <ConversationTurn key="l" speaker="you" text={FX.longTextFixture.message} />],
      ['Sample reply pending', <ConversationTurn key="p" speaker="coach" text="Preparing the sample reply…" pending />],
    ],
    'CMP-15': [
      ['Live: Send is disabled for whitespace only', <Composer key="live" value={composer} onChange={setComposer} onSend={() => setComposer('')} inputId="sc.composer" sendId="sc.send" />],
      ['Entered', <Composer key="e" value="Why these exercises?" inputId="sc.composer.entered" sendId="sc.send.entered" />],
    ],
    'CMP-16': [
      ['Live: tap a week; switch Sets / Sessions above', <Chart key="c" weeks={weeklySummary(live)} metric={metric} selected={live.progress.week} max={chartMax(metric)} unit={metric}
        id="sc.chart" rowIds={false} onSelect={(week) => liveApi.act({ type: 'select-week', week })} />],
    ],
    'CMP-17': [
      ['Recorded with Undo', <Notice key="r" tone="recorded" title="Set 2 recorded." body="10 reps × 12 kg" action={<TextAction label="Undo set" icon="undo" />} />],
      ['Moved with Undo', <Notice key="m" tone="recorded" title="Session moved to Thursday." action={<TextAction label="Undo move" icon="undo" />} />],
      ['Attention', <Notice key="a" tone="attention" title="Finish the active workout before moving this session." />],
      ['Error', <Notice key="e" tone="error" title="The set was not recorded. Try again." body="Your values are still in the fields." />],
      ['Info', <Notice key="i" title="Original 35-minute plan restored." />],
    ],
    'CMP-18': [
      ['Live: move session — choose a day, move, undo, or dismiss with Close / Cancel', <View key="move" style={s.spec}>
        {moveSheet ? <View style={s.sheetFrame}><SheetPanel spec={moveSheet} onClose={() => planApi.act({ type: 'close-sheet' })} bottomInset={t.layout.screen.safeBottom} /></View> : (
          <View style={s.spec}>
            {planLive.notice.plan?.kind === 'moved' ? <Notice tone="recorded" title="Session moved to Thursday." action={<TextAction label="Undo move" icon="undo" onPress={() => planApi.act({ type: 'undo-move' })} />} /> : null}
            <Txt type="support" tone="secondary">Sheet dismissed. The week is {planLive.pendingDate === FX.activeDate ? 'unchanged' : 'updated'}.</Txt>
            <TextAction label="Move session" onPress={() => planApi.act({ type: 'open-move' })} />
          </View>
        )}
      </View>],
      ['Recorded session detail', <View key="rec" style={s.sheetFrame}>
        <SheetPanel spec={{ id: 'sc.sheet.recorded', closeId: 'sc.sheet.recorded.close', title: longDate(monday.date), body: (
          <><Txt type="rowTitle">{monday.name}</Txt><Counts items={[plural(monday.confirmedSets.length, 'set recorded', 'sets recorded')]} /><ExerciseSummaryList session={monday} /></>
        ) }} onClose={() => undefined} bottomInset={t.layout.screen.safeBottom} />
      </View>],
    ],
    'CMP-19': [
      [`Partial (${partial.confirmedSets.length} of ${partial.plannedSetCount})`, <Summary key={`p${filingRun}`} title="Partial workout recorded" count={partial.confirmedSets.length}
        countLabel={partial.confirmedSets.length === 1 ? 'set recorded' : 'sets recorded'} note={`${plural(partial.plannedSetCount - partial.confirmedSets.length, 'planned set was', 'planned sets were')} not recorded.`} filing={filingRun > 0} />],
      [`Full (${full.confirmedSets.length} of ${full.plannedSetCount})`, <Summary key="f" title="Workout recorded" count={full.confirmedSets.length} countLabel="sets recorded" note="Every planned set is recorded." />],
      ['Filing motion (240 ms ease-out, 4 pt travel; Reduce Motion: 120 ms crossfade)', <OutlineAction key="replay" label="Replay filing" onPress={() => setFilingRun((n) => n + 1)} />],
      ['What you recorded', <ExerciseSummaryList key="list" session={partial} />],
    ],
  };

  const accessibilityEnv = { ...env, stacked: true, webLarge: true };
  return (
    <ScrollView style={s.fill} contentContainerStyle={[s.content, { paddingBottom: bottomInset + t.space.major }]} showsVerticalScrollIndicator={false}>
      <View style={s.intro}>
        <Txt type="wordmark">form</Txt>
        <Txt type="pageTitle" accessibilityRole="header">Club Circuit design system</Txt>
        <Txt type="body">Numbered stations give the workout a clear route; full-size instructions leave room to change the plan.</Txt>
        <Txt type="support" tone="secondary">{guide.package.id} v{guide.package.version} · {guide.package.status} · light appearance only. Every specimen is the production component used by the five screens.</Txt>
      </View>

      <Group code="Thesis" title="Purpose and thesis" anatomy={guide.thesis}>
        <Paras items={guide.idea} />
        <Spec label="Earn"><View style={s.chips}>{guide.earn.map((word) => <StatusLabel key={word} tone="recorded" text={word} />)}</View></Spec>
        <Spec label="Avoid"><View style={s.chips}>{guide.avoid.map((word) => <StatusLabel key={word} tone="attention" text={word} />)}</View></Spec>
        <Spec label="Emotional target"><Txt type="bodyStrong">“{guide.emotionalTarget}”</Txt></Spec>
      </Group>

      <Group code="Sources" title="Source-to-decision map" anatomy="What each reference contributed and what B deliberately left behind.">
        <DocTable table={guide.sources} />
        <Spec label="Conventions kept"><Bullets items={guide.conventions.keep} /></Spec>
        <Spec label="Conventions broken"><Bullets items={guide.conventions.break} /></Spec>
        <Spec label="Structural difference from the sibling directions"><DocTable table={guide.structure} /></Spec>
      </Group>

      <Group code="Identity" title="Signature: the station rail">
        <View style={s.railDemo}><Rail num={1} board mark /></View>
        <Paras items={guide.identity} />
        <Paras items={guide.signature} />
        <Spec label="Accessory removed"><Paras items={guide.accessoryRemoved} /></Spec>
      </Group>

      <Group code="Color" title="Semantic color and contrast" anatomy="One court-green atmosphere, ink type, one blue for the page's primary action. Light only.">
        <Swatches />
        <Spec label="Roles"><DocTable table={guide.colorRoles} /></Spec>
        <Spec label="Never combine"><Paras items={guide.colorRules} /></Spec>
        <Spec label={`Checked pairs (${guide.contrast.length}), measured on the package tokens`}><ContrastPairs /></Spec>
      </Group>

      <Group code="Type" title="Type scale" anatomy="Barlow Semi Condensed for titles and numerals; Atkinson Hyperlegible for reading and controls.">
        <TypeLadder />
        <Paras items={guide.typeRules} />
      </Group>

      <Group code="Space" title="Spacing, geometry and surfaces">
        <SpaceScale />
        <Geometry />
        <Paras items={guide.space} />
        <Paras items={guide.shape} />
      </Group>

      <Group code="Art" title="Icons and original art" anatomy={guide.iconAdapter}>
        <IconGrid />
        <Paras items={guide.art} />
      </Group>

      <Group code="Motion" title="Motion and feedback">
        <Paras items={guide.motion} />
        <Paras items={guide.motionMeasured} />
        <Spec label="motion tokens">
          <Txt type="support">{Object.entries(t.motion.duration).map(([k, v]) => `${k} ${v} ms`).join(' · ')}</Txt>
          <Txt type="support">easing.out [{t.motion.easing.out.join(', ')}] · spring dampingRatio {t.motion.spring.dampingRatio}, settle {t.motion.spring.settleDuration} ms · filing travel {t.motion.travel.filing}</Txt>
        </Spec>
        <Spec label="Interactions">
          <View style={s.spec}>
            {guide.interactions.map((it) => (
              <Txt key={it.id} type="support"><Txt type="support" tone="secondary">{it.id}: </Txt>{it.trigger} → {it.target}. Motion: {it.motion}. Haptic: {it.haptic}. Reduce Motion: {it.reduce_motion}.</Txt>
            ))}
          </View>
        </Spec>
      </Group>

      <Group code="Voice" title="Voice and copy">
        <DocTable table={guide.voice} />
        <Bullets items={guide.doDont} />
        <Paras items={guide.voiceRules} />
      </Group>

      <Group code="Accessibility" title="Accessibility adaptations">
        <Bullets items={guide.accessibility} />
        <Spec label="Accessibility-large (AX2) layout: rows stack, long names wrap, entry controls drop below their labels">
          <EnvProvider value={accessibilityEnv}>
            <TrainingRow num={3} title={FX.longTextFixture.exerciseName} prescription={presc(exerciseById('supported-row'))} status={{ tone: 'current', text: 'Current' }} />
            <WeekRow info={day('2026-09-30')} selected selectable onPress={() => undefined} />
          </EnvProvider>
        </Spec>
      </Group>

      {guide.components.map((c) => (
        <Group key={c.id} code={c.id} title={c.name} anatomy={c.notes[0]}>
          {c.notes.slice(1).map((note) => <Txt key={note} type="support" tone="secondary">{note}</Txt>)}
          {c.tables.map((table, i) => <DocTable key={i} table={table} />)}
          {Object.keys(c.variants).length ? (
            <Txt type="caption" tone="secondary">{Object.entries(c.variants).map(([k, v]) => `${k}: ${(v as readonly string[]).join(', ')}`).join(' · ')}</Txt>
          ) : null}
          {(specimens[c.id] ?? []).map(([label, node]) => <Spec key={label} label={label}>{node}</Spec>)}
        </Group>
      ))}

      <Group code="Pages" title="Page purposes and states">
        <DocTable table={guide.pageJobs} />
        <Bullets items={guide.pageIntent} />
        <DocTable table={guide.pageStates} />
        <Spec label="Declared states built from the fixture through real actions">
          {Object.entries(PRESETS).map(([page, states]) => <Txt key={page} type="support"><Txt type="support" tone="secondary">{page}: </Txt>{Object.keys(states).join(', ')}</Txt>)}
        </Spec>
        <Spec label="Transitions"><Bullets items={guide.transitions} /></Spec>
        <Spec label="Edge cases"><Bullets items={guide.edgeCases} /></Spec>
      </Group>

      <Group code="Revisions" title="System revisions and fixed decisions">
        <DocTable table={guide.revisions} />
        <Spec label="Do not change"><Bullets items={guide.doNotChange} /></Spec>
      </Group>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  shrink: { flexShrink: 1 },
  content: { paddingHorizontal: t.layout.screen.gutter, gap: t.space.xxl },
  intro: { paddingTop: t.layout.screen.contentTopGap, gap: t.layout.header.titleGap },
  group: { gap: t.space.base },
  groupHead: { gap: t.space.xs },
  spec: { gap: t.space.sm },
  entry: { gap: t.layout.entry.rowGap },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm },
  table: { borderTopWidth: t.stroke.divider },
  tableRow: { paddingVertical: t.space.sm, gap: t.space.xs, borderBottomWidth: t.stroke.divider },
  frame: { borderWidth: t.stroke.divider, borderRadius: t.radius.content, borderCurve: 'continuous', overflow: 'hidden' },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm },
  swatch: { width: t.layout.entry.valueCellWidth, gap: t.space.xs },
  chip: { height: t.layout.icon.hit, borderRadius: t.radius.status, borderWidth: t.stroke.divider, borderColor: t.color.border.divider },
  contrast: {
    flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: t.space.md, padding: t.layout.notice.padding,
    borderRadius: t.radius.content, borderWidth: t.stroke.divider, borderColor: t.color.border.divider,
  },
  measureRow: { flexDirection: 'row', alignItems: 'center', gap: t.space.md },
  measureLabel: { width: t.layout.loading.lineWidth },
  bar: { height: t.space.sm, backgroundColor: t.color.text.primary },
  strokeBar: { width: t.layout.chart.labelWidth, backgroundColor: t.color.text.primary },
  radiusBox: {
    width: t.layout.icon.hit, height: t.layout.icon.hit, borderWidth: t.stroke.control, borderColor: t.color.border.control,
    backgroundColor: t.color.surface.paper,
  },
  railDemo: { flexDirection: 'row', height: t.layout.board.minHeight, backgroundColor: t.color.surface.field, borderRadius: t.radius.content, overflow: 'hidden' },
  fieldDemo: { backgroundColor: t.color.surface.field, paddingHorizontal: t.layout.proposal.paddingHorizontal, borderRadius: t.radius.content },
  sheetFrame: { backgroundColor: t.color.overlay.scrim, paddingTop: t.space.major, borderRadius: t.radius.content, overflow: 'hidden' },
});

