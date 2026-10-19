// Body proportions flow: explicit session choice, guided setup checklist, memory-only manual measurements and
// descriptive ratios. Controlled by root through accountId/appMode/onClose only. No camera, file, storage, network,
// telemetry or persistence callbacks exist here; capability statuses come from ./capabilities, never from props.
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { AppState, BackHandler, StyleSheet, View } from 'react-native';
import type { AppMode } from '../api/domain';
import { L, t } from '../features/shared/tokens';
import {
  AccountRow, ChipChoice, ChipSet, ChoiceRow, Choices, Eyebrow, Gutter, Nav, Notice, PlainAction, RowGroup, Screen, Section,
  Segmented, StepFooter, Subtitle, TextAnswer, Title, Txt,
} from '../features/shared/ui';
import {
  BODY_CAPABILITIES, bodyPrivacySummary, isUsable, type BodyCapability, type BodyCapabilityId, type BodyChoiceRow, type CapabilityStatus,
} from './capabilities';
import {
  BODY_COPY as C, CAPABILITY_TITLES, CHECKLIST_COPY, DRAFT_ERROR_COPY, INSTRUMENT_COPY, MEASURED_BY_COPY, UNAVAILABLE_COPY, sideLabel,
} from './copy';
import {
  CHECKLIST, CONSTRUCT_IDS, CONSTRUCTS, RATIOS, bodyReducer, computeRatios, createBodySession, formatLength, formatRatio, previousRoute,
  type BodyCommand, type BodyEntry, type BodyRoute, type BodySessionState, type ClearReason, type DraftError, type Instrument,
  type LengthUnit, type MeasuredBy, type ReportedMeasurement, type Side,
} from './session';

export type BodyFlowProps = {
  /** Authenticated Form account. Used only to isolate the session: a change clears everything. Never sent or stored. */
  accountId: string;
  /** Account-wide presentation mode from Settings. Changes detail shown, never choices, limits or capabilities. */
  appMode: AppMode;
  /** Called after the session has been cleared. */
  onClose: () => void;
  /** 'choices' opens the read-only body data choices page (Settings privacy rows). Default 'overview'. */
  entry?: BodyEntry;
};

const NAV_NAME: Record<BodyRoute, string> = {
  overview: 'Body', purpose: 'Session', protocol: 'Setup', measure: 'Measure', results: 'Measurements', limits: 'Body', choices: 'Body',
};

const STATUS_LABEL: Record<CapabilityStatus, string> = {
  unsupported: 'Unsupported', unconfigured: 'Not set up', implemented_unverified: 'Not verified', qualified: 'Qualified',
};

const UNAVAILABLE_ROWS = ['cameraCapture', 'automaticEstimates', 'anatomicalAssessment', 'retainedMeasurements'] as const;

export function BodyFlow({ accountId, appMode, onClose, entry = 'overview' }: BodyFlowProps) {
  const [state, dispatch] = useReducer(bodyReducer, undefined, () => createBodySession(accountId, entry));
  const [covered, setCovered] = useState(false);
  const [clearedNotice, setClearedNotice] = useState(false);
  const latest = useRef(state);
  latest.current = state;

  // Commands from this render carry this render's generation; a late one from an earlier session is ignored.
  const send = (command: BodyCommand) => {
    setClearedNotice(false);
    dispatch({ ...command, generation: state.generation });
  };
  const close = (reason: ClearReason) => {
    dispatch({ type: 'clear', reason, generation: latest.current.generation });
    onClose();
  };

  useEffect(() => { dispatch({ type: 'account', accountId }); }, [accountId]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      // Hide values whenever Form isn't in front; clear them once it reaches the background.
      setCovered(next !== 'active');
      if (next === 'background') {
        const held = latest.current.measurements.length > 0 || latest.current.processing !== null;
        dispatch({ type: 'clear', reason: 'background', generation: latest.current.generation });
        if (held) setClearedNotice(true);
      }
    });
    return () => subscription.remove();
  }, []);

  const back = () => {
    const target = previousRoute(latest.current);
    if (target === 'close') close('cancel');
    else dispatch({ type: 'navigate', route: target, generation: latest.current.generation });
  };
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { backRef.current(); return true; });
    return () => subscription.remove();
  }, []);

  // Between an account change and its reset, render nothing from the previous account's session.
  if (state.accountId !== accountId) return <View style={s.cover} />;
  if (covered) {
    return <View testID="body-covered" style={s.cover}><Txt role="body" tone="secondary">{C.covered}</Txt></View>;
  }

  const advanced = appMode === 'advanced';
  const previous = previousRoute(state);
  const nav = previous === 'close'
    ? <Nav trailing={<PlainAction label={C.close} captureId="body-close" chevron={null} onPress={() => close('cancel')} />} />
    : <Nav back={NAV_NAME[previous]} onBack={back} />;
  const notice = clearedNotice
    ? <Section tight><Notice kind="info" captureId="body-cleared" text={C.cleared} /></Section>
    : null;
  const props = { state, send, advanced, nav, notice, close };

  switch (state.route) {
    case 'overview': return <Overview {...props} />;
    case 'purpose': return <Purpose {...props} />;
    case 'protocol': return <Protocol {...props} />;
    case 'measure': return <Measure {...props} />;
    case 'results': return <Results {...props} />;
    case 'choices': return <ChoicesPage {...props} />;
    case 'limits': return <Limits {...props} />;
  }
}

