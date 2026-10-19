import { useEffect, useState } from 'react';
import { createAccountLifecycleController, type LifecycleContext } from './controller';
import { Gutter, Nav, PrimaryAction, Screen, Section, StatusLine, Subtitle, TextAnswer, Title, Txt } from '../features/shared/ui';

export type AccountLifecycleScreenProps = { context: LifecycleContext; onBack(): void };
export function AccountLifecycleScreen({ context, onBack }: AccountLifecycleScreenProps) {
  return <LifecycleSession key={`${context.api.baseURL}:${context.accountId}:${context.sessionKey}`} context={context} onBack={onBack} />;
}
function LifecycleSession({ context, onBack }: AccountLifecycleScreenProps) {
  const [controller, setController] = useState<ReturnType<typeof createAccountLifecycleController> | null>(null);
  const [, render] = useState(0);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  useEffect(() => {
    const next = createAccountLifecycleController(context);
    const unsubscribe = next.subscribe(() => render(value => value + 1));
    setController(next);
    void next.initialize();
    return () => { unsubscribe(); next.dispose(); };
  }, [context.accountId, context.sessionKey, context.api.baseURL]);
  const state = controller?.snapshot();
  const pending = !state || state.phase === 'pending' || state.phase === 'loading';
  const blocked = pending || state?.phase === 'unknown' || state?.phase === 'disabled' || state?.phase === 'disposed';
  const consumePassword = (action: (value: string) => Promise<void>) => {
    const value = password; setPassword(''); setConfirmation(''); void action(value);
  };
  return <Screen testID="account-lifecycle" nav={<Nav back="Account" onBack={onBack} />}>
    <Gutter><Title text="Your account data" />
      <Subtitle text="Export available records or request account deletion. Some retained data and external copies remain outside these actions." />
      <StatusLine testID="lifecycle-status" text={state?.message || 'Loading account data options…'} />
    </Gutter>
    <Section>
      <Txt role="sectionTitle">Export</Txt>
      <Txt role="body">Exports include a manifest of missing or retained data. A complete copy of all data is not available.</Txt>
      {!state?.exportAvailable ? <StatusLine text="Export delivery is unavailable on this connection or device." /> : null}
      {!blocked && (state?.exportAvailable || state?.receipt?.phase === 'awaiting_reauthentication') ?
        <TextAnswer label="Account password" value={password} onChangeText={setPassword} secure maxLength={128}
          autoCapitalize="none" autoComplete="current-password" testID="lifecycle-password" /> : null}
      <PrimaryAction label="Export available data" captureId="lifecycle-export" disabled={blocked || !state?.exportAvailable || !!state?.canCheckStatus || !password}
        onPress={() => controller && consumePassword(value => controller.exportAccount(value))} />
    </Section>
    <Section>
      <Txt role="sectionTitle">Delete account</Txt>
      <Txt role="body">Confirming disables account access. Full erasure is incomplete, backup expiry is unknown, and subscriptions are not cancelled by this action.</Txt>
      {!state?.deletionAvailable && !state?.canCheckStatus ? <StatusLine text="Account deletion is unavailable. Secure recovery receipt storage and a configured service are required." /> : null}
      {!state?.canCheckStatus ? <PrimaryAction label="Review account deletion" captureId="lifecycle-request"
        disabled={blocked || !state?.deletionAvailable} onPress={() => { void controller?.requestDeletion(); }} /> : null}
      {state?.receipt?.phase === 'awaiting_reauthentication' && !blocked ? <>
        <TextAnswer label="Type DELETE to confirm" value={confirmation} onChangeText={setConfirmation} maxLength={6}
          autoCapitalize="characters" testID="lifecycle-confirmation" />
        <PrimaryAction label="Disable account and request erasure" captureId="lifecycle-confirm"
          disabled={!password || confirmation !== 'DELETE'} onPress={() => controller && consumePassword(value => controller.confirmDeletion(value, confirmation))} />
      </> : null}
      {state?.canCheckStatus ? <PrimaryAction label="Check deletion status" captureId="lifecycle-status-check" disabled={pending}
        onPress={() => { void controller?.checkStatus(); }} /> : null}
      {state?.receipt ? <>
        <StatusLine text={`Request ${state.receipt.requestId}`} />
        <StatusLine text={state.receipt.localPurged ? 'Local purge reported; full erasure remains incomplete.' : 'Local purge is not confirmed.'} />
        {state.receipt.steps.map(step => <StatusLine key={step.category} text={`${step.category}: ${step.status}`} />)}
        <StatusLine text="Backup expiry: unknown. Billing cancellation: not performed." />
      </> : null}
    </Section>
  </Screen>;
}
