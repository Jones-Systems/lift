// Onboarding: 8 questions + 2 evidence screens + injury check/pause + ready (form-onboarding v1).
// Every Continue PATCHes the server draft with expectedRevision; completion is an explicit keyed command.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import Reanimated, { Easing, useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { ApiError } from '../../api/client';
import { captureFirstPlanConfirmation, decodeFirstPlanReceipt, type FirstPlanReceipt } from '../../api/firstPlan';
import type { Account, Exercise, Onboarding, Plan, Preferences, Profile } from '../../api/domain';
import type { FormResources } from '../../api/resources';
import { easeOut, useAccessibilityPrefs } from '../../variants/a/theme';
import type { FirstPlanCommand, PlanDraft, SaveResult, SpeechPort } from '../contract';
import { guardedSave, useBusy, useCommandKey } from '../shared/commands';
import { COPY, errorCopy, movementWord } from '../shared/copy';
import { L, t } from '../shared/tokens';
import {
  Art, ChipChoice, ChipSet, ChoiceRow, Choices, Eyebrow, Fields, Gutter, MetaLine, Nav, Notice, Panel, PlainAction,
  Screen, Section, Segmented, Sheet, SourceNote, StepFooter, StepMeta, StepperField, Subtitle, TextAnswer, Title,
  ToggleRow, Txt,
} from '../shared/ui';
import {
  AREAS, CM_PER_IN, COACH_STYLES, DAYS, EQUIPMENT, EXPERIENCE, GOALS, KG_PER_LB, MAX_GOALS, MINUTES, TEXT_LIMITS,
  areasPhrase, coachStyleOf, hasInjuryDetail, parseInjury, resumeScreen, serializeInjury,
  type InjuryAnswer, type InjuryArea, type OnboardingScreen,
} from './model';
import { VoiceSheet } from './VoiceSheet';

type Answers = Partial<Omit<Profile, 'revision'>>;
type Prefs = Partial<Omit<Preferences, 'revision'>>;
type Patch = Pick<Onboarding, 'step'> & Partial<Pick<Onboarding, 'answers' | 'preferences'>>;
type Banner = { kind: 'error' | 'info'; text: string; retry?: () => void } | null;

/** DGR-013: the first stepper tap on an empty answer starts here. An untouched answer shows a dash and is never saved. */
const START = { age: 40, heightCm: 170, weightKg: 70 } as const;

const BACK_LABEL: Partial<Record<OnboardingScreen, string>> = {
  age: 'Name', body: 'Age', 'outcome-pain': 'Height', goals: 'Back', 'outcome-plans': 'Goals', experience: 'Back',
  injury: 'Training', 'injury-check': 'Injuries', 'injury-pause': 'Injuries', coach: 'Injuries', plan: 'Coach',
};