type PageProps = {
  state: BodySessionState;
  send: (command: BodyCommand) => void;
  advanced: boolean;
  nav: ReactNode;
  notice: ReactNode;
  close: (reason: ClearReason) => void;
};

function Header({ title, subtitle, eyebrow }: { title: string; subtitle?: string; eyebrow?: string }) {
  return (
    <Gutter>
      {eyebrow ? <Eyebrow text={eyebrow} /> : null}
      <Title text={title} testID="body-title" />
      {subtitle ? <Subtitle text={subtitle} /> : null}
    </Gutter>
  );
}

function capabilityDetail(capability: BodyCapability): string {
  return capability.reason ? UNAVAILABLE_COPY[capability.reason] : '';
}

function statusValue(advanced: boolean, capability: BodyCapability): string | null {
  return advanced ? STATUS_LABEL[capability.status] : null;
}

/* ---------------- overview ---------------- */

function Overview({ send, advanced, nav, notice, close }: PageProps) {
  const manual = BODY_CAPABILITIES.manualSession;
  return (
    <Screen testID="body-overview" nav={nav} footer={
      <StepFooter label={C.overview.continue} testID="body-continue" disabled={!isUsable(manual)}
        onPress={() => send({ type: 'navigate', route: 'purpose' })} secondary={C.overview.notNow} onSecondary={() => close('cancel')} />
    }>
      <Header title={C.overview.title} subtitle={C.overview.subtitle} />
      {notice}
      <RowGroup heading={C.overview.availableHeading}>
        <AccountRow label={C.overview.manual} detail={C.overview.manualDetail} value={statusValue(advanced, manual)} />
        <AccountRow label={C.overview.checklist} detail={C.overview.checklistDetail} last />
      </RowGroup>
      <RowGroup heading={C.overview.unavailableHeading}>
        {UNAVAILABLE_ROWS.map((id, i) => {
          const capability = BODY_CAPABILITIES[id];
          return (
            <AccountRow key={id} testID={`body-unavailable-${id}`} label={CAPABILITY_TITLES[id]} detail={capabilityDetail(capability)}
              value={statusValue(advanced, capability)} last={i === UNAVAILABLE_ROWS.length - 1} />
          );
        })}
      </RowGroup>
      <Section tight>
        <PlainAction label={C.overview.limitsAction} captureId="body-limits" onPress={() => send({ type: 'navigate', route: 'limits' })} />
        <Txt role="meta" tone="secondary">{C.overview.scope}</Txt>
      </Section>
    </Screen>
  );
}

/* ---------------- purpose: explicit session choice ---------------- */

function UnavailableChoice({ id, label, advanced, last }: { id: BodyCapabilityId; label: string; advanced: boolean; last?: boolean }) {
  const capability = BODY_CAPABILITIES[id];
  return (
    <AccountRow testID={`body-choice-${id}`} label={label} detail={capabilityDetail(capability)}
      value={advanced ? STATUS_LABEL[capability.status] : 'Not available'} last={last} />
  );
}

