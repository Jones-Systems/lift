import { useLayoutEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { SettingsSlotContext } from '../features/contract';
import { activeGrant, sourceLabel } from '../features/account/AccountScreens';
import { EQUIPMENT, EXPERIENCE, GOALS, MAX_GOALS, areasList, coachStyleOf, heightLabel, parseInjury, weightLabel } from '../features/onboarding/model';
import { shortDate } from '../features/shared/copy';
import { L, t } from '../features/shared/tokens';
import {
  AccountRow, ChoiceRow, Choices, Footnote, Gutter, Nav, Notice, PlainAction, PrimaryAction,
  Screen, Segmented, Sheet, StatusLine, Subtitle, Title, Txt,
} from '../features/shared/ui';
import { LoadingSkeleton } from '../variants/a/components';
import { useTextScale } from '../variants/a/theme';
import { createSettingsController, type CommandState, type SessionCommand, type SettingsScreenProps } from './model';

export function useSettingsScreenModel(ctx: SettingsSlotContext) {
  const [controller] = useState(() => createSettingsController(ctx));
  const [{ snapshot, completedSession }, setState] = useState(() => ({
    snapshot: controller.snapshot(), completedSession: null as SessionCommand | null,
  }));

  // The shell keys this subtree by sessionKey, including a fresh sign-in of the same account.
  // Reset on effect setup also makes React's development setup/cleanup replay safe.
  useLayoutEffect(() => {
    controller.reset(ctx);
    const unsubscribe = controller.subscribe(() => {
      const next = controller.snapshot();
      setState(previous => ({ snapshot: next,
        completedSession: previous.snapshot.session?.command === 'revokeOtherSessions' &&
          previous.snapshot.session.state.status === 'pending' && next.active &&
          next.command.status === 'idle' && next.session === null
          ? 'revokeOtherSessions' : next.command.status === 'pending' ? null : previous.completedSession,
      }));
    });
    setState({ snapshot: controller.snapshot(), completedSession: null });
    return () => { unsubscribe(); controller.dispose(); };
  }, [controller]);
  useLayoutEffect(() => { controller.update(ctx); }, [controller, ctx]);

  return { ...ctx, ...controller.events(), snapshot, completedSession, retryCommand: controller.retry };
}

type SettingsViewModel = ReturnType<typeof useSettingsScreenModel>;

export function SettingsSlot(ctx: SettingsSlotContext) {
  return <SettingsScreen {...ctx} />;
}

export function SettingsScreen(ctx: SettingsScreenProps) {
  return <SessionSettings key={ctx.account.accountId} ctx={ctx} />;
}

function SessionSettings({ ctx }: { ctx: SettingsSlotContext }) {
  const model = useSettingsScreenModel(ctx);
  const [page, setPage] = useState<'settings' | 'privacy'>('settings');
  const [confirmation, setConfirmation] = useState<SessionCommand | null>(null);
  const [otherSessionsSaved, setOtherSessionsSaved] = useState(false);
  const { snapshot } = model;

  useLayoutEffect(() => {
    if (model.completedSession === 'revokeOtherSessions') {
      setConfirmation(null);
      setOtherSessionsSaved(true);
    }
  }, [model.completedSession]);

  if (!snapshot.active || !snapshot.account || !snapshot.facts) return null;
  const { account, facts, appModeControl } = snapshot;
  const { profile, preferences } = account;
  const blocked = snapshot.busy || snapshot.command.status === 'unknown' ||
    (snapshot.settings.status === 'ready' && snapshot.settings.refreshing);
  const injury = parseInjury(profile.injuryHistory);
  const body = [profile.heightCm !== null ? heightLabel(profile.heightCm, preferences.heightUnit) : null,
    profile.weightKg !== null ? weightLabel(profile.weightKg, preferences.loadUnit) : null].filter(Boolean).join(', ');
  const entitlements = ctx.entitlements?.accountId === account.accountId ? ctx.entitlements : null;
  const grant = activeGrant(entitlements);
  const access = grant
    ? grant.environment === 'Sandbox' ? 'Test access · no charge'
      : `${sourceLabel(grant.source)} · ${grant.expiresAt ? `active until ${shortDate(grant.expiresAt)}` : 'No end date'}`
    : entitlements ? 'Not active' : undefined;
  const openConfirmation = (command: SessionCommand) => {
    if (snapshot.session?.state.status === 'unknown') setConfirmation(snapshot.session.command);
    else if (!blocked) { setOtherSessionsSaved(false); setConfirmation(command); }
  };
  const sessionState = confirmation && snapshot.session?.command === confirmation ? snapshot.session.state : null;
  const closeConfirmation = () => setConfirmation(null);

  return <>
    {page === 'privacy' ? <PrivacyScreen model={model} onBack={() => setPage('settings')} /> : (
      <Screen testID="screen-settings" nav={<Nav back="Today" onBack={model.onBack} />}>
        <Gutter>
          <Title text="Settings" testID="a-settings-title" />
          <View testID="a-settings-identity"><Subtitle text={[facts.displayName, facts.email].filter(Boolean).join(' · ')} /></View>
        </Gutter>
        <SettingsGroup heading="App experience" first testID="a-mode-group">
          <View style={s.choiceGroup}>
            <Choices>
              {(['basic', 'advanced'] as const).map(mode => {
                const state = appModeControl.requested === mode &&
                  (appModeControl.state.status === 'pending' || appModeControl.state.status === 'unknown')
                  ? appModeControl.state.status : undefined;
                // Additive shared ChoiceRow state props are owned by the shell integration lane.
                const stateProps: { state?: 'pending' | 'unknown'; disabled: boolean } = { state, disabled: blocked };
                return <ChoiceRow key={mode} {...stateProps} testID={`a-mode-${mode}`}
                  title={mode === 'basic' ? 'Basic' : 'Advanced'}
                  detail={mode === 'basic' ? 'Your next workout, one movement at a time, simple totals.'
                    : 'Set-by-set targets, cue controls and detailed stats.'}
                  selected={facts.appModeKnown && appModeControl.value === mode}
                  onPress={() => { if (!blocked && (!facts.appModeKnown || appModeControl.value !== mode)) model.onSelectAppMode(mode); }} />;
              })}
            </Choices>
          </View>
          <CommandNotice state={appModeControl.state} onRetry={snapshot.canRetry ? model.onRetryAppMode : undefined}
            testID="a-mode-unknown" retryID="a-mode-retry" />
          <Footnote testID="a-mode-footnote" text="Applies everywhere you use Form with this account. Switching never deletes plans, workouts or history." />
        </SettingsGroup>
        <SettingsGroup heading="Profile">
          <View>
            <AccountRow label="Name" value={profile.name} testID="a-row-name" onPress={() => model.onRow('profile.name')} />
            <AccountRow label="Age" value={profile.age === null ? 'Not shared' : String(profile.age)} testID="a-row-age" onPress={() => model.onRow('profile.age')} />
            <AccountRow label="Body details" value={body || 'Not shared'} testID="a-row-body" onPress={() => model.onRow('profile.body')} />
            <AccountRow label="Experience" value={EXPERIENCE.find(item => item.value === profile.trainingBackground)?.title ?? 'Not set'}
              testID="a-row-experience" onPress={() => model.onRow('profile.background')} />
            <AccountRow label="Goals" value={profile.goals.slice(0, MAX_GOALS).map(goal => GOALS.find(item => item.key === goal)?.title ?? goal).join(', ') || 'Not set'}
              testID="a-row-goals" onPress={() => model.onRow('profile.goals')} />
            <AccountRow label="Work around" value={injury.areas.length ? areasList(injury.areas) : injury.note ? 'Noted' : 'Nothing noted'}
              testID="a-row-injury" onPress={() => model.onRow('profile.injuries')} last />
          </View>
        </SettingsGroup>
        <SettingsGroup heading="Training">
          <View>
            <AccountRow label="Plans" testID="a-row-plans" onPress={() => model.onRow('training.plans')} />
            <AccountRow label="Schedule" value={`${preferences.trainingDaysPerWeek} days · ${preferences.sessionMinutes} min`}
              testID="a-row-schedule" onPress={() => model.onRow('training.schedule')} />
            <AccountRow label="Equipment" value={preferences.equipment.map(key => EQUIPMENT.find(item => item.key === key)?.label ?? key).join(', ')}
              testID="a-row-equipment" onPress={() => model.onRow('training.equipment')} />
            <AccountRow label="Coach style" value={coachStyleOf(preferences)?.title ?? 'Not set'} testID="a-row-coach"
              onPress={() => model.onRow('training.coach')} last={!ctx.openCuesIndex} />
            {ctx.openCuesIndex ? <AccountRow label="Cues" value="By movement" testID="a-row-cues" onPress={() => model.onRow('training.cues')} last /> : null}
          </View>
        </SettingsGroup>
        <SettingsGroup heading="Units">
          <View pointerEvents={blocked ? 'none' : 'auto'} accessibilityState={{ disabled: blocked }}>
            <UnitRow label="Weight"><Segmented testID="a-unit-load" selected={preferences.loadUnit}
              items={[{ value: 'kg', label: 'kg' }, { value: 'lb', label: 'lb' }]}
              onSelect={value => { if (!blocked) model.onSetPreference('loadUnit', value); }} /></UnitRow>
            <UnitRow label="Height" last><Segmented testID="a-unit-height" selected={preferences.heightUnit}
              items={[{ value: 'cm', label: 'cm' }, { value: 'ft-in', label: 'ft in' }]}
              onSelect={value => { if (!blocked) model.onSetPreference('heightUnit', value); }} /></UnitRow>
          </View>
          {snapshot.preferenceWrite && snapshot.preferenceWrite.field !== 'appMode'
            ? <CommandNotice state={snapshot.preferenceWrite.state} onRetry={snapshot.canRetry ? () => void model.retryCommand() : undefined} /> : null}
          <Footnote text="Form stores kilograms and centimetres and converts them for display." />
        </SettingsGroup>
        <SettingsGroup heading="Notifications">
          <AccountRow label="Workout reminders" testID="a-reminders" last
            value={facts.reminders.value === null ? 'Not available yet' : facts.reminders.value ? 'On' : 'Off'} />
          <Footnote text={facts.reminders.description} testID="a-reminders-footnote" />
        </SettingsGroup>
        <SettingsGroup heading="Privacy & data">
          <View>
            <AccountRow label="Privacy & data" detail="Voice answers, body photos, your account" testID="a-row-privacy"
              onPress={() => setPage('privacy')} last={!ctx.openBody} />
            {ctx.openBody ? <AccountRow label="Body assessment" testID="a-row-body-assessment" onPress={() => model.onRow('privacy')} last /> : null}
          </View>
        </SettingsGroup>
        <SettingsGroup heading="Form access">
          <AccountRow label="Form access" detail={access} testID="a-row-access" onPress={() => model.onRow('access')} last />
        </SettingsGroup>
        <SettingsGroup heading="Sign-in & security">
          {snapshot.settings.status === 'loading' ? <>
            <LoadingSkeleton />
            <PlainAction label="Try again" chevron={null} disabled={blocked} onPress={model.onRefresh} />
          </> : snapshot.settings.status === 'error' ? <Notice kind="error" text={snapshot.settings.error.message}
            action={{ label: 'Try again', onPress: model.onRefresh }} /> : <>
            <View>{facts.signInMethods.map((method, index) => <AccountRow key={method}
              label={method === 'emailPassword' ? 'Email and password' : method === 'apple' ? 'Apple' : method === 'google' ? 'Google'
                : facts.phoneSuffix ? `Phone · ending ${facts.phoneSuffix}` : 'Phone'}
              value={method === 'emailPassword' ? facts.email : method === 'phone' ? undefined : 'Connected'}
              last={index === facts.signInMethods.length - 1} />)}</View>
            {snapshot.settings.refreshError ? <Notice kind="error" text={snapshot.settings.refreshError.message}
              action={{ label: 'Try again', onPress: model.onRefresh }} /> : null}
          </>}
          {facts.sessionCommands.includes('revokeOtherSessions') ? <PlainAction label="Sign out of other devices" tone="ink" chevron={null}
            captureId="a-revoke-others" disabled={blocked && snapshot.session?.command !== 'revokeOtherSessions'}
            onPress={() => openConfirmation('revokeOtherSessions')} /> : null}
          {facts.sessionCommands.includes('revokeAllSessions') ? <PlainAction label="Sign out everywhere" tone="ink" chevron={null}
            captureId="a-revoke-all" disabled={blocked && snapshot.session?.command !== 'revokeAllSessions'}
            onPress={() => openConfirmation('revokeAllSessions')} /> : null}
          {otherSessionsSaved ? <Notice kind="success" text="Signed out of your other devices." /> : null}
          <Footnote text="Signing out of Form doesn't sign you out of Apple or Google, and it doesn't cancel a membership." />
        </SettingsGroup>
        {ctx.openCommunitySettings || ctx.openFeatureRequests ? <SettingsGroup>
          <View>
            {ctx.openCommunitySettings ? <AccountRow label="Groups & sharing" testID="a-row-community"
              onPress={() => model.onRow('community.privacy')} last={!ctx.openFeatureRequests} /> : null}
            {ctx.openFeatureRequests ? <AccountRow label="Feature requests" testID="a-row-feature-requests"
              onPress={() => model.onRow('community.featureRequests')} last /> : null}
          </View>
        </SettingsGroup> : null}
        <SettingsGroup>
          <PlainAction label="Sign out" tone="ink" chevron={null} captureId="a-sign-out"
            disabled={blocked && snapshot.session?.command !== 'signOut'} onPress={() => openConfirmation('signOut')} />
          <StatusLine text="Account deletion isn't available yet." testID="a-deletion-status" />
        </SettingsGroup>
      </Screen>
    )}
    <Sheet visible={confirmation !== null} title={confirmation ? sessionTitles[confirmation] : ''}
      onClose={closeConfirmation} testID="a-signout-sheet" closeTestID="a-signout-close"
      actions={<>
        <PrimaryAction label={confirmation ? sessionLabels[confirmation] : 'Sign out'} captureId="a-signout-confirm"
          loading={sessionState?.status === 'pending'} disabled={blocked}
          onPress={() => { if (confirmation && !blocked) model.onSessionCommand(confirmation); }} />
        <PlainAction label="Cancel" chevron={null} placement="centered" captureId="a-signout-cancel" onPress={closeConfirmation} />
      </>}>
      <Txt tone="secondary">Your plans, workouts and settings stay in your account. Sign in again to see them.</Txt>
      {sessionState && (sessionState.status === 'unknown' || sessionState.status === 'failed') ? <Notice
        kind={sessionState.status === 'unknown' ? 'warning' : 'error'}
        text={confirmation === 'revokeOtherSessions' ? "We couldn't confirm your other devices were signed out."
          : confirmation === 'revokeAllSessions' ? 'You may still be signed in. Check your connection and try again.'
            : "You're still signed in. Check your connection and try again."}
        action={sessionState.status === 'unknown' ? snapshot.canRetry ? { label: 'Try again', onPress: model.onRetrySession } : null
          : { label: 'Try again', onPress: () => { if (confirmation) model.onSessionCommand(confirmation); } }} /> : null}
    </Sheet>
  </>;
}

const sessionLabels: Record<SessionCommand, string> = {
  signOut: 'Sign out', revokeOtherSessions: 'Sign out of other devices', revokeAllSessions: 'Sign out everywhere',
};
const sessionTitles: Record<SessionCommand, string> = {
  signOut: 'Sign out of Form on this iPhone?',
  revokeOtherSessions: "Sign out of Form on your other devices? You'll stay signed in here.",
  revokeAllSessions: 'Sign out of Form everywhere, including this iPhone?',
};

function PrivacyScreen({ model, onBack }: { model: SettingsViewModel; onBack: () => void }) {
  const body = model.bodyPrivacy;
  return <Screen testID="screen-settings-privacy" nav={<Nav back="Settings" onBack={onBack} />}>
    <Gutter><Title text="Privacy & data" testID="a-privacy-title" /></Gutter>
    <SettingsGroup heading="Voice answers" first>
      <StatusLine text="Voice answer availability hasn't been verified on this iPhone." testID="a-voice-status" />
    </SettingsGroup>
    <SettingsGroup heading="Body photos and measurements">
      {body?.status === 'ready' ? <>
        <View>{(['photos', 'derived', 'improvement'] as const).map((row, index, rows) => {
          const choice = body[row];
          const available = !!model.openBodyChoice && !/not available|not offered|unavailable/i.test(choice.value);
          return <AccountRow key={row} label={choice.label} value={choice.value} testID={`a-body-${row}`}
            onPress={available ? () => model.onBodyChoice(row) : undefined} last={index === rows.length - 1} />;
        })}</View>
        <Footnote text="These are separate choices. Turning one on never turns on another." />
      </> : body?.status === 'loading' ? <LoadingSkeleton />
        : body?.status === 'error' ? <Notice kind="error" text={body.error.message} />
          : <StatusLine text={body?.reason ?? "Body assessment isn't available yet."} testID="a-body-status" />}
    </SettingsGroup>
    <SettingsGroup heading="Your account">
      <StatusLine text="Account deletion isn't available yet." testID="a-deletion-status" />
    </SettingsGroup>
  </Screen>;
}

function CommandNotice({ state, onRetry, testID, retryID }: {
  state: CommandState; onRetry?: () => void; testID?: string; retryID?: string;
}) {
  if (state.status === 'idle' || state.status === 'pending') return null;
  return <Notice kind={state.status === 'unknown' ? 'warning' : state.status === 'conflict' ? 'info' : 'error'}
    text={state.status === 'unknown' ? "We couldn't confirm the change."
      : state.status === 'conflict' ? "Your settings changed on another device. We've loaded the latest." : state.error.message}
    captureId={testID} announce action={onRetry ? { label: 'Try again', captureId: retryID, onPress: onRetry } : null} />;
}

function SettingsGroup({ heading, first, children, testID }: {
  heading?: string; first?: boolean; children: ReactNode; testID?: string;
}) {
  return <Gutter style={[s.group, first && s.firstGroup]}><View testID={testID} style={s.groupContents}>
    {heading ? <Txt role="meta" tone="secondary" accessibilityRole="header">{heading}</Txt> : null}
    {children}
  </View></Gutter>;
}

function UnitRow({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
  const { large } = useTextScale();
  return <View style={[s.unitRow, last && s.lastRow, large && s.unitRowLarge]}>
    <Txt role="bodyStrong">{label}</Txt>{children}
  </View>;
}

// Screen-only group/unit geometry comes from v2 app/settings-training.css and the shared token source.
const s = StyleSheet.create({
  group: { marginTop: L.settings.groupGap },
  firstGroup: { marginTop: t.space.s24 },
  groupContents: { gap: t.space.s8 },
  choiceGroup: { marginTop: t.space.s4 },
  unitRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.s12,
    minHeight: L.choice.minHeight, borderBottomWidth: t.stroke.divider, borderBottomColor: t.color.line },
  lastRow: { borderBottomWidth: t.space.s0 },
  unitRowLarge: { flexDirection: 'column', alignItems: 'flex-start', paddingVertical: t.space.s8 },
});