export function OnboardingFlow({ resources, account, speech, firstPlan, firstPlanCommand, isCurrentSession, notifications, onOpenSystemSettings, onAccount, onUnauthenticated, onDone }: {
  resources: FormResources;
  account: Account;
  speech: SpeechPort;
  firstPlan?: (account: Account, exercises: Exercise[]) => PlanDraft | null;
  firstPlanCommand?: FirstPlanCommand;
  isCurrentSession?: () => boolean;
  notifications?: { request(): Promise<'granted' | 'denied'> };
  onOpenSystemSettings?: () => void;
  onAccount: (account: Account) => void;
  onUnauthenticated: () => void;
  onDone: (plan: Plan | null) => void;
}) {
  const mounted = useRef(true);
  const original = useRef({ resources, accountId: account.accountId, firstPlanCommand, isCurrentSession });
  const latestScope = useRef(original.current);
  latestScope.current = { resources, accountId: account.accountId, firstPlanCommand, isCurrentSession };
  const expired = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = () => {
    const captured = original.current, latest = latestScope.current;
    if (!mounted.current || captured.resources !== latest.resources || captured.accountId !== latest.accountId ||
      captured.firstPlanCommand !== latest.firstPlanCommand || !(captured.isCurrentSession?.() ?? true)) expired.current = true;
    return !expired.current;
  };
  const firstReceipt = useRef<FirstPlanReceipt | null>(null);
  const [current, setCurrent] = useState<Onboarding>(account.onboarding);
  const [answers, setAnswers] = useState<Answers>(() => ({ name: account.profile.name || undefined, ...account.onboarding.answers }));
  const [prefs, setPrefs] = useState<Prefs>(() => ({ ...account.preferences, ...account.onboarding.preferences }));
  const [injury, setInjury] = useState<InjuryAnswer>(() => parseInjury(account.onboarding.answers.injuryHistory));
  const [experienceNote, setExperienceNote] = useState(() => account.onboarding.answers.trainingContext ?? account.profile.trainingContext ?? '');
  const [stack, setStack] = useState<OnboardingScreen[]>(() => [account.onboarding.status === 'completed' ? 'ready' : resumeScreen(account.onboarding.step)]);
  const { busy, run: single } = useBusy();
  const [banner, setBanner] = useState<Banner>(null);
  const [voiceTarget, setVoiceTarget] = useState<{ apply: (text: string) => void; maxLength: number } | null>(null);
  const [sources, setSources] = useState<'pain' | 'plans' | null>(null);
  const [urgent, setUrgent] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const complete = useCommandKey();
  const createPlan = useCommandKey();
  const unresolved = useRef<(() => void) | null>(null);
  const commandInFlight = useRef(false);
  const localDraft = useRef({ answers, prefs, injury, experienceNote });
  localDraft.current = { answers, prefs, injury, experienceNote };
  const screen = stack[stack.length - 1];

  const blocked = () => !isCurrent() || !!unresolved.current || commandInFlight.current;
  const advance = (next: OnboardingScreen) => { setBanner(null); setStack((s) => [...s, next]); };
  const go = (next: OnboardingScreen) => { if (!blocked()) advance(next); };
  const back = () => { if (blocked()) return; setBanner(null); setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)); };

  const execute = (work: () => Promise<unknown>) => single(async () => {
    if (!isCurrent()) return;
    commandInFlight.current = true;
    try { await work(); } finally { commandInFlight.current = false; }
  });
  const run = (work: () => Promise<unknown>) => {
    if (unresolved.current) return;
    return execute(async () => { setBanner(null); await work(); });
  };
  const retainUnknown = (text: string, work: () => Promise<unknown>) => {
    if (!isCurrent()) return;
    const retry = () => {
      if (unresolved.current !== retry) return;
      void execute(work);
    };
    unresolved.current = retry;
    setBanner({ kind: 'error', text, retry });
  };

  const reloadOnboarding = async () => (await resources.account()).onboarding;

  /** Revision-guarded draft save; stale reloads and keeps local edits for the user to confirm again. */
  const handle = <T,>(result: SaveResult<T>, onSaved: (value: T) => void, retryLabel = 'Try again') => {
    if (!isCurrent()) return false;
    switch (result.status) {
      case 'saved': unresolved.current = null; setBanner(null); onSaved(result.value); return true;
      case 'stale':
        unresolved.current = null;
        if (isOnboarding(result.latest)) setCurrent(result.latest);
        setBanner({ kind: 'info', text: COPY.stale });
        return false;
      case 'unknown':
        retainUnknown('The result could not be confirmed. Retry this same action without changing it.',
          async function retryOriginal() {
            const next = await result.retry();
            if (!isCurrent()) return;
            if (next.status === 'saved') handle(next, onSaved, retryLabel);
            else retainUnknown('The result could not be confirmed. Retry this same action without changing it.', retryOriginal);
          });
        return false;
      default:
        unresolved.current = null;
        if (result.error.status === 401) onUnauthenticated();
        else setBanner({ kind: 'error', text: errorCopy(result.error) });
        return false;
    }
  };

  const save = (patch: Patch, next: OnboardingScreen) => run(async () => {
    if ((patch.answers?.name !== undefined && (patch.answers.name.length > TEXT_LIMITS.name
        || (localDraft.current.answers.name?.length ?? 0) > TEXT_LIMITS.name))
      || (patch.answers?.trainingContext !== undefined && patch.answers.trainingContext.length > TEXT_LIMITS.trainingContext)
      || (patch.answers?.injuryHistory && (localDraft.current.injury.note.length > TEXT_LIMITS.injuryNote
        || patch.answers.injuryHistory.length > TEXT_LIMITS.injuryHistory))) {
      setBanner({ kind: 'error', text: 'Shorten your answer before continuing. Your full answer is still here to edit.' });
      return;
    }
    const base = current;
    const edits = localDraft.current;
    const result = await guardedSave(() => resources.onboarding(base, patch), reloadOnboarding);
    handle(result, (value) => {
      setCurrent(value);
      const latest = localDraft.current;
      // New local edits remain on this step for an explicit save after the earlier command resolves.
      if (latest.answers === edits.answers && latest.prefs === edits.prefs && latest.injury === edits.injury
        && latest.experienceNote === edits.experienceNote) advance(next);
    });
  });

  /* ---------------- completion: review PATCH → keyed complete → optional first plan ---------------- */

  const finish = () => run(async () => {
    let draft = current;
    if (draft.step !== 'review' || !sameAnswers(draft, prefs)) {
      const patch: Patch = { step: 'review', preferences: pick(prefs, ['trainingDaysPerWeek', 'sessionMinutes', 'equipment']) };
      const saved = await guardedSave(() => resources.onboarding(draft, patch), reloadOnboarding);
      if (!handle(saved, (value) => { draft = value; setCurrent(value); })) return;
    }
    await completeAndPlan(draft);
  });

  const completeAndPlan = async (draft: Onboarding, wasUnknown = false) => {
    if (!isCurrent()) return;
    if (draft.status !== 'completed') {
      const key = complete.keyFor({ op: 'complete', revision: draft.revision });
      try {
        draft = await resources.completeOnboarding(draft, key);
        if (!isCurrent()) return;
        unresolved.current = null;
        setBanner(null);
        complete.settle();
        setCurrent(draft);
      } catch (error) {
        if (!isCurrent()) return;
        if (wasUnknown || error instanceof ApiError && (error.effectUnknown || error.originalEffectUnknown)) {
          retainUnknown('The result could not be confirmed. Retry this same action without changing it.', () => completeAndPlan(draft, true));
          return;
        }
        unresolved.current = null;
        complete.settle();
        if (error instanceof ApiError && error.status === 401) { onUnauthenticated(); return; }
        if (error instanceof ApiError && error.code === 'onboarding_incomplete') {
          setStack(['name']);
          setBanner({ kind: 'info', text: COPY.onboardingIncomplete });
          return;
        }
        if (error instanceof ApiError && error.code === 'stale_revision') {
          const latest = await reloadOnboarding().catch(() => draft);
          if (!isCurrent()) return;
          setCurrent(latest);
          setBanner({ kind: 'info', text: COPY.stale });
          return;
        }
        setBanner({ kind: 'error', text: errorCopy(error) });
        return;
      }
    }
    if (firstPlanCommand) {
      await makePersistedFirstPlan(draft);
      return;
    }
    const fresh = await resources.account().catch(() => null);
    if (!isCurrent()) return;
    if (fresh) onAccount(fresh);
    await makeFirstPlan(fresh ?? { ...account, onboarding: draft });
    if (isCurrent()) setStack(['ready']);
  };

  const makePersistedFirstPlan = async (draft: Onboarding) => {
    if (!firstPlanCommand || firstReceipt.current || !isCurrent()) return;
    let fresh: Account;
    let confirmation: ReturnType<typeof captureFirstPlanConfirmation>;
    try {
      fresh = await resources.account();
      if (!isCurrent()) return;
      if (!matchesConfirmedAccount(fresh, account.accountId, draft)) {
        setStack(['plan']);
        setBanner({ kind: 'info', text: COPY.stale });
        return;
      }
      confirmation = captureFirstPlanConfirmation({ profileRevision: fresh.profile.revision,
        preferencesRevision: fresh.preferences.revision });
    } catch (error) {
      if (isCurrent()) setBanner({ kind: 'error', text: errorCopy(error),
        retry: () => void run(() => makePersistedFirstPlan(draft)) });
      return;
    }
    const key = createPlan.keyFor({ op: 'persisted-first-plan', ...confirmation });
    const command = firstPlanCommand;
    let unknown = false;
    const send = async () => {
      if (!isCurrent()) return;
      try {
        const receipt = decodeFirstPlanReceipt(await command(confirmation, key), confirmation);
        if (!isCurrent()) return;
        firstReceipt.current = receipt;
        setPlan(receipt.plan);
        unresolved.current = null;
        createPlan.settle();
        setBanner(null);
        onAccount(fresh);
        if (isCurrent()) setStack(['ready']);
      } catch (error) {
        if (!isCurrent()) return;
        unknown = unknown || !(error instanceof ApiError) || error.effectUnknown || error.originalEffectUnknown;
        if (unknown) {
          retainUnknown('The result could not be confirmed. Retry this same action without changing it.', send);
          return;
        }
        createPlan.settle();
        if (error instanceof ApiError && error.status === 401) { onUnauthenticated(); return; }
        setBanner({ kind: 'error', text: errorCopy(error) });
        if (error instanceof ApiError && error.status === 501 && error.code === 'first_plan_unavailable') {
          onAccount(fresh);
          if (isCurrent()) setStack(['ready']);
        }
      }
    };
    await send();
  };

  const makeFirstPlan = async (acct: Account) => {
    if (!firstPlan || plan || !isCurrent()) return;
    try {
      const catalog = (await resources.exercises()).items.filter((e) => !e.retired);
      if (!isCurrent()) return;
      const generated = firstPlan(acct, catalog);
      if (!generated) return;
      const fields = Object.freeze({ ...generated, items: generated.items.map(item => Object.freeze({ ...item })) });
      Object.freeze(fields.items);
      const key = createPlan.keyFor({ op: 'first-plan', fields });
      let unknown = false;
      // An unknown write must retry these exact fields and key, without running the generator again.
      const send = async () => {
        if (!isCurrent()) return;
        try {
          const saved = await resources.createPlan(fields, key);
          if (!isCurrent()) return;
          setPlan(saved);
          unresolved.current = null;
          createPlan.settle();
          setBanner(null);
        } catch (error) {
          if (!isCurrent()) return;
          unknown = unknown || !(error instanceof ApiError) || error.effectUnknown || error.originalEffectUnknown;
          if (unknown) {
            retainUnknown('The result could not be confirmed. Retry this same action without changing it.', send);
            return;
          }
          unresolved.current = null;
          createPlan.settle();
          setBanner({ kind: 'error', text: errorCopy(error), retry: () => void run(() => makeFirstPlan(acct)) });
        }
      };
      await send();
    } catch (error) {
      if (isCurrent()) setBanner({ kind: 'error', text: errorCopy(error), retry: () => void run(() => makeFirstPlan(acct)) });
    }
  };

  /* ---------------- shared pieces ---------------- */

  const name = answers.name?.trim() ?? '';
  const injuryTooLong = injury.note.length > TEXT_LIMITS.injuryNote
    || serializeInjury({ ...injury, skipped: false }).length > TEXT_LIMITS.injuryHistory;
  const heightUnit = prefs.heightUnit ?? 'cm';
  const loadUnit = prefs.loadUnit ?? 'kg';
  const backLabel = BACK_LABEL[screen];
  const nav = (trailing?: ReactNode) => (backLabel && stack.length > 1
    ? <Nav back={backLabel} onBack={back} trailing={trailing} />
    : <Nav trailing={trailing} />);
  const notice = banner ? (
    <Notice kind={banner.kind} text={banner.text} captureId="a-onboarding-notice" announce
      action={banner.retry ? { label: 'Try again', onPress: banner.retry } : null} />
  ) : null;
  const mic = (apply: (text: string) => void, maxLength: number) => () => setVoiceTarget({ apply, maxLength });

  const overlays = (
    <>
      <VoiceSheet visible={!!voiceTarget} speech={speech} onOpenSettings={onOpenSystemSettings}
        maxLength={voiceTarget?.maxLength}
        onClose={() => setVoiceTarget(null)} onUse={(text) => {
          if (!voiceTarget || text.length > voiceTarget.maxLength) return;
          voiceTarget.apply(text); setVoiceTarget(null);
        }} />
      <SourcesSheet which={sources} onClose={() => setSources(null)} />
      <UrgentCareSheet visible={urgent} onClose={() => setUrgent(false)} />
    </>
  );

  /* ---------------- screens ---------------- */

  let body: ReactNode;
  let footer: ReactNode;

  switch (screen) {
    case 'name':
      body = (
        <>
          {nav()}
          <Gutter><StepMeta n={1} /><Title text="What should your coach call you?" /><Subtitle text="First name or a nickname. You can change it later." /></Gutter>
          <Section>
            {notice}
            <TextAnswer value={answers.name ?? ''} onChangeText={(v) => setAnswers({ ...answers, name: v })} testID="a-name-field" micTestID="a-name-mic"
              onMic={mic((text) => setAnswers((a) => ({ ...a, name: text })), TEXT_LIMITS.name)} autoComplete="given-name" maxLength={TEXT_LIMITS.name} />
            <View style={s.helper}>
              <Txt role="meta" tone="secondary">Tap the mic to say it instead.</Txt>
            </View>
          </Section>
        </>
      );
      footer = <StepFooter label="Continue" disabled={!name || (answers.name?.length ?? 0) > TEXT_LIMITS.name} loading={busy} onPress={() => void save({ step: 'name', answers: { name } }, 'age')} />;
      break;

    case 'age': {
      const age = answers.age ?? null;
      body = (
        <>
          {nav()}
          <Gutter><StepMeta n={2} /><Title text="How old are you?" /><Subtitle text="Age helps set a sensible starting point. Only you and your coach see it." /></Gutter>
          <Section>
            {notice}
            <StepperField label="Age, years" value={age === null ? '—' : String(age)} testID="a-age-field" focused full
              onStep={(d) => setAnswers({ ...answers, age: age === null ? START.age : clamp(age + d, 13, 120) })} />
          </Section>
        </>
      );
      footer = (
        <StepFooter label="Continue" loading={busy} disabled={age === null} secondary="I’d rather not say"
          onPress={() => void save({ step: 'measurements', answers: { age } }, 'body')}
          onSecondary={() => { setAnswers({ ...answers, age: null }); void save({ step: 'measurements', answers: { age: null } }, 'body'); }} />
      );
      break;
    }

    case 'body': {
      const cm = answers.heightCm ?? null;
      const kg = answers.weightKg ?? null;
      const metric = heightUnit === 'cm';
      const inches = cm === null ? null : Math.round(cm / CM_PER_IN);
      body = (
        <>
          {nav(<PlainAction label="Skip" captureId="a-skip" chevron={null} placement="trailing" onPress={() => go('outcome-pain')} />)}
          <Gutter><StepMeta n={3} /><Title text="Height and weight" /><Subtitle text="Used to suggest starting weights. Optional, and you can update it anytime." /></Gutter>
          <Section>
            {notice}
            <Segmented testID="a-units" selected={metric ? 'metric' : 'imperial'}
              items={[{ value: 'metric', label: 'cm, kg' }, { value: 'imperial', label: 'ft, lb' }]}
              onSelect={(v) => setPrefs({ ...prefs, heightUnit: v === 'metric' ? 'cm' : 'ft-in', loadUnit: v === 'metric' ? 'kg' : 'lb' })} />
            <Fields>
              <StepperField label={metric ? 'Height, cm' : 'Height, ft in'} testID="a-height-field"
                value={cm === null || inches === null ? '—' : metric ? String(Math.round(cm)) : `${Math.floor(inches / 12)}′ ${inches % 12}″`}
                onStep={(d) => setAnswers({ ...answers, heightCm: cm === null || inches === null ? START.heightCm
                  : clamp(metric ? Math.round(cm) + d : (inches + d) * CM_PER_IN, 50, 260) })} />
              <StepperField label={metric ? 'Weight, kg' : 'Weight, lb'} testID="a-weight-field"
                value={kg === null ? '—' : metric ? String(Math.round(kg * 2) / 2) : String(Math.round(kg / KG_PER_LB))}
                onStep={(d) => setAnswers({ ...answers, weightKg: kg === null ? START.weightKg
                  : clamp(metric ? Math.round(kg * 2) / 2 + d * 0.5 : (Math.round(kg / KG_PER_LB) + d) * KG_PER_LB, 15, 500) })} />
            </Fields>
          </Section>
        </>
      );
      footer = (
        <StepFooter label="Continue" loading={busy} onPress={() => void save({
          step: 'measurements',
          answers: { ...(cm === null ? {} : { heightCm: round1(cm) }), ...(kg === null ? {} : { weightKg: round1(kg) }) },
          preferences: { heightUnit, loadUnit },
        }, 'outcome-pain')} />
      );
      break;
    }

    case 'outcome-pain':
      body = (
        <>
          {nav()}
          <Gutter>
            <Eyebrow text="Why this matters" />
            <View style={s.statBlock}>
              <Txt role="stat" testID="a-stat" accessibilityLabel="One in four">1 in 4</Txt>
              <Txt role="sectionTitle" accessibilityRole="header" testID="a-question">U.S. adults have pain on most days.</Txt>
            </View>
            <Txt role="body" style={s.gap16}>For many long-lasting back, hip and knee problems, guidelines recommend exercise. Strength around a sore spot can help you do more of what you want.</Txt>
            <Txt role="bodyStrong" style={s.gap16}>Our aim is less pain getting in your way, built up at your pace.</Txt>
            <SourceNote text="CDC, National Health Interview Survey 2023: 24.3% of adults had pain most days or every day. General information, not medical advice."
              onSources={() => setSources('pain')} />
          </Gutter>
        </>
      );
      footer = <StepFooter label="Continue" onPress={() => go('goals')} />;
      break;

    case 'goals': {
      const goals = answers.goals ?? [];
      body = (
        <>
          {nav()}
          <Gutter><StepMeta n={4} /><Title text="What do you want strength for?" /><Subtitle text="Pick up to three." /></Gutter>
          <Section>
            {notice}
            <Choices multi>
              {GOALS.map((g, i) => {
                const on = goals.includes(g.key);
                return (
                  <ChoiceRow key={g.key} title={g.title} detail={g.detail} selected={on} multi testID={`a-goal-${i}`}
                    onPress={() => setAnswers({ ...answers, goals: on ? goals.filter((k) => k !== g.key) : goals.length < MAX_GOALS ? [...goals, g.key] : goals })} />
                );
              })}
            </Choices>
          </Section>
        </>
      );
      footer = <StepFooter label="Continue" disabled={goals.length === 0} loading={busy} onPress={() => void save({ step: 'goals', answers: { goals } }, 'outcome-plans')} />;
      break;
    }

    case 'outcome-plans':
      body = (
        <>
          {nav()}
          <Gutter>
            <Eyebrow text="How Form works" />
            <Title text="Plans built around you tend to work better." />
            <Txt role="body" style={s.gap16}>In studies of long-lasting back pain, exercise programs designed for each person eased pain a little more than home exercises done alone.</Txt>
            <Panel testID="a-echo" style={s.gap32}>
              <Txt role="meta" tone="secondary">Your plan so far</Txt>
              <Txt role="sectionTitle">{answers.age ? `${name}, ${answers.age}` : name}</Txt>
              {(answers.goals ?? []).length ? <Txt role="body">{goalsSentence(answers.goals ?? [])}</Txt> : null}
            </Panel>
            <SourceNote text="Hayden and colleagues, Annals of Internal Medicine, 2005. Those programs were run by clinicians. Form isn’t a clinical service."
              onSources={() => setSources('plans')} />
          </Gutter>
        </>
      );
      footer = <StepFooter label="Continue" onPress={() => go('experience')} />;
      break;

    case 'experience':
      body = (
        <>
          {nav()}
          <Gutter><StepMeta n={5} /><Title text="How much strength training have you done?" /></Gutter>
          <Section>
            {notice}
            <Choices>
              {EXPERIENCE.map((e) => (
                <ChoiceRow key={e.value} title={e.title} detail={e.detail} selected={answers.trainingBackground === e.value}
                  testID={`a-exp-${e.value === 'returning' ? 'some' : e.value}`} onPress={() => setAnswers({ ...answers, trainingBackground: e.value })} />
              ))}
            </Choices>
            <View style={s.tight}>
              <Txt role="meta" tone="secondary">Anything else? Sports, jobs, past programs.</Txt>
              <TextAnswer value={experienceNote} onChangeText={setExperienceNote} placeholder="Say or type it" testID="a-exp-notes"
                onMic={mic((text) => setExperienceNote(text), TEXT_LIMITS.trainingContext)} multiline maxLength={TEXT_LIMITS.trainingContext} />
            </View>
          </Section>
        </>
      );
      footer = (
        <StepFooter label="Continue" disabled={!answers.trainingBackground || experienceNote.length > TEXT_LIMITS.trainingContext} loading={busy}
          onPress={() => void save({ step: 'background', answers: {
            trainingBackground: answers.trainingBackground ?? null, trainingContext: experienceNote,
          } }, 'injury')} />
      );
      break;

    case 'injury':
      body = (
        <>
          {nav(<PlainAction label="Skip" captureId="a-skip" chevron={null} placement="trailing"
            onPress={() => { const skipped = { ...injury, skipped: true }; setInjury(skipped); void save({ step: 'injuries', answers: { injuryHistory: '' } }, 'coach'); }} />)}
          <Gutter><StepMeta n={6} /><Title text="Anything we should work around?" /><Subtitle text="Old injuries, sore spots or surgeries. This isn’t a diagnosis." /></Gutter>
          <Section>
            {notice}
            <ChipSet>
              {AREAS.map((a) => {
                const on = injury.areas.includes(a.key);
                return (
                  <ChipChoice key={a.key} label={a.label} selected={on} testID={`a-area-${a.key}`}
                    onPress={() => setInjury({ ...injury, skipped: false, worsening: null, areas: on ? injury.areas.filter((k) => k !== a.key) : [...injury.areas, a.key as InjuryArea] })} />
                );
              })}
            </ChipSet>
            <View style={s.tight}>
              <Txt role="meta" tone="secondary">Anything to add? What happened, what still bothers you.</Txt>
              <TextAnswer value={injury.note} onChangeText={(note) => setInjury({ ...injury, skipped: false, note })} placeholder="Say or type it"
                testID="a-injury-note" micTestID="a-injury-mic" onMic={mic((text) => setInjury((i) => ({ ...i, skipped: false, note: text })), TEXT_LIMITS.injuryNote)}
                multiline maxLength={TEXT_LIMITS.injuryNote} />
            </View>
          </Section>
        </>
      );
      footer = (
        <StepFooter label="Continue" disabled={injuryTooLong} loading={busy} onPress={() => {
          const answer = { ...injury, skipped: false };
          // The save guard must capture the submitted draft before React commits its queued state.
          localDraft.current = { ...localDraft.current, injury: answer };
          setInjury(answer);
          void save({ step: 'injuries', answers: { injuryHistory: serializeInjury(answer) } }, hasInjuryDetail(answer) ? 'injury-check' : 'coach');
        }} />
      );
      break;

    case 'injury-check': {
      const phrase = areasPhrase(injury.areas);
      body = (
        <>
          {nav()}
          <Gutter>
            <StepMeta n={6} /><Title text="Is any of it new, severe or getting worse?" />
            <Subtitle text={`${phrase ? `About your ${phrase}.` : 'About what you told us.'} If it is, we’ll suggest getting it checked first.`} />
          </Gutter>
          <Section>
            {notice}
            <Choices>
              <ChoiceRow title="No, it’s been like this a while" selected={injury.worsening === 'no'} testID="a-check-no" onPress={() => setInjury({ ...injury, worsening: 'no' })} />
              <ChoiceRow title="Yes" selected={injury.worsening === 'yes'} testID="a-check-yes" onPress={() => setInjury({ ...injury, worsening: 'yes' })} />
              <ChoiceRow title="Not sure" selected={injury.worsening === 'unsure'} testID="a-check-unsure" onPress={() => setInjury({ ...injury, worsening: 'unsure' })} />
            </Choices>
          </Section>
        </>
      );
      footer = (
        <StepFooter label="Continue" disabled={injury.worsening === null || injuryTooLong} loading={busy}
          onPress={() => void save({ step: 'injuries', answers: { injuryHistory: serializeInjury(injury) } }, injury.worsening === 'no' ? 'coach' : 'injury-pause')} />
      );
      break;
    }

    case 'injury-pause': {
      const phrase = areasPhrase(injury.areas);
      body = (
        <>
          {nav()}
          <Gutter><StepMeta n={6} /><Title text="Let’s get that checked first." /></Gutter>
          <Section>
            <Notice kind="warning" captureId="a-pause-notice"
              text={`New, severe or worsening pain should be checked by a clinician before you train it. Until then, skip movements that load your ${phrase || 'sore area'}.`} />
            <Txt role="body">We’ve saved this to your account. Update it in Account once you’ve been seen.</Txt>
            <PlainAction label="When to get urgent care" captureId="a-urgent-care" onPress={() => setUrgent(true)} />
          </Section>
        </>
      );
      footer = <StepFooter label="Continue" onPress={() => go('coach')} />;
      break;
    }

    case 'coach': {
      const style = coachStyleOf(prefs);
      body = (
        <>
          {nav()}
          <Gutter><StepMeta n={7} /><Title text="How should your coach talk to you?" /></Gutter>
          <Section>
            {notice}
            <Choices>
              {COACH_STYLES.map((c) => (
                <ChoiceRow key={c.id} title={c.title} detail={c.detail} selected={style?.id === c.id} testID={`a-style-${c.id}`}
                  onPress={() => setPrefs({ ...prefs, ...c.prefs })} />
              ))}
            </Choices>
            {notifications ? (
              <View style={s.tight}>
                <ToggleRow label="Workout reminders" detail="On your training days. iPhone will ask first." testID="a-reminders"
                  value={!!prefs.remindersEnabled}
                  onValueChange={(on) => {
                    if (!on) { setPrefs({ ...prefs, remindersEnabled: false }); return; }
                    void notifications.request().then((r) => setPrefs((p) => ({ ...p, remindersEnabled: r === 'granted' })), () => undefined);
                  }} />
              </View>
            ) : null}
          </Section>
        </>
      );
      footer = (
        <StepFooter label="Continue" disabled={!style} loading={busy} onPress={() => void save({
          step: 'preferences',
          preferences: { ...pick(prefs, ['coachVoice', 'communication']), ...(notifications ? { remindersEnabled: !!prefs.remindersEnabled } : {}) },
        }, 'plan')} />
      );
      break;
    }

    case 'plan': {
      const days = prefs.trainingDaysPerWeek;
      const minutes = prefs.sessionMinutes;
      const equipment = prefs.equipment ?? [];
      body = (
        <>
          {nav()}
          <Gutter><StepMeta n={8} /><Title text="How should your plan fit your week?" /></Gutter>
          <Section style={s.gap24Inner}>
            {notice}
            <View style={s.group}>
              <Txt role="bodyStrong">Days a week</Txt>
              <ChipSet>{DAYS.map((d) => <ChipChoice key={d} label={String(d)} selected={days === d} testID={`a-days-${d}`} onPress={() => setPrefs({ ...prefs, trainingDaysPerWeek: d })} />)}</ChipSet>
            </View>
            <View style={s.group}>
              <Txt role="bodyStrong">Minutes a session</Txt>
              <ChipSet>{MINUTES.map((m) => <ChipChoice key={m} label={String(m)} selected={minutes === m} testID={`a-minutes-${m}`} onPress={() => setPrefs({ ...prefs, sessionMinutes: m })} />)}</ChipSet>
            </View>
            <View style={s.group}>
              <Txt role="bodyStrong">Equipment you have</Txt>
              <ChipSet>
                {EQUIPMENT.map((e) => {
                  const on = equipment.includes(e.key);
                  return <ChipChoice key={e.key} label={e.label} selected={on} testID={`a-equipment-${e.key}`}
                    onPress={() => setPrefs({ ...prefs, equipment: on ? equipment.filter((k) => k !== e.key) : [...equipment, e.key] })} />;
                })}
              </ChipSet>
            </View>
          </Section>
          <Gutter><Txt role="meta" tone="secondary" style={s.gap16}>You can edit every plan later, down to reps and weight.</Txt></Gutter>
        </>
      );
      footer = (
        <StepFooter label="Build my plan" testID="a-build" loading={busy}
          disabled={!DAYS.includes(days as never) || !MINUTES.includes(minutes as never)} onPress={() => void finish()} />
      );
      break;
    }

    default:
      body = <Ready name={name} plan={plan} areas={injury.areas} notice={notice} />;
      footer = <StepFooter label="Go to Today" testID="a-go-today" onPress={() => { if (!blocked()) onDone(plan); }} disabled={busy || !!unresolved.current} />;
  }

  return (
    <>
      <Screen testID={`screen-onboarding-${screen}`} nav={null} footer={footer}>{body}</Screen>
      {overlays}
    </>
  );
}