function Purpose({ state, send, advanced, nav }: PageProps) {
  const chosen = state.processing === 'session_only';
  return (
    <Screen testID="body-purpose" nav={nav} footer={
      <StepFooter label={C.purpose.continue} testID="body-purpose-continue" disabled={!chosen}
        onPress={() => send({ type: 'navigate', route: 'protocol' })} />
    }>
      <Header title={C.purpose.title} subtitle={C.purpose.subtitle} />
      <Section>
        <Choices>
          <ChoiceRow testID="body-session-only" title={C.purpose.sessionOnly} detail={C.purpose.sessionOnlyDetail} selected={chosen}
            onPress={() => send({ type: 'choose_processing', choice: 'session_only' })} />
        </Choices>
      </Section>
      <RowGroup heading={C.purpose.unavailableHeading}>
        <UnavailableChoice id="retainedMeasurements" label={C.purpose.saveMeasurements} advanced={advanced} />
        {/* Keeping photos is blocked first by capture, then by storage; show the capture reason. */}
        <UnavailableChoice id="cameraCapture" label={C.purpose.savePhotos} advanced={advanced} last />
      </RowGroup>
      <RowGroup heading={C.purpose.separateHeading}>
        <UnavailableChoice id="externalProcessing" label={C.purpose.external} advanced={advanced} />
        <UnavailableChoice id="improvementContribution" label={C.purpose.improve} advanced={advanced} last />
      </RowGroup>
      <Section tight><Txt role="meta" tone="secondary">{C.purpose.footnote}</Txt></Section>
    </Screen>
  );
}

/* ---------------- protocol: guided front/side checklist, no capture ---------------- */

function Protocol({ state, send, nav, close }: PageProps) {
  return (
    <Screen testID="body-protocol" nav={nav} footer={
      <StepFooter label={C.protocol.enter} testID="body-protocol-enter" onPress={() => send({ type: 'navigate', route: 'measure' })}
        secondary={C.protocol.skip} onSecondary={() => close('cancel')} />
    }>
      <Header title={C.protocol.title} subtitle={C.protocol.subtitle} />
      <Section>
        <Segmented testID="body-view" items={[{ value: 'front', label: C.protocol.front }, { value: 'side', label: C.protocol.side }] as const}
          selected={state.view} onSelect={(view) => send({ type: 'set_view', view })} />
        <Choices multi>
          {CHECKLIST[state.view].map((id) => (
            <ChoiceRow key={id} testID={`body-check-${id}`} multi title={CHECKLIST_COPY[id]} selected={state.checked.includes(id)}
              onPress={() => send({ type: 'toggle_check', id })} />
          ))}
        </Choices>
        <Txt role="meta" tone="secondary">{C.protocol.note}</Txt>
      </Section>
    </Screen>
  );
}

/* ---------------- measure: one manual entry at a time ---------------- */

const VALUE_ERRORS: readonly DraftError[] = ['value_missing', 'value_not_number', 'value_not_positive', 'value_too_precise', 'value_too_large'];

function measurementTitle(m: Pick<ReportedMeasurement, 'construct' | 'side'>): string {
  const side = sideLabel(m.side);
  return side ? `${CONSTRUCTS[m.construct].label} · ${side}` : CONSTRUCTS[m.construct].label;
}

