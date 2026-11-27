// sign-in, email and phone (form-onboarding v1). Providers appear only when the server reports them configured
// AND a client port exists; nothing is simulated. Every success comes from a stored server session.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AppState, View } from 'react-native';
import { createAuthSession, type AuthSession } from '../../integration/authSession';
import { ApiError } from '../../api/client';
import { phoneChallengeEnd } from '../../api/phoneSignIn';
import type { Capabilities } from '../../api/domain';
import type { FormResources } from '../../api/resources';
import type { IdentityPorts, PhoneAuthPort, PhoneChallenge } from '../contract';
import { useCommandKey } from '../shared/commands';
import { t } from '../shared/tokens';
import { COPY, errorCopy, isUserCancel } from '../shared/copy';
import {
  Art, Gutter, Nav, Notice, OutlineAction, PlainAction, PrimaryAction, Screen, Stack, Subtitle, TextAnswer, Title, Txt, Wordmark,
} from '../shared/ui';

type Provider = 'apple' | 'google' | 'phone';
type Route = { name: 'sign-in' } | { name: 'email'; mode: 'sign-in' | 'create' } | { name: 'phone' };

export function AuthFlow({ resources, capabilities, identity, notice, onAuthenticated, onRetryCapabilities }: {
  resources: FormResources;
  capabilities: Capabilities | null;
  identity?: IdentityPorts;
  /** Shown once on entry, e.g. the signed-out copy after a 401. */
  notice: string | null;
  onAuthenticated: () => void;
  onRetryCapabilities: () => void;
}) {
  const [route, setRoute] = useState<Route>({ name: 'sign-in' });
  const auth = useMemo(() => createAuthSession(resources.api, identity), [resources.api, identity]);
  const phoneLifecycle = useRef(0);
  const [, setPhoneLifecycle] = useState(0);
  useLayoutEffect(() => {
    auth.activate();
    const listener = AppState.addEventListener('change', state => {
      if (state === 'background') {
        auth.deactivate();
        setPhoneLifecycle(++phoneLifecycle.current);
      } else if (state === 'active' && !auth.isActive()) auth.activate();
    });
    return () => { listener.remove(); auth.deactivate(); };
  }, [auth]);
  const navigate = (next: Route) => { auth.invalidate(); setRoute(next); };
  const ports = { apple: identity?.apple, google: identity?.google, phone: auth.phone };
  const available = useMemo(() => {
    const auth = capabilities?.authentication;
    const on = (status: string | undefined) => !!status && status !== 'unconfigured';
    return {
      apple: on(auth?.apple.status) && !!ports.apple,
      google: on(auth?.google.status) && !!ports.google,
      phone: on(auth?.phone.status) && !!ports.phone,
    } satisfies Record<Provider, boolean>;
  }, [capabilities, identity?.apple, identity?.google, auth]);

  const showPhone = route.name === 'phone' && available.phone;
  const entry = route.name === 'email' ? (
    <EmailScreen auth={auth} capabilities={capabilities} mode={route.mode}
      onMode={(mode) => navigate({ name: 'email', mode })} onBack={() => navigate({ name: 'sign-in' })} onAuthenticated={onAuthenticated} />
  ) : !showPhone ? (
    <SignInScreen available={available} capabilitiesLoaded={!!capabilities} notice={notice}
      onEmail={() => navigate({ name: 'email', mode: 'sign-in' })} onPhone={() => navigate({ name: 'phone' })}
      onIdentity={async (p) => { await auth.identity(p); onAuthenticated(); }} onRetryCapabilities={onRetryCapabilities} />
  ) : null;
  if (!ports.phone) return entry;

  // Keep the in-flight request owned until it settles, including after leaving the phone route.
  return (
    <>
      {entry}
      <PhoneScreen port={ports.phone} visible={showPhone} lifecycle={phoneLifecycle} invalidate={auth.invalidate}
        onBack={() => setRoute({ name: 'sign-in' })} onAuthenticated={onAuthenticated} />
    </>
  );
}

/* ---------------- sign-in (entry root) ---------------- */

