import type { CredentialsPort } from '../../api/credentials';
import { createForgotPasswordController, type CredentialStatus } from './model';

export type RecoverySnapshot = Readonly<{
  status: CredentialStatus; step: 'email' | 'code' | 'done'; email: string; message: string | null;
  resendInSeconds: number; canRequestCode: boolean; canSubmit: boolean; unavailable: boolean;
}>;

export function createRecoveryConsumer(port: CredentialsPort, now: () => number = Date.now) {
  const controller = createForgotPasswordController(port, now), listeners = new Set<() => void>();
  let disposed = false, invoking = false, resetAttempted = false;
  let value: RecoverySnapshot = Object.freeze({ status: 'idle', step: 'email', email: '', message: null,
    resendInSeconds: 0, canRequestCode: true, canSubmit: false, unavailable: false });
  function terminate() {
    if (disposed) return;
    disposed = true; unsubscribe(); listeners.clear(); controller.dispose();
    value = Object.freeze({ status: 'disposed', step: 'email', email: '', message: null,
      resendInSeconds: 0, canRequestCode: false, canSubmit: false, unavailable: false });
  }
  function current() {
    if (disposed) return false;
    if (!port.isCurrent()) terminate();
    return !disposed;
  }
  function read(): RecoverySnapshot {
    if (!current()) return value;
    const state = controller.snapshot();
    if (state.status === 'disposed') { terminate(); return value; }
    const resendInSeconds = Math.max(0, Math.ceil((state.resendAt - now()) / 1000));
    const terminal = resetAttempted && (state.status === 'saved' || state.status === 'unknown');
    value = Object.freeze({ status: state.status, step: state.step, email: state.email, message: state.notice,
      resendInSeconds, canRequestCode: !terminal && state.status !== 'pending' && state.step !== 'done' && resendInSeconds === 0,
      canSubmit: !terminal && state.step === 'code' && state.status !== 'pending' && state.status !== 'unknown',
      unavailable: state.issue?.code === 'password_recovery_unavailable' });
    return value;
  }
  function publish() {
    if (!current() || invoking) return;
    read();
    for (const listener of [...listeners]) {
      if (!current()) break;
      if (listeners.has(listener)) listener();
    }
  }
  const unsubscribe = controller.subscribe(publish);
  async function run(action: () => Promise<void>) {
    if (!current()) return;
    let work: Promise<void>;
    invoking = true;
    try { work = action(); } finally { invoking = false; }
    publish();
    await work;
    if (current()) read();
  }
  return {
    snapshot: read,
    subscribe(listener: () => void) {
      if (current()) listeners.add(listener);
      return () => { if (current()) listeners.delete(listener); };
    },
    async requestCode(email: string): Promise<void> {
      if (!current() || !read().canRequestCode) return;
      resetAttempted = false;
      await run(() => controller.requestCode(email));
    },
    async submit(otp: string, password: string): Promise<void> {
      if (!current() || !read().canSubmit) return;
      resetAttempted = true;
      await run(() => controller.submit(otp, password));
    },
    startOver() {
      if (!current()) return;
      const state = read();
      if (state.status === 'pending' || (resetAttempted && (state.status === 'saved' || state.status === 'unknown'))) return;
      resetAttempted = false; controller.startOver();
    },
    signInTarget(): Readonly<{ emailPrefill: string }> | null {
      if (!current()) return null;
      const state = read();
      const transition = controller.transition();
      if (!current()) return null;
      return transition?.reason === 'password-reset' ? Object.freeze({ emailPrefill: transition.emailPrefill })
        : resetAttempted && state.status === 'unknown' ? Object.freeze({ emailPrefill: state.email }) : null;
    },
    dispose() { if (current()) terminate(); },
  };
}