function Measure({ state, send, advanced, nav, close }: PageProps) {
  const { draft, draftErrors, measurements, editing } = state;
  const sided = draft.construct ? CONSTRUCTS[draft.construct].sided : false;
  const count = measurements.length;
  return (
    <Screen testID="body-measure" nav={nav} footer={
      <StepFooter label={editing ? C.measure.save : C.measure.add} testID="body-measure-commit" onPress={() => send({ type: 'commit_draft' })}
        secondary={count ? C.measure.review(count) : C.measure.skip}
        onSecondary={() => (count ? send({ type: 'navigate', route: 'results' }) : close('cancel'))} />
    }>
      <Header title={editing ? C.measure.editTitle : C.measure.title} subtitle={C.measure.subtitle} />
      {draftErrors.length ? (
        <Section tight>
          <Notice kind="error" captureId="body-draft-error" announce text={draftErrors.map((e) => DRAFT_ERROR_COPY[e]).join(' ')} />
        </Section>
      ) : null}
      <Section>
        <Txt role="bodyStrong" accessibilityRole="header">{C.measure.what}</Txt>
        <Choices>
          {CONSTRUCT_IDS.map((id) => {
            const construct = CONSTRUCTS[id];
            const detail = [
              construct.endpoints,
              construct.sided ? C.measure.helper : null,
              advanced ? construct.protocol : null,
            ].filter(Boolean).join(' ');
            return (
              <ChoiceRow key={id} testID={`body-construct-${id}`} title={construct.label} detail={detail}
                selected={draft.construct === id} onPress={() => send({ type: 'edit_draft', patch: { construct: id } })} />
            );
          })}
        </Choices>
      </Section>
      {sided ? (
        <Section tight>
          <Txt role="meta" tone="secondary">{C.measure.side}</Txt>
          <ChipSet>
            {(['left', 'right'] as const).map((side: Side) => (
              <ChipChoice key={side} testID={`body-side-${side}`} label={sideLabel(side)} selected={draft.side === side}
                onPress={() => send({ type: 'edit_draft', patch: { side } })} />
            ))}
          </ChipSet>
        </Section>
      ) : null}
      <Section tight>
        <TextAnswer label={C.measure.value} testID="body-value" value={draft.valueText} keyboardType="decimal-pad" autoComplete="off"
          maxLength={8} error={draftErrors.some((e) => VALUE_ERRORS.includes(e))}
          onChangeText={(valueText) => send({ type: 'edit_draft', patch: { valueText } })} />
        <Segmented<LengthUnit> testID="body-unit" items={[{ value: 'cm', label: 'cm' }, { value: 'mm', label: 'mm' }]}
          selected={draft.unit} onSelect={(unit) => send({ type: 'edit_draft', patch: { unit } })} />
      </Section>
      <Section tight>
        <Txt role="meta" tone="secondary">{C.measure.measuredBy}</Txt>
        <ChipSet>
          {(Object.keys(MEASURED_BY_COPY) as MeasuredBy[]).map((by) => (
            <ChipChoice key={by} testID={`body-by-${by}`} label={MEASURED_BY_COPY[by]} selected={draft.measuredBy === by}
              onPress={() => send({ type: 'edit_draft', patch: { measuredBy: by } })} />
          ))}
        </ChipSet>
      </Section>
      <Section tight>
        <Txt role="meta" tone="secondary">{C.measure.instrument}</Txt>
        <ChipSet>
          {(Object.keys(INSTRUMENT_COPY) as Instrument[]).map((tool) => (
            <ChipChoice key={tool} testID={`body-tool-${tool}`} label={INSTRUMENT_COPY[tool]} selected={draft.instrument === tool}
              onPress={() => send({ type: 'edit_draft', patch: { instrument: draft.instrument === tool ? null : tool } })} />
          ))}
        </ChipSet>
      </Section>
      {editing ? (
        <Section tight>
          <PlainAction label={C.measure.remove} captureId="body-remove" chevron={null} tone="ink"
            onPress={() => send({ type: 'remove_measurement', id: editing })} />
        </Section>
      ) : null}
      {count ? (
        <RowGroup heading={C.measure.added}>
          {measurements.map((m, i) => (
            <AccountRow key={m.id} testID={`body-added-${m.id}`} label={measurementTitle(m)} value={formatLength(m)}
              onPress={() => send({ type: 'edit_measurement', id: m.id })} last={i === count - 1} />
          ))}
        </RowGroup>
      ) : null}
    </Screen>
  );
}

/* ---------------- results: descriptive only ---------------- */

function measurementDetail(m: ReportedMeasurement, advanced: boolean): string {
  const by = MEASURED_BY_COPY[m.provenance.measuredBy];
  if (!advanced) return `Measured by: ${by.toLowerCase()}`;
  const tool = m.provenance.instrument ? INSTRUMENT_COPY[m.provenance.instrument] : 'Instrument not given';
  return `${m.mm} mm · ${m.provenance.protocol} · ${by} · ${tool} · Reported, not verified`;
}