/* ---------------- ready (signature moment) ---------------- */

const AnimatedCircle = Reanimated.createAnimatedComponent(Circle);
const AnimatedPath = Reanimated.createAnimatedComponent(Path);
const RING = 64; // design dash length for the circle-check ring (onboarding.css confirm-check)
const TICK = 9;

function Ready({ name, plan, areas, notice }: { name: string; plan: Plan | null; areas: readonly InjuryArea[]; notice: ReactNode }) {
  const { reduceMotion } = useAccessibilityPrefs();
  const rise = useSharedValue(0);
  const ring = useSharedValue(0);
  const tick = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) {
      rise.value = withTiming(1, { duration: t.motion.reduced, easing: Easing.linear });
      ring.value = withTiming(1, { duration: t.motion.reduced, easing: Easing.linear });
      tick.value = withTiming(1, { duration: t.motion.reduced, easing: Easing.linear });
      return;
    }
    rise.value = withTiming(1, { duration: t.motion.sheet, easing: easeOut });
    ring.value = withDelay(t.motion.sheet, withTiming(1, { duration: t.motion.confirm, easing: easeOut }));
    tick.value = withDelay(t.motion.sheet + t.motion.confirm, withTiming(1, { duration: t.motion.confirm, easing: easeOut }));
  }, [reduceMotion, rise, ring, tick]);

  const summary = useAnimatedStyle(() => ({
    opacity: rise.value,
    transform: [{ translateY: reduceMotion ? 0 : (1 - rise.value) * t.space.s8 }],
  }));
  const savedText = useAnimatedStyle(() => ({ opacity: reduceMotion ? rise.value : ring.value }));
  const ringProps = useAnimatedProps(() => ({ strokeDashoffset: reduceMotion ? 0 : RING * (1 - ring.value) }));
  const tickProps = useAnimatedProps(() => ({ strokeDashoffset: reduceMotion ? 0 : TICK * (1 - tick.value) }));
  const phrase = areasPhrase(areas);

  return (
    <>
      <Nav />
      <Gutter>
        <Title display testID="a-ready-title" text={plan ? `Your first plan is ready, ${name}.` : `You’re set up, ${name}.`} />
        <View style={s.gap32}><Art /></View>
        {notice ? <View style={s.gap16}>{notice}</View> : null}
        {plan ? (
          <Reanimated.View testID="a-ready-plan" style={[s.gap32, s.session, summary]}>
            <Txt role="sectionTitle">{plan.name}</Txt>
            <MetaLine items={[`${plan.minutes} minutes`, movementWord(plan.items.length)]} />
          </Reanimated.View>
        ) : null}
        <Reanimated.View testID="a-ready-saved" style={[s.helper, s.gap16, reduceMotion ? summary : null]}>
          <Svg width={L.icon.inline} height={L.icon.inline} viewBox="0 0 24 24" fill="none" stroke={t.color.success}
            strokeWidth={t.stroke.icon} strokeLinecap="round" strokeLinejoin="round" style={s.helperIcon}
            accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <AnimatedCircle cx={12} cy={12} r={10} strokeDasharray={RING} animatedProps={ringProps} />
            <AnimatedPath d="m9 12 2 2 4-4" strokeDasharray={TICK} animatedProps={tickProps} />
          </Svg>
          <Reanimated.View style={[s.flex, savedText]}>
            <Txt role="meta" tone="success">{phrase ? `Saved to your account, with your ${phrase} noted.` : 'Saved to your account.'}</Txt>
          </Reanimated.View>
        </Reanimated.View>
      </Gutter>
    </>
  );
}

