import { useLayoutEffect, useRef, useState } from 'react';
import type { createChangeEmailController, CredentialTransition } from '../model';
import { Gutter, Nav, Notice, PlainAction, PrimaryAction, Screen, Stack, TextAnswer, Title } from '../../shared/ui';

export type ChangeEmailScreenProps = Readonly<{
  controller: ReturnType<typeof createChangeEmailController>;
  onBack: () => void;
  onCompletion: (transition: Extract<CredentialTransition, { reason: 'email-changed' }>) => void;
  /** Host-owned account-settings readback only; never replay the confirmation. */
  onReconcile?: () => Promise<void>;
}>;

const identities = new WeakMap<ChangeEmailScreenProps['controller'], number>();
let nextIdentity = 0;
export function ChangeEmailScreen(props: ChangeEmailScreenProps) {
  let identity = identities.get(props.controller);
  if (identity === undefined) { identity = ++nextIdentity; identities.set(props.controller, identity); }
  return <Presentation key={identity} {...props} />;
}

function Presentation(props: ChangeEmailScreenProps) {
  const { controller } = props;
  const [snapshot, setSnapshot] = useState(() => controller.snapshot());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [show, setShow] = useState(false);
  const [reading, setReading] = useState(false);
  const [readNotice, setReadNotice] = useState<string | null>(null);
  const fields = useRef({ email: '', password: '', otp: '' });
  const owner = useRef<ChangeEmailScreenProps | null>(null);
  const lifetime = useRef<object | null>(null);
  const departed = useRef(false);
  const completed = useRef(false);
  const readFlight = useRef(false);
  useLayoutEffect(() => { owner.current = props; });
  useLayoutEffect(() => {
    const token = {};
    lifetime.current = token;
    const update = () => { if (lifetime.current === token) setSnapshot(controller.snapshot()); };
    const unsubscribe = controller.subscribe(update);
    update();
    return () => {
      lifetime.current = null; owner.current = null;
      fields.current = { email: '', password: '', otp: '' };
      setEmail(''); setPassword(''); setOtp(''); setShow(false);
      unsubscribe();
    };
  }, [controller]);
  const owns = () => lifetime.current !== null && owner.current === props && !departed.current;
  const blocked = () => ['pending', 'disposed'].includes(controller.snapshot().status);
  const request = () => {
    if (!owns() || blocked() || controller.snapshot().step !== 'email') return;
    const secret = fields.current.password;
    fields.current.password = ''; setPassword('');
    void controller.requestCode(fields.current.email, secret);
  };
  const confirm = () => {
    const current = controller.snapshot();
    if (!owns() || blocked() || current.step !== 'code' || current.status === 'unknown') return;
    const secret = fields.current.otp;
    fields.current.otp = ''; setOtp('');
    void controller.confirm(secret);
  };
  const back = () => {
    if (!owns()) return;
    departed.current = true;
    fields.current = { email: '', password: '', otp: '' };
    setEmail(''); setPassword(''); setOtp('');
    props.onBack();
  };
  const complete = () => {
    if (!owns() || completed.current) return;
    const transition = controller.transition();
    if (!transition || transition.reason !== 'email-changed') return;
    completed.current = true; departed.current = true;
    props.onCompletion(transition);
  };
  const reconcile = async () => {
    if (!owns() || readFlight.current || !props.onReconcile || controller.snapshot().status !== 'unknown'
      || controller.snapshot().step !== 'code') return;
    const token = lifetime.current;
    readFlight.current = true; setReading(true); setReadNotice(null);
    try {
      await props.onReconcile();
      if (owns() && lifetime.current === token) setReadNotice('Account details refreshed. Return to settings to review your email.');
    } catch {
      if (owns() && lifetime.current === token) setReadNotice('Account details could not be refreshed. Return to settings and try the read again.');
    } finally {
      if (lifetime.current === token) { readFlight.current = false; setReading(false); }
    }
  };
  const unavailable = snapshot.status === 'pending' || snapshot.status === 'disposed';
  return <Screen testID="screen-change-email" nav={<Nav back="Settings" onBack={back} />}>
    <Gutter><Title text="Change email" /></Gutter>
    <Gutter><Stack gap="s16">
      {snapshot.notice ? <Notice kind={snapshot.issue ? 'error' : 'info'} text={snapshot.notice} announce /> : null}
      {snapshot.status === 'pending' ? <Notice kind="info" text="Wait for the current request to finish, or return to settings." /> : null}
      {snapshot.status === 'disposed' ? <Notice kind="info" text="This email change is no longer active. Return to settings." /> : null}
      {snapshot.step === 'email' ? <>
        <TextAnswer label="New email" value={email} keyboardType="email-address" autoComplete="email" autoCapitalize="none"
          onChangeText={value => { if (owns() && !blocked()) { fields.current.email = value; setEmail(value); } }} />
        <TextAnswer label="Current password" value={password} secure={!show} autoComplete="current-password" textContentType="password" autoCapitalize="none" onSubmitEditing={request}
          onChangeText={value => { if (owns() && !blocked()) { fields.current.password = value; setPassword(value); } }}
          trailing={<PlainAction label={show ? 'Hide password' : 'Show password'} chevron={null}
            onPress={() => { if (owns()) setShow(!show); }} />} />
        <PrimaryAction label="Send code" disabled={unavailable} onPress={request} />
      </> : snapshot.step === 'code' ? <>
        <TextAnswer label="8-digit code" value={otp} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" onSubmitEditing={confirm}
          onChangeText={value => { if (owns() && !blocked() && controller.snapshot().status !== 'unknown') { fields.current.otp = value; setOtp(value); } }} />
        <PrimaryAction label="Confirm email" disabled={unavailable || snapshot.status === 'unknown'} onPress={confirm} />
        {snapshot.status === 'unknown' ? <>
          <Notice kind="info" text="Confirmation is unresolved. Read account details before attempting another change." />
          <PlainAction label="Refresh account details" disabled={!props.onReconcile || reading} onPress={() => void reconcile()} />
          {!props.onReconcile ? <Notice kind="info" text="Return to settings to refresh account details." /> : null}
        </> : null}
      </> : <>
        {snapshot.refreshRequired ? <Notice kind="info" text="Email changed. Account details still need refreshing in settings." /> : null}
        <PrimaryAction label="Continue" disabled={snapshot.status !== 'saved'} onPress={complete} />
      </>}
      {readNotice ? <Notice kind="info" text={readNotice} announce /> : null}
    </Stack></Gutter>
  </Screen>;
}
