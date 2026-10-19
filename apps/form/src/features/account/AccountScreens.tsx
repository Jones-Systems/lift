// account + access (form-onboarding v1). Values come from the server; edits go through revision-guarded saves.
// Account deletion is unavailable (root direction): one static row, no action, no request path, no success state.
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ApiError } from '../../api/client';
import type { Account, AppMode, Capabilities, Entitlements, Preferences, Profile } from '../../api/domain';
import type { FormResources } from '../../api/resources';
import type { AccountSettings, SignInMethod } from '../../api/settings';
import type { SaveResult } from '../contract';
import { useBusy, useCommandKey } from '../shared/commands';
import { COPY, errorCopy, shortDate } from '../shared/copy';
import {
  AREAS, CM_PER_IN, COACH_STYLES, KG_PER_LB, areasList, coachStyleOf, heightLabel, parseInjury, serializeInjury, weightLabel,
  type InjuryAnswer, type InjuryArea,
} from '../onboarding/model';
import { t } from '../shared/tokens';
import {
  AccountRow, ChipChoice, ChipSet, ChoiceRow, Choices, Fields, Gutter, Nav, Notice, OutlineAction, PlainAction, PrimaryAction,
  RowGroup, Screen, Section, Segmented, Sheet, StepperField, Subtitle, TextAnswer, Title, Txt,
} from '../shared/ui';

type Banner = { kind: 'error' | 'info' | 'success'; text: string; retry?: () => void } | null;
type EditSheet = 'coach' | 'body' | 'injuries' | null;

// 'settings' is kept for source compatibility; DGR-001 (v2) removed the Account → Settings row.
export type AccountRowId = 'plans' | 'cues' | 'access' | 'settings' | 'body-assessment';

export function AccountScreen({ account, settings, capabilities, entitlements, planCount, hasBodySeam, onBack, onRow,
  savePreferences, saveProfile, signOut }: {
  account: Account;
  settings: AccountSettings | null;
  capabilities: Capabilities | null;
  entitlements: Entitlements | null;
  planCount: number;
  hasBodySeam: boolean;
  onBack: () => void;
  onRow: (row: AccountRowId) => void;
  savePreferences: (changes: Partial<Omit<Preferences, 'revision'>>) => Promise<SaveResult<Preferences>>;
  saveProfile: (changes: Partial<Omit<Profile, 'revision'>>) => Promise<SaveResult<Profile>>;
  signOut: () => Promise<SaveResult<null>>;
}) {
  const [sheet, setSheet] = useState<EditSheet>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [signingOut, setSigningOut] = useState(false);
  const { profile, preferences } = account;
  const injury = parseInjury(profile.injuryHistory);
  const style = coachStyleOf(preferences);
  const body = [profile.heightCm ? heightLabel(profile.heightCm, preferences.heightUnit) : null,
    profile.weightKg ? weightLabel(profile.weightKg, preferences.loadUnit) : null].filter(Boolean).join(', ');
  const grant = activeGrant(entitlements);
  const email = settings?.identity.email ?? null;

  const doSignOut = async (attempt?: () => Promise<SaveResult<null>>) => {
    setSigningOut(true); setBanner(null);
    try {
      const result = await (attempt ?? signOut)();
      if (result.status === 'unknown') setBanner({ kind: 'error', text: 'Sign-out could not be confirmed. Try again.', retry: () => void doSignOut(result.retry) });
      else if (result.status === 'failed') setBanner({ kind: 'error', text: errorCopy(result.error), retry: () => void doSignOut() });
    } finally { setSigningOut(false); }
  };

  return (
    <>
      <Screen testID="screen-account" nav={<Nav back="Today" onBack={onBack} />}>
        <Gutter>
          <Title text="Account" testID="a-account-title" />
          <Subtitle text={[profile.name, email].filter(Boolean).join(', ')} />
        </Gutter>
        {banner ? <Section tight><Notice kind={banner.kind} text={banner.text} announce action={banner.retry ? { label: 'Try again', onPress: banner.retry } : null} /></Section> : null}
        <RowGroup heading="Your training">
          <AccountRow label="Plans" value={`${planCount} ${planCount === 1 ? 'plan' : 'plans'}`} testID="a-row-plans" onPress={() => onRow('plans')} />
          <AccountRow label="Coach style" value={style?.title ?? 'Not set'} testID="a-row-coach" onPress={() => setSheet('coach')} />
          <AccountRow label="Cues" value="By movement" testID="a-row-cues" onPress={() => onRow('cues')} />
          <AccountRow label="Body details" value={body || 'Not shared'} testID="a-row-body" onPress={() => setSheet('body')} />
          <AccountRow label="Work around" value={injury.areas.length ? areasList(injury.areas) : injury.note ? 'Noted' : 'Nothing noted'}
            testID="a-row-injury" onPress={() => setSheet('injuries')} last={!hasBodySeam} />
          {hasBodySeam ? <AccountRow label="Body assessment" testID="a-row-body-assessment" onPress={() => onRow('body-assessment')} last /> : null}
        </RowGroup>
        <RowGroup heading="Access">
          <AccountRow label="Form access" testID="a-row-access" onPress={() => onRow('access')} last
            detail={grant ? `${sourceLabel(grant.source)}, ${grant.expiresAt ? `active until ${shortDate(grant.expiresAt)}` : 'active'}` : 'Not active'} />
        </RowGroup>
        {settings ? (
          <RowGroup heading="Sign-in methods">
            <AccountRow label="Email" value={methodValue('emailPassword', settings, capabilities)} />
            <AccountRow label="Apple" value={methodValue('apple', settings, capabilities)} />
            <AccountRow label="Google" value={methodValue('google', settings, capabilities)} />
            <AccountRow label="Phone" value={methodValue('phone', settings, capabilities)} />
            <AccountRow label="Account deletion" value="Unavailable" testID="a-delete-status" last />
          </RowGroup>
        ) : (
          <RowGroup heading="Sign-in methods">
            <AccountRow label="Account deletion" value="Unavailable" testID="a-delete-status" last />
          </RowGroup>
        )}
        <Section tight style={s.bottom}>
          <PlainAction label="Sign out" captureId="a-sign-out" chevron={null} disabled={signingOut} onPress={() => void doSignOut()} />
        </Section>
      </Screen>
      <CoachSheet visible={sheet === 'coach'} preferences={preferences} onClose={() => setSheet(null)} save={savePreferences} />
      <BodySheet visible={sheet === 'body'} profile={profile} preferences={preferences} onClose={() => setSheet(null)}
        saveProfile={saveProfile} savePreferences={savePreferences} />
      <InjurySheet visible={sheet === 'injuries'} answer={injury} onClose={() => setSheet(null)} save={saveProfile} />
    </>
  );
}