function SignInScreen({ available, capabilitiesLoaded, notice, onEmail, onPhone, onIdentity, onRetryCapabilities }: {
  available: Record<Provider, boolean>; capabilitiesLoaded: boolean; notice: string | null;
  onEmail: () => void; onPhone: () => void; onIdentity: (p: 'apple' | 'google') => Promise<void>; onRetryCapabilities: () => void;
}) {
  const [active, setActive] = useState<'apple' | 'google' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = !available.apple && !available.google && !available.phone;

  const run = async (p: 'apple' | 'google') => {
    setActive(p); setError(null);
    try { await onIdentity(p); }
    catch (e) { if (!isUserCancel(e)) setError(errorCopy(e)); }
    finally { setActive(null); }
  };

  return (
    <Screen testID="screen-sign-in" nav={<Nav leading={<Wordmark />} />}>
      <Gutter>
        <Title text="Step onto the mat." display testID="a-signin-title" />
        <Subtitle text="Sign in to keep your plans, sets and coach notes with you." />
      </Gutter>
      <Gutter style={{ marginTop: t.space.s32 }}><Art /></Gutter>
      <Gutter style={{ marginTop: t.space.s32 }}>
        <Stack gap="s16">
          {notice ? <Notice kind="info" text={notice} captureId="a-signin-notice" announce /> : null}
          {error ? <Notice kind="error" text={error} captureId="a-signin-error" announce /> : null}
          {!capabilitiesLoaded ? (
            <Notice kind="error" text={COPY.network} captureId="a-signin-error"
              action={{ label: 'Try again', onPress: onRetryCapabilities }} />
          ) : null}
          {pending ? <Notice kind="info" text={COPY.providersPending} captureId="a-signin-pending" /> : null}
          {pending ? (
            <PrimaryAction label="Continue with email" captureId="a-signin-email" onPress={onEmail} />
          ) : (
            <Stack gap="s12">
              {available.apple ? (
                <OutlineAction label={active === 'apple' ? 'Waiting for Apple…' : 'Continue with Apple'} testID="a-signin-apple"
                  loading={active === 'apple'} disabled={!!active && active !== 'apple'} onPress={() => void run('apple')} />
              ) : null}
              {available.google ? (
                <OutlineAction label={active === 'google' ? 'Waiting for Google…' : 'Continue with Google'} testID="a-signin-google"
                  loading={active === 'google'} disabled={!!active && active !== 'google'} onPress={() => void run('google')} />
              ) : null}
              {available.phone ? (
                <OutlineAction label="Continue with phone number" testID="a-signin-phone" disabled={!!active} onPress={onPhone} />
              ) : null}
            </Stack>
          )}
        </Stack>
        {pending ? null : <View style={{ marginTop: t.space.s8 }}><PlainAction label="Use email instead" captureId="a-signin-email-link" onPress={onEmail} chevron={null} /></View>}
        <Txt role="meta" tone="secondary" style={{ marginTop: t.space.s16 }}>By continuing you agree to the Terms and Privacy Policy.</Txt>
      </Gutter>
    </Screen>
  );
}

/* ---------------- email ---------------- */

