import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { normalizeCredentialEmail, validCredentialEmail, validNewPassword } from '../../../api/credentials';
import type { createForgotPasswordController } from '../model';
import { t } from '../../shared/tokens';
import { Gutter, Nav, Notice, PlainAction, PrimaryAction, Screen, Stack, Subtitle, TextAnswer, Title } from '../../shared/ui';

type Controller = ReturnType<typeof createForgotPasswordController>;
export type ForgotPasswordScreenProps = {
  controller: Controller;
  onBack: () => void;
  onSignIn: (transition: ReturnType<Controller['transition']>) => void;
};

export function ForgotPasswordScreen(props: ForgotPasswordScreenProps) {
  const identity = useRef({ controller: props.controller, generation: 0 });
  if (identity.current.controller !== props.controller) {
    identity.current = { controller: props.controller, generation: identity.current.generation + 1 };
  }
  return <Presentation key={identity.current.generation} {...props} />;
}

function Presentation({ controller, onBack, onSignIn }: ForgotPasswordScreenProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!state.resendAt || state.step === 'done' || state.status === 'disposed') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.resendAt, state.step, state.status]);
  const blocked = state.status === 'pending' || state.status === 'disposed';
  const available = () => mounted.current && !['pending', 'disposed'].includes(controller.snapshot().status);
  const clear = () => { setOtp(''); setPassword(''); setShow(false); };
  const request = () => {
    if (!available()) return;
    const current = controller.snapshot();
    const target = current.step === 'code' ? current.email : normalizeCredentialEmail(email);
    if (!validCredentialEmail(target)) return;
    clear();
    void controller.requestCode(target);
  };
  const submit = () => {
    if (!available() || controller.snapshot().status === 'unknown' || !/^[0-9]{8}$/.test(otp) || !validNewPassword(password)) return;
    const code = otp, secret = password;
    clear();
    void controller.submit(code, secret);
  };
  const signIn = () => {
    if (!mounted.current) return;
    const transition = controller.transition();
    clear();
    onSignIn(transition);
  };
  const seconds = Math.max(0, Math.ceil((state.resendAt - now) / 1000));
  return <Screen testID={`screen-forgot-password-${state.step}`} nav={<Nav back="Sign in" onBack={() => { if (mounted.current) { clear(); onBack(); } }} />}>
    <Gutter>
      <Title text={state.step === 'email' ? 'Reset your password' : state.step === 'code' ? 'Enter your reset code' : 'Password reset'} />
      <Subtitle text={state.step === 'email' ? 'Enter the email for your Form password account.' : state.step === 'code' ? 'Use the 8-digit code and choose a new password between 12 and 128 characters.' : 'Return to sign in with your new password.'} />
    </Gutter>
    <Gutter style={{ marginTop: t.space.s32 }}><Stack gap="s20">
      {state.notice ? <Notice kind={state.status === 'failed' || state.status === 'unknown' ? 'error' : 'info'} text={state.notice} captureId="recovery-notice" announce /> : null}
      {state.status === 'disposed' ? <Notice kind="info" text="This password reset is no longer active. Return to sign in." /> : null}
      {state.step === 'email' ? <TextAnswer label="Email" value={email} onChangeText={value => { if (available()) setEmail(value); }} testID="recovery-email" keyboardType="email-address" autoComplete="email" textContentType="username" autoCapitalize="none" maxLength={254} /> : null}
      {state.step === 'code' ? <>
        <TextAnswer label="8-digit code" value={otp} onChangeText={value => { if (available()) setOtp(value.replace(/\D/g, '').slice(0, 8)); }} testID="recovery-code" keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={8} />
        <TextAnswer label="New password" value={password} onChangeText={value => { if (available()) setPassword(value); }} testID="recovery-password" secure={!show} autoComplete="new-password" textContentType="newPassword" autoCapitalize="none" maxLength={128} onSubmitEditing={submit}
          trailing={<PlainAction label={show ? 'Hide' : 'Show'} accessibilityLabel={show ? 'Hide password' : 'Show password'} chevron={null} disabled={blocked} onPress={() => { if (available()) setShow(!show); }} />} />
      </> : null}
    </Stack></Gutter>
    <Gutter style={{ marginTop: t.space.s32 }}><Stack gap="s8">
      {state.step === 'email' ? <PrimaryAction label="Send reset code" captureId="recovery-request" disabled={blocked || !validCredentialEmail(email) || seconds > 0} loading={state.status === 'pending'} onPress={request} /> : null}
      {state.step === 'code' ? <>
        <PrimaryAction label="Reset password" captureId="recovery-submit" disabled={blocked || state.status === 'unknown' || !/^[0-9]{8}$/.test(otp) || !validNewPassword(password)} loading={state.status === 'pending'} onPress={submit} />
        <PlainAction label="Send a new code" captureId="recovery-resend" chevron={null} disabled={blocked || seconds > 0} onPress={request} />
      </> : null}
      {seconds > 0 && state.step !== 'done' ? <Notice kind="info" text={`You can request a new code in ${seconds} seconds.`} /> : null}
      {state.status === 'pending' ? <Notice kind="info" text="A request is in progress. You can return to sign in, but leaving does not confirm whether it completed." /> : null}
      {state.step !== 'email' && state.step !== 'done' || state.status === 'unknown' ? <PlainAction label="Start over" captureId="recovery-start-over" chevron={null} disabled={blocked} onPress={() => { if (available()) { clear(); setEmail(''); controller.startOver(); } }} /> : null}
      <PlainAction label="Return to sign in" captureId="recovery-sign-in" chevron={null} onPress={signIn} />
    </Stack></Gutter>
  </Screen>;
}
