const SCENARIOS = ['normal', 'lost-export-response', 'lost-deletion-response'];
const WARNING = 'Sample receipt in memory only, limited to this tab and Data view. Leaving this view, switching accounts, signing out, or reloading clears recovery. No production persistence or recovery guarantee.';
const copy = value => structuredClone(value);
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const accountContext = value => value?.kind === 'sample' && value.synthetic === true &&
  typeof value.accountId === 'string' && value.accountId.length > 0 &&
  Number.isSafeInteger(value.generation) && value.generation >= 0
  ? { synthetic: true, kind: 'sample', accountId: value.accountId, generation: value.generation } : null;
const sameAccount = (a, b) => a === null ? b === null : b !== null && a.accountId === b.accountId && a.generation === b.generation;

export function createMemberPrivacyController({ readAccount, onSampleDeleted, now = Date.now,
  settle = () => Promise.resolve() }) {
  let account = accountContext(readAccount()), epoch = 0, disposed = false, sequence = 0;
  let state, simulatedDeletion = null, callbackStarted = false;
  const listeners = new Set();
  function fresh(message = '') {
    simulatedDeletion = null; callbackStarted = false;
    state = { phase: account ? 'ready' : 'unavailable', scenario: 'normal', busy: false, grant: null,
      exportConsumed: false, exportPreview: null, receipt: null, confirmation: '', held: false, cleanupUnknown: false,
      message: message || (account ? 'Explore export and deletion with fictional data only.' : 'Choose a sample account to explore data controls.') };
  }
  fresh();
  function emit() { for (const listener of [...listeners]) listener(); }
  function accountChanged() {
    if (disposed) return;
    epoch++;
    account = accountContext(readAccount());
    fresh('Sample workflow cleared. Any tab-only recovery receipt was discarded. No real account was changed.');
    emit();
  }
  function sync() {
    if (disposed) return false;
    if (!sameAccount(account, accountContext(readAccount()))) accountChanged();
    return !!account;
  }
  function current(ticket) { sync(); return !disposed && ticket === epoch && !!account; }
  function snapshot() {
    sync();
    const canAct = !disposed && !!account && !state.busy && !state.held;
    const validGrant = purpose => state.grant?.purpose === purpose && state.grant.expiresAt > now();
    return copy({ ...state, account, warning: WARNING, complete: false, synthetic: true,
      canChooseScenario: canAct && !state.receipt,
      canReauthExport: canAct && !state.receipt,
      canExport: canAct && !state.receipt && validGrant('account_export'),
      canRequestDeletion: canAct && !state.receipt,
      canReauthDelete: canAct && state.receipt?.phase === 'awaiting_reauthentication',
      canConfirmDeletion: canAct && state.receipt?.phase === 'awaiting_reauthentication' &&
        state.confirmation === 'DELETE SAMPLE' && validGrant('account_delete'),
      canCheckStatus: !disposed && !!account && !state.busy && !!state.receipt,
      canDownload: canAct && !!state.exportPreview && !state.receipt });
  }
  function publish(patch) { Object.assign(state, patch); emit(); }
  async function waitFor(operation, ticket) {
    // This port controls timing/failure in tests only; it cannot supply receipt or export contents.
    await settle(operation, copy({ account, receipt: state.receipt, scenario: state.scenario }));
    return current(ticket);
  }
  async function notifyDeletion(ticket) {
    if (!current(ticket) || callbackStarted || !state.receipt?.disabled || !onSampleDeleted) return;
    callbackStarted = true;
    const target = Object.freeze({ ...account });
    try {
      // The parent must clear only this fixture, synchronously or after rechecking isCurrent().
      await onSampleDeleted(target, { isCurrent: () => current(ticket) });
    } catch {
      if (current(ticket)) publish({ phase: 'unknown', held: true, cleanupUnknown: true,
        message: 'Simulated deletion was recorded, but fixture cleanup could not be confirmed. It will not be repeated. No real erasure is claimed.' });
    }
  }
  async function perform(action, value) {
    if (!sync() || disposed) return snapshot();
    const before = snapshot();
    if (action === 'download-result') {
      if (before.canDownload) publish({ message: value === 'requested'
        ? 'Fictional download requested. A saved file is not confirmed; the preview remains available.'
        : 'The fictional download could not be requested. Nothing saved is confirmed; use the preview.' });
      return snapshot();
    }
    if (action === 'confirmation') {
      if (before.canReauthDelete) publish({ confirmation: String(value).slice(0, 32) });
      return snapshot();
    }
    if (action === 'scenario') {
      if (before.canChooseScenario && SCENARIOS.includes(value)) publish({ scenario: value, grant: null,
        exportPreview: null, message: 'Sample scenario selected. All actions remain fictional.' });
      return snapshot();
    }
    const reauthPurpose = action === 'reauth-export' ? 'account_export' : action === 'reauth-delete' ? 'account_delete' : null;
    if (reauthPurpose) {
      if (reauthPurpose === 'account_export' ? before.canReauthExport : before.canReauthDelete) {
        publish({ grant: { purpose: reauthPurpose, expiresAt: now() + 300_000, synthetic: true },
          message: 'Reauthentication simulated. No password was requested or checked. This sample permission expires in five minutes.' });
      }
      return snapshot();
    }
    if (!before.busy && !before.held && ['export', 'confirm-delete'].includes(action) &&
      state.grant && state.grant.expiresAt <= now()) {
      publish({ grant: null, message: 'The sample permission expired. Simulate reauthentication again before continuing.' });
      return snapshot();
    }
    if (!(action === 'export' && before.canExport || action === 'request-delete' && before.canRequestDeletion ||
      action === 'confirm-delete' && before.canConfirmDeletion || action === 'reconcile' && before.canCheckStatus)) return snapshot();
    const ticket = epoch, scenario = state.scenario;
    state.busy = true;
    try {
      if (action === 'export') {
        // Consume before producing the snapshot. An unknown result must never reuse this permission.
        publish({ grant: null, exportConsumed: true, exportPreview: null, phase: 'pending', message: 'Preparing fictional export…' });
        if (!await waitFor('export', ticket)) return snapshot();
        if (scenario === 'lost-export-response') {
          publish({ phase: 'unknown', held: true,
            message: 'Simulated export response lost. The sample permission was consumed; no file is confirmed. Do not retry. Export has no receipt-based recovery. Reset the sample account to start a separate fictional run.' });
        } else {
          publish({ phase: 'ready', exportPreview: {
            schema: 'form.sample-account-export.v1', synthetic: true, complete: false,
            scope: { accountId: account.accountId, generation: account.generation },
            records: [{ category: 'sampleTraining', value: { exercise: 'Fictional squat', sets: 3 } }],
            omissions: ['Other account categories', 'External providers', 'Backups', 'Native device copies'],
            notice: 'Fictional illustration only. This is not an export of your account or all sample-session data.',
          }, message: 'Fictional partial export ready to preview. Nothing has been saved. Review the omissions before requesting a sample download.' });
        }
      } else if (action === 'request-delete') {
        // The original sample recovery identity exists before the simulated command, never in persistent storage.
        const requestId = `fictional-deletion-${++sequence}`;
        simulatedDeletion = { requestId, phase: 'awaiting_reauthentication', disabled: false, complete: false };
        publish({ receipt: { ...simulatedDeletion, synthetic: true, commandKey: `fictional-command-${sequence}` },
          grant: null, exportPreview: null, phase: 'pending', message: 'Sample recovery receipt retained in this view before simulated initiation…' });
        if (!await waitFor('initiate', ticket)) return snapshot();
        publish({ phase: 'ready', message: 'Sample deletion requested. Type DELETE SAMPLE and simulate reauthentication to confirm. No real account or subscription will change.' });
      } else if (action === 'confirm-delete') {
        publish({ grant: null, confirmation: '', phase: 'pending', message: 'Confirming fictional deletion…' });
        simulatedDeletion = { ...simulatedDeletion, phase: 'disabled_pending_purge', disabled: true };
        if (!await waitFor('confirm', ticket)) return snapshot();
        if (scenario === 'lost-deletion-response') {
          publish({ phase: 'unknown', held: true,
            message: 'Simulated deletion response lost. Do not submit another request or confirmation. Reconcile with the original sample receipt below.' });
        } else {
          publish({ receipt: { ...state.receipt, ...simulatedDeletion }, phase: 'disabled',
            message: 'Simulated access disabled. Whole-account erasure remains incomplete; billing cancellation was not performed. Only the parent sample fixture may be cleared.' });
          await notifyDeletion(ticket);
        }
      } else {
        publish({ phase: 'pending', message: 'Reconciling the original sample receipt…' });
        if (!await waitFor('status', ticket)) return snapshot();
        publish({ receipt: { ...state.receipt, ...simulatedDeletion }, held: state.cleanupUnknown,
          phase: state.cleanupUnknown ? 'unknown' : simulatedDeletion.disabled ? 'disabled' : 'ready',
          message: state.cleanupUnknown
            ? 'Original sample receipt reconciled, but fixture cleanup is still unknown and will not be repeated. Erasure remains incomplete.'
            : simulatedDeletion.disabled
            ? 'Original sample receipt reconciled: simulated access disabled. Erasure remains incomplete; backups, providers and billing are not resolved.'
            : 'Original sample receipt reconciled: awaiting simulated reauthentication. No new request was sent.' });
        await notifyDeletion(ticket);
      }
    } catch {
      if (current(ticket)) publish({ phase: 'unknown', held: true, grant: null,
        message: state.receipt ? 'Sample result unknown. Reconcile the original receipt; do not repeat the command.'
          : 'Sample export result unknown. Permission consumed; no file confirmed. Do not retry this action.' });
    } finally {
      if (current(ticket)) { state.busy = false; emit(); }
    }
    return snapshot();
  }
  return Object.freeze({ snapshot, perform, accountChanged,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {
      if (disposed) return;
      disposed = true; epoch++; account = null; fresh(); state.phase = 'disposed'; listeners.clear();
    } });
}