function EmailScreen({ auth, capabilities, mode, onMode, onBack, onAuthenticated }: {
  auth: AuthSession; capabilities: Capabilities | null; mode: 'sign-in' | 'create';
  onMode: (mode: 'sign-in' | 'create') => void; onBack: () => void; onAuthenticated: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; field: boolean } | null>(null);
  const create = mode === 'create';
  const registrationOpen = capabilities?.authentication.emailPassword.registration === 'allowlist';
  const minLength = 12; // server signup schema min(12)
  const valid = email.includes('@') && password.length >= (create ? minLength : 1) && (!create || name.trim().length > 0);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try {
      if (create) await auth.signUp(name.trim(), email.trim(), password);
      else await auth.signIn(email.trim(), password);
      onAuthenticated();
    } catch (e) {
      const invalid = e instanceof ApiError && e.status === 401;
      setError({ text: invalid ? COPY.invalidCredentials : errorCopy(e), field: invalid });
    } finally { setBusy(false); }
  };

  return (
    <Screen testID="screen-email" nav={<Nav back="Sign in" onBack={onBack} />}>
      <Gutter>
        <Title text={create ? 'Create your account' : 'Sign in with email'} testID="a-email-title" />
        <Subtitle text={create ? 'Form is invite-only for now. Use the email address you were invited with.' : 'Use the email and password for your Form account.'} />
      </Gutter>
      <Gutter style={{ marginTop: t.space.s32, gap: t.space.s20 }}>
        {error ? <Notice kind="error" text={error.text} captureId="a-email-error" announce /> : null}
        {create ? (
          <TextAnswer label="First name" value={name} onChangeText={setName} testID="a-name-field"
            autoComplete="given-name" textContentType="givenName" maxLength={100} />
        ) : null}
        <TextAnswer label="Email" value={email} onChangeText={setEmail} testID="a-email-field" keyboardType="email-address"
          autoComplete="email" textContentType="username" autoCapitalize="none" maxLength={254} />
        <TextAnswer label="Password" value={password} onChangeText={setPassword} testID="a-password-field" secure={!show}
          autoComplete={create ? 'new-password' : 'current-password'} textContentType={create ? 'newPassword' : 'password'}
          autoCapitalize="none" maxLength={128} error={!!error?.field} onSubmitEditing={() => void submit()}
          trailing={<PlainAction label={show ? 'Hide' : 'Show'} chevron={null} onPress={() => setShow(!show)}
            accessibilityLabel={show ? 'Hide password' : 'Show password'} />} />
        {create ? <Txt role="meta" tone="secondary" testID="a-password-hint">At least 12 characters. A passphrase works well.</Txt> : null}
      </Gutter>
      <Gutter style={{ marginTop: t.space.s32, gap: t.space.s8 }}>
        <PrimaryAction label={create ? 'Create account' : 'Sign in'} captureId="a-email-submit" onPress={() => void submit()}
          disabled={!valid} loading={busy} />
        {registrationOpen || create ? (
          <PlainAction label={create ? 'I already have an account' : 'Create an account'} captureId="a-email-mode" chevron={null}
            placement="centered" onPress={() => { setError(null); onMode(create ? 'sign-in' : 'create'); }} />
        ) : null}
      </Gutter>
    </Screen>
  );
}

/* ---------------- phone ---------------- */

/** DGR-005: ten U.S. digits become +1…; input starting with + is sent as typed (server requires E.164). */
function toE164(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith('+')) { const digits = trimmed.slice(1).replace(/\D/g, ''); return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null; }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function displayNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

type PhoneOperation = { phase: 'pending' } | { phase: 'retry'; intent: string };
type SavedChallenge = { value: PhoneChallenge; port: PhoneAuthPort; lifecycle: number };

function canRunPhoneOperation(operation: PhoneOperation | null, intent: string) {
  return !operation || (operation.phase === 'retry' && operation.intent === intent);
}

