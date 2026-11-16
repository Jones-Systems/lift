import { useInsertionEffect, useLayoutEffect, useState } from 'react';
import type { AccountSecuritySlotContext } from '../../contract';
import { ChangePasswordScreen } from '../change-password';
import { ChangeEmailScreen } from '../change-email';
import { Gutter, Nav, Notice, PlainAction, Screen, Stack, Title } from '../../shared/ui';

export function AccountSecurityScreen(ctx: AccountSecuritySlotContext) {
  const host = ctx.credentialHost;
  return host ? <AdmittedSecurity key={ctx.sessionGeneration} host={host} /> : null;
}

function AdmittedSecurity({ host }: { host: NonNullable<AccountSecuritySlotContext['credentialHost']> }) {
  const [snapshot, setSnapshot] = useState(host.snapshot);
  useLayoutEffect(() => {
    const update = () => setSnapshot(host.snapshot());
    const unsubscribe = host.subscribe(update);
    update();
    return () => { unsubscribe(); host.disposeWhenFenced(); };
  }, [host]);
  // Insertion cleanup fences removal before sibling layout callbacks, without StrictMode effect replay disposal.
  // The admission retains controllers; layout subscription reattachment never creates or replays a command.
  useInsertionEffect(() => () => host.fence(), [host]);
  const current = host.snapshot();
  if (current !== snapshot) return null;
  if (snapshot.status === 'disposed') return null;
  if (snapshot.flow?.kind === 'password') return <ChangePasswordScreen controller={snapshot.flow.controller}
    onBack={() => void host.depart()} onContinue={() => host.complete()} />;
  if (snapshot.flow?.kind === 'email') return <ChangeEmailScreen controller={snapshot.flow.controller}
    onBack={() => void host.depart()} onCompletion={() => host.complete()} onReconcile={host.reconcile} />;
  if (snapshot.status === 'returning') return <Screen testID="screen-security-return">
    <Gutter><Title text="Account details" /><Stack gap="s16">
      {snapshot.completionNotice ? <Notice kind="success" text={snapshot.completionNotice} /> : null}
      <Notice kind={snapshot.readFailed ? 'error' : 'info'} text={snapshot.readFailed
        ? 'Account details could not be refreshed. Try the read again to return to Settings.'
        : 'Returning to Settings after refreshing your account details. Leaving a change does not cancel a request already sent.'} />
      <PlainAction label="Refresh account details" disabled={snapshot.reading} onPress={() => void host.retryReturn()} />
    </Stack></Gutter>
  </Screen>;
  const actions = host.available();
  return <Screen testID="screen-account-security" nav={<Nav back="Settings" onBack={() => void host.depart()} />}>
    <Gutter><Title text="Sign-in & security" /><Stack gap="s16">
      {actions.changePassword ? <PlainAction label="Change password" captureId="security-change-password"
        onPress={() => host.open('password')} /> : null}
      {actions.changeEmail ? <PlainAction label="Change email" captureId="security-change-email"
        onPress={() => host.open('email')} /> : null}
      {!actions.changePassword && !actions.changeEmail ? <Notice kind="info" text="Credential changes are not available for this account." /> : null}
    </Stack></Gutter>
  </Screen>;
}