/* ---------------- sheets ---------------- */

const SOURCES = {
  pain: [
    { text: 'CDC NCHS Data Brief 518: Chronic Pain and High-impact Chronic Pain in U.S. Adults, 2023', url: 'https://www.cdc.gov/nchs/products/databriefs/db518.htm' },
    { text: 'WHO guideline for non-surgical management of chronic primary low back pain in adults (2023)', url: 'https://iris.who.int/items/a7238f6b-e9f8-4d15-9ead-0f8769610e6d' },
    { text: 'NICE NG226: Osteoarthritis in over 16s (2022)', url: 'https://www.nice.org.uk/guidance/ng226/chapter/recommendations' },
    { text: 'Hayden et al., Cochrane 2021: Exercise therapy for chronic low back pain', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC8477273' },
  ],
  plans: [
    { text: 'Hayden, van Tulder, Tomlinson. Strategies for using exercise therapy to improve outcomes in chronic low back pain. Ann Intern Med 2005;142:776–85', url: 'https://pubmed.ncbi.nlm.nih.gov/15867410/' },
  ],
} as const;

/** DGR-011: v1 draws "See sources" but no sources view; this lists the copy.md citations and opens them. */
function SourcesSheet({ which, onClose }: { which: 'pain' | 'plans' | null; onClose: () => void }) {
  return (
    <Sheet visible={!!which} title="Sources" onClose={onClose} closeTestID="a-sources-close" testID="a-sources-sheet">
      {(which ? SOURCES[which] : []).map((source) => (
        <View key={source.url} style={s.tight}>
          <Txt role="body">{source.text}</Txt>
          <PlainAction label="Open source" onPress={() => void Linking.openURL(source.url)} accessibilityLabel={`Open source: ${source.text}`} />
        </View>
      ))}
      <Txt role="meta" tone="secondary">General information, not medical advice.</Txt>
    </Sheet>
  );
}

const RED_FLAGS = [
  'Chest pain or pressure, severe or unusual shortness of breath, or fainting',
  'Sudden weakness or numbness in your face, arm or leg, or trouble speaking',
  'New numbness around your groin or buttocks, or new bladder or bowel problems',
  'Severe or unexpected muscle pain, marked weakness, or dark tea- or cola-colored urine',
  'A limb that looks deformed, or is cold, pale or numb',
] as const;

function UrgentCareSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Sheet visible={visible} large title="Get help now" onClose={onClose} closeTestID="a-urgent-close" testID="a-urgent-sheet">
      <Txt role="body">Stop exercising and call 911 or go to an emergency department if you have any one of these:</Txt>
      <View style={s.list}>
        {RED_FLAGS.map((flag) => (
          <View key={flag} style={s.bullet}>
            <Txt role="body" accessibilityElementsHidden importantForAccessibility="no">•</Txt>
            <Txt role="body" style={s.flex}>{flag}</Txt>
          </View>
        ))}
      </View>
      <Txt role="meta" tone="secondary">Form can’t assess symptoms. If you’re unsure, contact a clinician.</Txt>
    </Sheet>
  );
}