function Results({ state, send, advanced, nav, close }: PageProps) {
  const ratios = computeRatios(state.measurements);
  return (
    <Screen testID="body-results" nav={nav} footer={
      <StepFooter label={C.results.done} testID="body-done" onPress={() => close('done')}
        secondary={C.results.addAnother} onSecondary={() => { send({ type: 'new_measurement' }); send({ type: 'navigate', route: 'measure' }); }} />
    }>
      <Header eyebrow={C.results.eyebrow} title={C.results.title} />
      <RowGroup heading={C.results.measurementsHeading}>
        {state.measurements.map((m, i) => (
          <AccountRow key={m.id} testID={`body-result-${m.id}`} label={measurementTitle(m)} value={formatLength(m)}
            detail={measurementDetail(m, advanced)} onPress={() => send({ type: 'edit_measurement', id: m.id })}
            last={i === state.measurements.length - 1} />
        ))}
      </RowGroup>
      <RowGroup heading={C.results.ratiosHeading}>
        {ratios.map((r, i) => {
          const side = sideLabel(r.side);
          const label = side ? `${RATIOS[r.id].label} · ${side}` : RATIOS[r.id].label;
          const last = i === ratios.length - 1;
          if (r.status === 'missing') {
            return <AccountRow key={`${r.id}:${r.side}`} label={label} value="—" last={last}
              detail={C.results.needs(r.needs.map((c) => CONSTRUCTS[c].label))} />;
          }
          const detail = advanced
            ? `${r.numerator.mm} mm ÷ ${r.denominator.mm} mm. ${C.results.ratioDetail}`
            : C.results.ratioDetail;
          return <AccountRow key={`${r.id}:${r.side}`} testID={`body-ratio-${r.id}`} label={label} value={formatRatio(r.value)} detail={detail} last={last} />;
        })}
      </RowGroup>
      <Section tight>
        <Txt role="meta" tone="secondary">{C.results.meaning}</Txt>
        <Notice kind="info" captureId="body-ephemeral" text={C.results.ephemeral} />
      </Section>
    </Screen>
  );
}

/* ---------------- choices: read-only status for Settings ---------------- */

function ChoicesPage({ advanced, nav }: PageProps) {
  const summary = bodyPrivacySummary();
  const rows: readonly (readonly [BodyCapabilityId, BodyChoiceRow])[] = summary.status === 'ready'
    ? [['retainedPhotos', summary.photos], ['retainedMeasurements', summary.derived], ['improvementContribution', summary.improvement]]
    : [];
  return (
    <Screen testID="body-choices" nav={nav}>
      <Header title={C.choices.title} subtitle={C.choices.subtitle} />
      <RowGroup>
        {rows.map(([id, row], i) => {
          const capability = BODY_CAPABILITIES[id];
          return (
            <AccountRow key={id} testID={`body-privacy-${id}`} label={row.label} detail={capabilityDetail(capability)}
              value={advanced ? `${row.value} · ${STATUS_LABEL[capability.status]}` : row.value} last={i === rows.length - 1} />
          );
        })}
      </RowGroup>
      <RowGroup>
        <AccountRow label={C.choices.session} detail={C.choices.sessionDetail} last />
      </RowGroup>
      <Section tight><Txt role="meta" tone="secondary">{C.choices.footnote}</Txt></Section>
    </Screen>
  );
}

/* ---------------- limits ---------------- */

function Limits({ nav }: PageProps) {
  return (
    <Screen testID="body-limits-page" nav={nav}>
      <Header title={C.limits.title} subtitle={C.limits.subtitle} />
      <RowGroup>
        {C.limits.items.map((item, i) => (
          <AccountRow key={item.title} label={item.title} detail={item.detail} last={i === C.limits.items.length - 1} />
        ))}
      </RowGroup>
    </Screen>
  );
}

const s = StyleSheet.create({
  cover: {
    flex: 1, backgroundColor: t.color.canvas, alignItems: 'center', justifyContent: 'center', paddingHorizontal: L.frame.gutter,
  },
});