export function renderMemberPrivacy(state) {
  const button = (action, label, enabled) => `<button type="button" data-privacy-action="${action}"${enabled ? '' : ' disabled'}>${label}</button>`;
  return `<section class="member-privacy" aria-label="Sample data and privacy">
    <p class="eyebrow">Sample account · Data</p><h2>Your data, with clear limits</h2>
    <p>This is a fictional simulation. Real account export and deletion are unavailable here. No real passwords, secret receipts or account data are requested.</p>
    <p class="member-notice">${escape(state.warning)}</p>
    <label>Simulation scenario <select data-privacy-scenario${state.canChooseScenario ? '' : ' disabled'}>
      ${SCENARIOS.map((scenario, index) => `<option value="${scenario}"${state.scenario === scenario ? ' selected' : ''}>${['Normal', 'Lost export response', 'Lost deletion response'][index]}</option>`).join('')}
    </select></label>
    <p role="status" aria-live="polite">${escape(state.message)}</p>
    <div class="member-card"><h3>Preview a fictional export</h3><p>Partial illustration only. Other categories, providers, backups and native copies are omitted.</p>
      ${button('reauth-export', 'Simulate export reauthentication', state.canReauthExport)}
      ${button('export', 'Prepare sample export', state.canExport)}
      ${state.exportPreview ? `<pre aria-label="Fictional export preview">${escape(JSON.stringify(state.exportPreview, null, 2))}</pre>
      ${button('download', 'Download fictional JSON', state.canDownload)}<p>A download request does not confirm a saved file.</p>` : ''}
    </div>
    <div class="member-card"><h3>Try the sample deletion flow</h3><p>This can clear only the sample fixture. It cannot erase a real account, cancel billing, or confirm whole-account deletion.</p>
      ${button('request-delete', 'Request sample deletion', state.canRequestDeletion)}
      ${state.receipt ? `<p>Original sample receipt: <code>${escape(state.receipt.requestId)}</code></p>
      <p>Sample phase: ${escape(state.receipt.phase)}. Whole-account deletion complete: false.</p>` : ''}
      ${state.receipt?.phase === 'awaiting_reauthentication' ? `<label>Type DELETE SAMPLE to confirm <input data-privacy-confirmation type="text" autocomplete="off" spellcheck="false" maxlength="32" value="${escape(state.confirmation)}"${state.canReauthDelete ? '' : ' disabled'}></label>
      ${button('reauth-delete', 'Simulate deletion reauthentication', state.canReauthDelete)}
      ${button('confirm-delete', 'Confirm sample deletion', state.canConfirmDeletion)}` : ''}
      ${button('reconcile', 'Reconcile original sample receipt', state.canCheckStatus)}
    </div>
  </section>`;
}

