import { createCredentialsPort } from '../api/credentials';
import type { AuthAttemptGuard, FormTransport } from '../api/transport';
import { createForgotPasswordController } from '../features/credentials/model';

/** Created only by an explicit action in an active auth epoch. Disposal never cancels a server mutation. */
export function createPasswordRecoverySession(api: FormTransport, owner: AuthAttemptGuard,
  onEnd: (notice: string | null) => void) {
  const port = createCredentialsPort(api, owner);
  const model = createForgotPasswordController(port);
  let operation: 'request' | 'reset' = 'request';
  const controller: ReturnType<typeof createForgotPasswordController> = {
    ...model,
    dispose() { dispose(); },
    requestCode(email) {
      if (model.snapshot().status !== 'pending') operation = 'request';
      return model.requestCode(email);
    },
    submit(otp, password) {
      const before = model.snapshot();
      if (before.step === 'code' && !['pending', 'unknown', 'disposed'].includes(before.status)) operation = 'reset';
      return model.submit(otp, password);
    },
  };
  let live = true;
  let notice: string | null = null;
  const observe = controller.subscribe(() => {
    const state = controller.snapshot();
    if (state.status === 'pending' || state.status === 'unknown') {
      notice = operation === 'reset'
        ? "We couldn't confirm the reset. Try signing in with your new password; if that fails, request a new code."
        : "We couldn't confirm the code was sent. You can explicitly request a new code.";
    } else if (state.status !== 'disposed') notice = state.step === 'done' && state.status === 'saved'
      ? 'Password reset was confirmed. Sign in with your new password.' : null;
  });
  const subscription = api.subscribeAuthChanges(() => dispose());
  function dispose() {
    if (!live) return;
    live = false;
    observe(); subscription.remove(); port.dispose(); model.dispose();
    onEnd(notice);
  }
  return { controller, dispose, isCurrent: () => live && owner.isCurrent() && port.isCurrent() };
}
export type PasswordRecoverySession = ReturnType<typeof createPasswordRecoverySession>;