function PhoneScreen({ port, visible, lifecycle, invalidate, onBack, onAuthenticated }: {
  port: PhoneAuthPort; visible: boolean; lifecycle: RefObject<number>;
  invalidate: () => void; onBack: () => void; onAuthenticated: () => void;
}) {
  const [number, setNumber] = useState('');
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState<SavedChallenge | null>(null);
  const [codeStep, setCodeStep] = useState(false);
  const [reportedEnd, setReportedEnd] = useState<ReturnType<typeof phoneChallengeEnd>>(null);
  const [operation, setOperation] = useState<PhoneOperation | null>(null);
  const currentOperation = useRef<PhoneOperation | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const visiblePort = useRef<typeof port | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const { keyFor, settle } = useCommandKey();
  const ownerLifecycle = lifecycle.current;
  const challenge = saved?.value;
  const expiresAt = challenge ? Date.parse(challenge.expiresAt) : Infinity;
  const invalidated = saved && (saved.port !== port || saved.lifecycle !== ownerLifecycle);
  const ended = reportedEnd ?? (now >= expiresAt ? 'expired' : invalidated ? 'unavailable' : null);
  const showChallengeEnd = codeStep || reportedEnd !== null;
  const busy = operation?.phase === 'pending';
  const updateOperation = useCallback((next: PhoneOperation | null) => {
    currentOperation.current = next;
    setOperation(next);
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useLayoutEffect(() => {
    setCode('');
    setError(null);
    if (currentOperation.current?.phase === 'retry') {
      settle();
      updateOperation(null);
    }
    if (!visible) {
      setNumber('');
      setSaved(null);
      setCodeStep(false);
      setReportedEnd(null);
      return;
    }

    visiblePort.current = port;
    return () => {
      visiblePort.current = null;
      generation.current++;
      invalidate();
    };
  }, [visible, port, ownerLifecycle, invalidate, settle, updateOperation]);

  useEffect(() => {
    if (!visible || !challenge || ended) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible, challenge, ended]);

  const isVisible = () => visible && visiblePort.current === port && ownerLifecycle === lifecycle.current;
  const discard = useCallback((end: ReturnType<typeof phoneChallengeEnd> = null) => {
    generation.current++;
    invalidate();
    settle();
    if (currentOperation.current?.phase === 'retry') updateOperation(null);
    setSaved(null);
    setCode('');
    setReportedEnd(end);
  }, [invalidate, settle, updateOperation]);

  useLayoutEffect(() => {
    if (visible && ended) discard(showChallengeEnd ? ended : null);
  }, [visible, ended, showChallengeEnd, discard]);

  const backToNumber = () => {
    if (!isVisible()) return;
    if (currentOperation.current || ended || Date.now() >= expiresAt) discard();
    setCodeStep(false);
    setCode('');
    setError(null);
  };

  const attempt = async (intent: string, run: (key: string) => Promise<PhoneChallenge | void>) => {
    if (!isVisible() || !canRunPhoneOperation(currentOperation.current, intent)) return;
    if (codeStep && (ended || Date.now() >= expiresAt)) {
      setNow(Date.now());
      return;
    }
    let key: string;
    try { key = keyFor(intent); }
    catch (e) { setError(errorCopy(e)); return; }
    const owner = generation.current;
    const isCurrent = () => owner === generation.current && isVisible();
    updateOperation({ phase: 'pending' });
    setError(null);
    let next: PhoneChallenge | void;
    try { next = await run(key); }
    catch (e) {
      if (!mounted.current) return;
      if (isCurrent()) {
        const end = e instanceof ApiError ? phoneChallengeEnd(e) : null;
        if (end) {
          setReportedEnd(end);
          setCode('');
        } else if (e instanceof ApiError && e.effectUnknown) {
          updateOperation({ phase: 'retry', intent });
          return;
        } else setError(errorCopy(e));
      }
      settle();
      updateOperation(null);
      return;
    }

    if (!mounted.current) return;
    settle();
    updateOperation(null);
    if (!isCurrent()) return;
    if (next) {
      setSaved({ value: next, port, lifecycle: ownerLifecycle });
      setCodeStep(true);
      setNow(Date.now());
    } else onAuthenticated();
  };

  if (!visible) return null;

  const notice = busy ? 'A phone request is in progress.'
    : operation?.phase === 'retry' && !ended ? 'Form couldn’t confirm the result. Retry the same action without changing it.'
      : error;
  const status = notice ? <Notice kind={busy ? 'info' : 'error'} text={notice} captureId="a-phone-error" announce /> : null;
  if ((!codeStep || !challenge) && !reportedEnd) {
    const e164 = toE164(number);
    const intent = `challenge:${e164}`;
    const resume = !!challenge && challenge.phoneNumber === e164 && !ended && !operation;
    const start = () => {
      if (!e164 || !isVisible() || !canRunPhoneOperation(currentOperation.current, intent)) return;
      if (resume) {
        setError(null);
        setNow(Date.now());
        setCodeStep(true);
        return;
      }
      if (!currentOperation.current) discard();
      void attempt(intent, key => port.challenge(e164, key));
    };
    return (
      <Screen testID="screen-phone-number" nav={<Nav back="Sign in" onBack={() => {
        if (!isVisible()) return;
        discard();
        setNumber('');
        onBack();
      }} />}>
        <Gutter>
          <Title text="What’s your number?" testID="a-phone-title" />
          <Subtitle text={resume ? 'Go back to the code we texted you.' : 'We’ll text you a 6-digit code. Message rates may apply.'} />
        </Gutter>
        <Gutter style={{ marginTop: t.space.s32, gap: t.space.s12 }}>
          {status}
          <TextAnswer label="Mobile number" value={number} onChangeText={setNumber} testID="a-phone-field" keyboardType="phone-pad"
            autoComplete="tel" textContentType="telephoneNumber" maxLength={20} />
          <Txt role="meta" tone="secondary">United States (+1)</Txt>
        </Gutter>
        <Gutter style={{ marginTop: t.space.s32, gap: t.space.s8 }}>
          <PrimaryAction label={resume ? 'Enter code' : 'Text me a code'} captureId="a-phone-submit"
            disabled={!e164 || !canRunPhoneOperation(operation, intent)} loading={busy} onPress={start} />
        </Gutter>
      </Screen>
    );
  }

  const nav = <Nav back="Phone" onBack={backToNumber} />;
  if (ended) {
    return (
      <Screen testID="screen-phone-code" nav={nav}>
        <Gutter>
          <Title text={ended === 'expired' ? 'That code has expired' : 'That code is no longer available'} testID="a-phone-title" />
          <Subtitle text="Go back to your number to request a new code." />
        </Gutter>
        <Gutter style={{ marginTop: t.space.s32, gap: t.space.s8 }}>
          {status}
          <PrimaryAction label="Start over" captureId="a-phone-restart" disabled={busy}
            onPress={() => { if (currentOperation.current?.phase !== 'pending') backToNumber(); }} />
        </Gutter>
      </Screen>
    );
  }
  if (!challenge) return null;

  const resendIn = Math.max(0, Math.ceil((Date.parse(challenge.resendAfter) - now) / 1000));
  const clock = `${Math.floor(resendIn / 60)}:${String(resendIn % 60).padStart(2, '0')}`;
  const codeValid = /^\d{4,10}$/.test(code);
  const verifyIntent = `verify:${challenge.challengeId}:${code}`;
  const resendIntent = `resend:${challenge.challengeId}:${challenge.resendAfter}`;
  return (
    <Screen testID="screen-phone-code" nav={nav}>
      <Gutter>
        <Title text="Enter the code we texted" testID="a-phone-title" />
        <Subtitle text={`We sent a 6-digit code to ${displayNumber(challenge.phoneNumber)}.`} />
      </Gutter>
      <Gutter style={{ marginTop: t.space.s32, gap: t.space.s12 }}>
        {status}
        <TextAnswer label="6-digit code" value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 10))}
          testID="a-otp-field" keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" />
        <Txt role="meta" tone="secondary">Codes from Messages fill in on their own. You can paste one too.</Txt>
      </Gutter>
      <Gutter style={{ marginTop: t.space.s32, gap: t.space.s8 }}>
        <PrimaryAction label="Verify" captureId="a-phone-submit" loading={busy}
          disabled={!codeValid || !canRunPhoneOperation(operation, verifyIntent)}
          onPress={() => { if (codeValid) void attempt(verifyIntent, async (key) => { await port.verify(challenge, code, key); }); }} />
        <PlainAction label="Send a new code" captureId="a-resend" chevron={null} placement="centered"
          disabled={resendIn > 0 || !canRunPhoneOperation(operation, resendIntent)}
          onPress={() => {
            if (Date.now() >= Date.parse(challenge.resendAfter)) void attempt(resendIntent, key => port.resend(challenge, key));
          }} />
        {resendIn > 0 ? (
          <Txt role="meta" tone="secondary" testID="a-resend-countdown" style={{ textAlign: 'center' }}>{`Send a new code in ${clock}`}</Txt>
        ) : null}
      </Gutter>
    </Screen>
  );
}