export function mountMemberPrivacy({ root, readAccount, onSampleDeleted, now, settle, downloadSample }) {
  const controller = createMemberPrivacyController({ readAccount, onSampleDeleted, now, settle });
  let disposed = false, editingConfirmation = false;
  const render = () => { if (!disposed && !editingConfirmation) root.innerHTML = renderMemberPrivacy(controller.snapshot()); };
  const unsubscribe = controller.subscribe(render);
  const download = downloadSample ?? (text => {
    const link = root.ownerDocument.createElement('a');
    link.href = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
    link.download = 'form-fictional-export.json';
    root.appendChild(link);
    try { link.click(); } finally { link.remove(); }
  });
  async function click(event) {
    const target = event.target?.closest?.('[data-privacy-action]');
    if (disposed || !target || !root.contains(target) || target.disabled) return;
    const action = target.dataset.privacyAction;
    if (action === 'download') {
      const state = controller.snapshot();
      if (state.canDownload) {
        try {
          download(JSON.stringify(state.exportPreview, null, 2));
          await controller.perform('download-result', 'requested');
        } catch { await controller.perform('download-result', 'failed'); }
      }
    } else await controller.perform(action);
  }
  function change(event) {
    if (disposed || !root.contains(event.target)) return;
    if (event.target.matches?.('[data-privacy-scenario]')) controller.perform('scenario', event.target.value);
  }
  function input(event) {
    if (disposed || !root.contains(event.target) || !event.target.matches?.('[data-privacy-confirmation]')) return;
    // Preserve the focused input and caret while keeping confirmation eligibility current.
    editingConfirmation = true;
    try { controller.perform('confirmation', event.target.value); }
    finally { editingConfirmation = false; }
    const button = root.querySelector('[data-privacy-action="confirm-delete"]');
    if (button) button.disabled = !controller.snapshot().canConfirmDeletion;
  }
  root.addEventListener('click', click);
  root.addEventListener('change', change);
  root.addEventListener('input', input);
  render();
  return Object.freeze({ snapshot: controller.snapshot, accountChanged: controller.accountChanged,
    dispose() {
      if (disposed) return;
      disposed = true; unsubscribe(); controller.dispose();
      root.removeEventListener('click', click); root.removeEventListener('change', change);
      root.removeEventListener('input', input); root.innerHTML = '';
    } });
}