/* ---------------- helpers ---------------- */

function matchesConfirmedAccount(fresh: Account, accountId: string, draft: Onboarding): boolean {
  const equal = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  };
  const suppliedMatches = (supplied: object, saved: object) => Object.entries(supplied).every(([key, value]) =>
    value === undefined || Object.hasOwn(saved, key) && equal(value, (saved as Record<string, unknown>)[key]));
  return fresh.accountId === accountId && fresh.onboarding.status === 'completed' &&
    fresh.onboarding.revision === draft.revision && equal(fresh.onboarding.answers, draft.answers) &&
    equal(fresh.onboarding.preferences, draft.preferences) && suppliedMatches(draft.answers, fresh.profile) &&
    suppliedMatches(draft.preferences, fresh.preferences);
}

function isOnboarding(value: unknown): value is Onboarding {
  return !!value && typeof value === 'object' && 'step' in value && 'status' in value;
}

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function sameAnswers(draft: Onboarding, prefs: Prefs): boolean {
  const p = draft.preferences;
  return p.trainingDaysPerWeek === prefs.trainingDaysPerWeek && p.sessionMinutes === prefs.sessionMinutes
    && JSON.stringify(p.equipment ?? []) === JSON.stringify(prefs.equipment ?? []);
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round1 = (value: number) => Math.round(value * 10) / 10;

function goalsSentence(keys: readonly string[]): string {
  const echoes = GOALS.filter((g) => keys.includes(g.key)).map((g) => g.echo);
  if (!echoes.length) return '';
  const text = echoes.length === 1 ? echoes[0] : `${echoes.slice(0, -1).join(', ')}, and ${echoes[echoes.length - 1]}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  helper: { flexDirection: 'row', gap: t.space.s8, alignItems: 'flex-start' },
  helperIcon: { marginTop: t.space.s2 },
  statBlock: { gap: t.space.s8, marginTop: t.space.s32 },
  gap16: { marginTop: t.space.s16 },
  gap32: { marginTop: t.space.s32 },
  tight: { marginTop: t.space.s24, gap: t.space.s8 },
  gap24Inner: { gap: t.space.s24 },
  group: { gap: t.space.s12 },
  session: { gap: t.space.s8 },
  list: { gap: t.space.s8 },
  bullet: { flexDirection: 'row', gap: t.space.s8 },
});