function methodValue(method: SignInMethod, settings: AccountSettings, capabilities: Capabilities | null): string {
  if (settings.identity.signInMethods.includes(method)) return 'Connected';
  const status = method === 'emailPassword' ? capabilities?.authentication.emailPassword.status
    : capabilities?.authentication[method].status;
  return status && status !== 'unconfigured' ? 'Not connected' : 'Not set up yet';
}

export function activeGrant(entitlements: Entitlements | null) {
  return entitlements?.grants.find((g) => g.active) ?? null;
}

export function sourceLabel(source: string): string {
  if (source === 'promo') return 'Promo code';
  if (source === 'apple') return 'App Store';
  return source;
}

/* ---------------- edit sheets (onboarding answers, edited in place) ---------------- */

export function useSheetSave<T>(onClose: () => void) {
  const { busy, run: single } = useBusy();
  const [banner, setBanner] = useState<Banner>(null);
  const run = (attempt: () => Promise<SaveResult<T>>): Promise<void> => single(async () => {
    setBanner(null);
    const result = await attempt();
    if (result.status === 'saved') onClose();
    else if (result.status === 'stale') setBanner({ kind: 'info', text: COPY.stale });
    else if (result.status === 'unknown') setBanner({ kind: 'error', text: 'The result could not be confirmed. Retry this same action without changing it.', retry: () => void run(result.retry) });
    else setBanner({ kind: 'error', text: errorCopy(result.error) });
  });
  const notice = banner ? <Notice kind={banner.kind} text={banner.text} announce action={banner.retry ? { label: 'Try again', onPress: banner.retry } : null} /> : null;
  return { busy, run, notice, reset: () => setBanner(null) };
}

export function CoachSheet({ visible, preferences, onClose, save }: {
  visible: boolean; preferences: Preferences; onClose: () => void;
  save: (changes: Partial<Omit<Preferences, 'revision'>>) => Promise<SaveResult<Preferences>>;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const close = () => { setChoice(null); onClose(); };
  const { busy, run, notice } = useSheetSave<Preferences>(close);
  const selected = choice ?? coachStyleOf(preferences)?.id ?? null;
  const picked = COACH_STYLES.find((c) => c.id === selected);
  return (
    <Sheet visible={visible} title="How should your coach talk to you?" onClose={close} closeTestID="a-coach-close"
      actions={<PrimaryAction label="Save changes" disabled={!picked} loading={busy} onPress={() => picked && void run(() => save({ ...picked.prefs }))} />}>
      {notice}
      <Choices>
        {COACH_STYLES.map((c) => <ChoiceRow key={c.id} title={c.title} detail={c.detail} selected={selected === c.id} onPress={() => setChoice(c.id)} />)}
      </Choices>
    </Sheet>
  );
}

export function BodySheet({ visible, profile, preferences, onClose, saveProfile, savePreferences }: {
  visible: boolean; profile: Profile; preferences: Preferences; onClose: () => void;
  saveProfile: (changes: Partial<Omit<Profile, 'revision'>>) => Promise<SaveResult<Profile>>;
  savePreferences: (changes: Partial<Omit<Preferences, 'revision'>>) => Promise<SaveResult<Preferences>>;
}) {
  const [cm, setCm] = useState<number | null | undefined>(undefined);
  const [kg, setKg] = useState<number | null | undefined>(undefined);
  const [metric, setMetric] = useState<boolean | undefined>(undefined);
  const close = () => { setCm(undefined); setKg(undefined); setMetric(undefined); onClose(); };
  const { busy, run, notice } = useSheetSave<Profile>(close);
  const height = cm === undefined ? profile.heightCm : cm;
  const weight = kg === undefined ? profile.weightKg : kg;
  const isMetric = metric ?? preferences.heightUnit === 'cm';
  const inches = height === null ? null : Math.round(height / CM_PER_IN);
  const save = async (): Promise<SaveResult<Profile>> => {
    const unitChanged = isMetric !== (preferences.heightUnit === 'cm');
    if (unitChanged) {
      const units = await savePreferences({ heightUnit: isMetric ? 'cm' : 'ft-in', loadUnit: isMetric ? 'kg' : 'lb' });
      if (units.status !== 'saved') return units.status === 'failed' ? units : { status: 'failed', error: new ApiError(409, 'stale_revision', COPY.stale) };
    }
    return saveProfile({ heightCm: height === null ? null : Math.round(height * 10) / 10, weightKg: weight === null ? null : Math.round(weight * 10) / 10 });
  };
  return (
    <Sheet visible={visible} title="Body details" onClose={close} closeTestID="a-body-close"
      actions={<PrimaryAction label="Save changes" loading={busy} onPress={() => void run(save)} />}>
      {notice}
      <Segmented selected={isMetric ? 'metric' : 'imperial'} items={[{ value: 'metric', label: 'cm, kg' }, { value: 'imperial', label: 'ft, lb' }]}
        onSelect={(v) => setMetric(v === 'metric')} />
      <Fields>
        <StepperField label={isMetric ? 'Height, cm' : 'Height, ft in'}
          value={height === null || inches === null ? '—' : isMetric ? String(Math.round(height)) : `${Math.floor(inches / 12)}′ ${inches % 12}″`}
          onStep={(d) => setCm(height === null || inches === null ? 170 : Math.min(260, Math.max(50, isMetric ? Math.round(height) + d : (inches + d) * CM_PER_IN)))} />
        <StepperField label={isMetric ? 'Weight, kg' : 'Weight, lb'}
          value={weight === null ? '—' : isMetric ? String(Math.round(weight * 2) / 2) : String(Math.round(weight / KG_PER_LB))}
          onStep={(d) => setKg(weight === null ? 70 : Math.min(500, Math.max(15, isMetric ? Math.round(weight * 2) / 2 + d * 0.5 : (Math.round(weight / KG_PER_LB) + d) * KG_PER_LB)))} />
      </Fields>
      {height !== null || weight !== null ? (
        <PlainAction label="Clear body details" chevron={null} onPress={() => { setCm(null); setKg(null); }} />
      ) : null}
    </Sheet>
  );
}

export function InjurySheet({ visible, answer, onClose, save }: {
  visible: boolean; answer: InjuryAnswer; onClose: () => void;
  save: (changes: Partial<Omit<Profile, 'revision'>>) => Promise<SaveResult<Profile>>;
}) {
  const [draft, setDraft] = useState<InjuryAnswer | null>(null);
  const close = () => { setDraft(null); onClose(); };
  const { busy, run, notice } = useSheetSave<Profile>(close);
  const value = draft ?? answer;
  const changedAreas = JSON.stringify([...value.areas].sort()) !== JSON.stringify([...answer.areas].sort());
  return (
    <Sheet visible={visible} large title="Anything we should work around?" onClose={close} closeTestID="a-injury-close"
      actions={(
        <>
          <PrimaryAction label="Save changes" loading={busy}
            onPress={() => void run(() => save({ injuryHistory: serializeInjury({ ...value, skipped: false, worsening: changedAreas ? null : value.worsening }) }))} />
        </>
      )}>
      {notice}
      <Txt role="body" tone="secondary">Old injuries, sore spots or surgeries. This isn’t a diagnosis.</Txt>
      <ChipSet>
        {AREAS.map((a) => {
          const on = value.areas.includes(a.key);
          return <ChipChoice key={a.key} label={a.label} selected={on}
            onPress={() => setDraft({ ...value, areas: on ? value.areas.filter((k) => k !== a.key) : [...value.areas, a.key as InjuryArea] })} />;
        })}
      </ChipSet>
      <TextAnswer label="Anything to add?" value={value.note} onChangeText={(note) => setDraft({ ...value, note })} placeholder="Type it" multiline maxLength={3000} />
    </Sheet>
  );
}

/* ---------------- access ---------------- */

export function AccessScreen({ resources, entitlements, onBack, onChanged, onMemberships, onUnauthenticated }: {
  resources: FormResources; entitlements: Entitlements | null; onBack: () => void;
  onChanged: (entitlements: Entitlements) => void; onMemberships?: () => void; onUnauthenticated: () => void;
}) {
  const [code, setCode] = useState('');
  const { busy, run: single } = useBusy();
  const [banner, setBanner] = useState<Banner>(null);
  const redeem = useCommandKey();
  const grant = activeGrant(entitlements);
  const purchasesConfigured = !!entitlements && entitlements.purchases.status !== 'unconfigured';
  const normalized = code.trim();
  const valid = /^[A-Za-z0-9_-]{3,64}$/.test(normalized);

  const submit = (): Promise<void> => single(async () => {
    if (!valid) return;
    setBanner(null);
    const key = redeem.keyFor({ op: 'redeem', code: normalized });
    try {
      await resources.redeem(normalized, key);
      redeem.settle();
      onChanged(await resources.entitlements());
      setCode('');
    } catch (error) {
      if (error instanceof ApiError && error.effectUnknown) {
        setBanner({ kind: 'error', text: error.message, retry: () => void submit() }); // same key and code
      } else {
        redeem.settle();
        if (error instanceof ApiError && error.status === 401) onUnauthenticated();
        else setBanner({ kind: 'error', text: errorCopy(error) });
      }
    }
  });

  return (
    <Screen testID="screen-access" nav={<Nav back="Account" onBack={onBack} />}>
      <Gutter><Title text="Form access" testID="a-access-title" /></Gutter>
      {grant ? (
        <Section>
          <Notice kind="success" captureId="a-access-active"
            text={grant.expiresAt ? `Form access is active until ${shortDate(grant.expiresAt)}. You won’t be charged.` : 'Form access is active. You won’t be charged.'} />
          <View>
            <AccountRow label="Granted by" value={sourceLabel(grant.source)} />
            <AccountRow label="Charges" value="None" />
            <AccountRow label="Renews" value={grant.source === 'apple' ? 'Through the App Store' : grant.expiresAt ? `No, ends ${shortDate(grant.expiresAt)}` : 'No end date'} last />
          </View>
        </Section>
      ) : (
        <>
          <Gutter><Subtitle text="Have a family or promo code? Redeem it here. Codes never charge you." /></Gutter>
          <Section style={s.gap16}>
            {banner ? <Notice kind={banner.kind === 'success' ? 'success' : banner.kind} text={banner.text} captureId="a-access-error" announce
              action={banner.retry ? { label: 'Try again', onPress: banner.retry } : null} /> : null}
            <TextAnswer label="Code" value={code} onChangeText={setCode} placeholder="Enter your code" testID="a-code-field"
              autoCapitalize="characters" maxLength={64} error={!!banner && !banner.retry} onSubmitEditing={() => void submit()} />
            <PrimaryAction label="Redeem code" captureId="a-redeem" disabled={!valid} loading={busy} onPress={() => void submit()} />
            {purchasesConfigured && onMemberships ? (
              <View style={s.memberships}>
                <Txt role="bodyStrong">Memberships</Txt>
                <Txt role="meta" tone="secondary">Purchases go through the App Store. In test builds they use Apple’s sandbox and nothing is charged.</Txt>
                <OutlineAction label="See membership options" testID="a-see-memberships" onPress={onMemberships} />
              </View>
            ) : null}
          </Section>
        </>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  bottom: { marginBottom: t.space.s24 },
  gap16: { gap: t.space.s16 },
  memberships: { marginTop: t.space.s48, gap: t.space.s12 },
});
