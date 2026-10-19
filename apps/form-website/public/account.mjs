const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max;
const id = value => text(value, 80) && /^[a-zA-Z0-9_-]+$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const accountUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const timestamp = value => {
  if (!text(value, 40) || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
};
const coherentIdentity = value => object(value) && accountUuid(value.accountId) && value.appAccountToken === value.accountId;


export function validateRuntimeConfig(value, browserOrigin) {
  try {
    if (!object(value) || typeof value.trackingEnabled !== 'boolean') return null;
    const api = new URL(value.apiBase), browser = new URL(browserOrigin), verified = new URL(value.verifiedBrowserOrigin);
    for (const url of [api, browser, verified]) {
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    }
    if (verified.origin !== browser.origin || value.apiBase !== api.origin || value.verifiedBrowserOrigin !== verified.origin) return null;
    return Object.freeze({ apiBase: api.origin, verifiedBrowserOrigin: verified.origin });
  } catch { return null; }
}

export function parseCapabilities(value) {
  const email = value?.authentication?.emailPassword;
  if (!exactKeys(email, ['status', 'registration', 'passwordRecovery', 'emailChange']) || !exactKeys(value?.authentication?.session, ['transport', 'expiresInSeconds']) || !['configured_unverified', 'unconfigured'].includes(email.status) ||
      !['closed', 'allowlist'].includes(email.registration) || ![email.passwordRecovery, email.emailChange].every(status => ['unconfigured', 'configured_unverified', 'verified'].includes(status)) ||
      value?.authentication?.session?.transport !== 'signed_bearer_or_cookie' || value.authentication.session.expiresInSeconds !== 604800) throw new Error('invalid_capabilities');
  // Mail metadata does not enable website credential or recovery actions.
  return Object.freeze({ status: email.status, registration: email.registration, passwordRecovery: email.passwordRecovery, emailChange: email.emailChange, recovery: 'unavailable' });
}

export function parseMe(value) {
  if (!coherentIdentity(value) || !revision(value.profile?.revision) || !object(value.profile) ||
      !text(value.profile.name, 100) || !revision(value.preferences?.revision) || !object(value.preferences) ||
      !revision(value.onboarding?.revision) || !['draft', 'completed'].includes(value.onboarding?.status)) throw new Error('invalid_account');
  return Object.freeze({ accountId: value.accountId, appAccountToken: value.appAccountToken, name: value.profile.name, onboardingComplete: value.onboarding.status === 'completed' });
}

export function parsePurchaseCapabilities(value) {
  if (!exactKeys(value, ['status', 'environment', 'chargesEnabled', 'verification', 'onlineCertificateRevocation']) ||
      !['unconfigured', 'configured_unverified'].includes(value.status) || value.environment !== 'Sandbox' ||
      value.chargesEnabled !== false || value.verification !== 'apple_jws_offline' || value.onlineCertificateRevocation !== false) throw new Error('invalid_purchase_capabilities');
  return Object.freeze({ ...value });
}

export function parseEntitlements(value, account) {
  if (!coherentIdentity(value) || !coherentIdentity(account) || value.accountId !== account.accountId || value.appAccountToken !== account.appAccountToken ||
      !exactKeys(value, ['accountId', 'appAccountToken', 'grants', 'active', 'purchases']) || !Array.isArray(value.active) || value.active.length > 20 ||
      value.active.some(x => x !== 'form_plus') || new Set(value.active).size !== value.active.length ||
      !Array.isArray(value.grants) || value.grants.length > 1000) throw new Error('invalid_entitlements');
  const purchaseCapabilities = parsePurchaseCapabilities(value.purchases), grantIds = new Set(), appleSourceIds = new Set();
  for (const grant of value.grants) {
    if (!object(grant) || !id(grant.id) || grantIds.has(grant.id) || grant.entitlement !== 'form_plus' ||
        typeof grant.active !== 'boolean' || !timestamp(grant.grantedAt)) throw new Error('invalid_entitlements');
    grantIds.add(grant.id);
    if (grant.source === 'promo') {
      if (!exactKeys(grant, ['id', 'entitlement', 'source', 'grantedAt', 'expiresAt', 'environment', 'active']) ||
          grant.environment !== 'zero_charge' || !timestamp(grant.expiresAt)) throw new Error('invalid_entitlements');
    } else if (grant.source === 'apple') {
      if (!exactKeys(grant, ['id', 'entitlement', 'source', 'sourceId', 'grantedAt', 'expiresAt', 'environment', 'active']) ||
          purchaseCapabilities.status !== 'configured_unverified' || grant.environment !== 'Sandbox' ||
          typeof grant.sourceId !== 'string' || !/^[0-9]{1,64}$/.test(grant.sourceId) || appleSourceIds.has(grant.sourceId) ||
          (grant.expiresAt !== null && !timestamp(grant.expiresAt))) throw new Error('invalid_entitlements');
      appleSourceIds.add(grant.sourceId);
    } else throw new Error('invalid_entitlements');
  }
  const activeGrants = [...new Set(value.grants.filter(x => x.active).map(x => x.entitlement))];
  if (activeGrants.length !== value.active.length || activeGrants.some(x => !value.active.includes(x))) throw new Error('invalid_entitlements');
  return Object.freeze({ accountId: value.accountId, appAccountToken: value.appAccountToken,
    active: Object.freeze([...value.active]), purchases: 'unavailable', purchaseCapabilities });
}

// Configured source consumers must share their composition owner's operation dispatcher.
export function configuredSessionOptions(options) {
  const runtime = validateRuntimeConfig(options?.config, options?.browserOrigin);
  if (!runtime || typeof options?.fetchImpl !== 'function' || typeof options?.sessionDispatch?.run !== 'function') {
    throw new TypeError('configured_session_options_required');
  }
  return Object.freeze({ config: Object.freeze({ ...runtime, trackingEnabled: options.config.trackingEnabled }),
    browserOrigin: runtime.verifiedBrowserOrigin, fetchImpl: options.fetchImpl,
    sessionDispatch: Object.freeze({ run: options.sessionDispatch.run.bind(options.sessionDispatch) }) });
}

// Tests inject synthetic transports; configured source alone proves no deployed provider behavior.
function accountAdapter({ config, browserOrigin, fetchImpl = globalThis.fetch, onChange = () => {} } = {}, synthetic = false, sessionDispatch = null) {
  const runtime = validateRuntimeConfig(config, browserOrigin);
  const existingSession = sessionDispatch !== null;
  let epoch = 0, queue = Promise.resolve(), capabilities = null;
  let state = Object.freeze({ status: 'unavailable', account: null, entitlements: null, message: 'Account service is unavailable in this preview.', ...(existingSession ? { error: null } : {}) });
  const emit = (status, message, account = null, entitlements = null, error = null) => {
    state = Object.freeze({ status, message, account, entitlements, ...(existingSession ? { error } : {}) }); onChange(state); return state;
  };
  const current = ticket => ticket === epoch;
  async function request(path, method = 'GET', body) {
    if (!runtime || typeof fetchImpl !== 'function') throw new Error('unavailable');
    const response = await fetchImpl(`${runtime.apiBase}${path}`, { method, credentials: 'include', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) { const error = new Error(response.status === 401 ? 'unauthenticated' : 'request_failed'); error.status = response.status; throw error; }
    return response.json();
  }
  const failure = (error, ticket) => current(ticket) ? emit(error.status === 401 ? 'anonymous' : 'unavailable',
    error.status === 401 ? 'Sign in to continue. Your session may have expired.' : 'Account readback failed. Access has not been confirmed.', null, null,
    existingSession ? Object.freeze({ code: error.code ?? error.message, status: error.status ?? null, effect: 'none' }) : null) : state;
  async function readback(ticket) {
    const first = parseMe(await request('/v1/me'));
    if (!current(ticket)) return state;
    const entitlements = parseEntitlements(await request('/v1/entitlements'), first);
    if (!current(ticket)) return state;
    const second = parseMe(await request('/v1/me'));
    if (!current(ticket)) return state;
    if (first.accountId !== second.accountId || first.appAccountToken !== second.appAccountToken || entitlements.accountId !== second.accountId || entitlements.appAccountToken !== second.appAccountToken) throw new Error('account_changed');
    return emit('authenticated', 'Account confirmed by the server. App continuation is not configured.', second, entitlements);
  }
  function serialized(operation) {
    if (sessionDispatch) return sessionDispatch.run(operation);
    const result = queue.then(operation); queue = result.catch(() => {}); return result;
  }
  async function capabilitiesRead(ticket) {
    const result = parseCapabilities(await request('/v1/capabilities'));
    if (!current(ticket)) return false;
    capabilities = result;
    // Compatible metadata permits readback only; it is not deployment qualification.
    return (synthetic || existingSession) && result.status === 'configured_unverified';
  }
  function refresh() {
    const ticket = ++epoch; emit('checking', 'Checking account readiness…');
    if (!runtime) return Promise.resolve(emit('unavailable', 'Account service is unavailable. Real credentials are disabled on this preview.'));
    return serialized(async () => {
      if (!current(ticket)) return state;
      try {
        if (!await capabilitiesRead(ticket)) return current(ticket) ? emit('unavailable', 'The account runtime has not been verified. Credential submission is disabled.') : state;
        if (!current(ticket)) return state;
        return await readback(ticket);
      } catch (error) { return failure(error, ticket); }
    });
  }
  function authenticate(kind, input) {
    const ticket = ++epoch;
    emit('checking', 'Previous account details cleared. Checking readiness…');
    return serialized(async () => {
      if (!current(ticket)) return state;
      try {
        if (!runtime || !await capabilitiesRead(ticket)) throw new Error('unavailable');
        if (!current(ticket)) return state;
        if (kind === 'signup' && capabilities.registration !== 'allowlist') return emit('registration-closed', 'Registration is closed.');
        if (!object(input) || !text(input.email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
            !text(input.password, 128) || input.password.length < 12 || (kind === 'signup' && !text(input.name?.trim(), 100))) throw new Error('invalid_fields');
        // Serialize cookie mutations. A switch clears the old server session before another sign-in.
        const signedOut = await request('/api/auth/sign-out', 'POST', {});
        if (!object(signedOut) || signedOut.success !== true) throw new Error('invalid_signout');
        if (!current(ticket)) return state;
        const result = await request(kind === 'signup' ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email', 'POST',
          { email: input.email, password: input.password, rememberMe: false, ...(kind === 'signup' ? { name: input.name.trim() } : {}) });
        if (!object(result) || !id(result.user?.id)) throw new Error('invalid_auth');
        if (!current(ticket)) return state;
        return await readback(ticket);
      } catch (error) { return failure(error, ticket); }
    });
  }
  function signout() {
    const ticket = ++epoch; emit('anonymous', 'Account details cleared. Signing out…');
    if (!runtime) return Promise.resolve(emit('unavailable', 'Account service is unavailable; no server logout was performed.'));
    return serialized(async () => {
      if (existingSession && !current(ticket)) return state;
      try {
        const result = await request('/api/auth/sign-out', 'POST', {});
        if (!object(result) || result.success !== true) throw new Error('invalid_signout');
        return current(ticket) ? emit('anonymous', 'Signed out. Sign in to continue.') : state;
      } catch (error) {
        const message = 'Local account details cleared. Server sign-out could not be confirmed; close this browser before sharing it.';
        const detail = existingSession ? Object.freeze({ code: 'signout_unconfirmed', status: error.status ?? null, effect: 'unknown' }) : null;
        if (current(ticket)) return emit(existingSession ? 'unknown' : 'unavailable', message, null, null, detail);
        // A local clear must not hide the outcome of an already-dispatched cookie mutation.
        return existingSession ? Object.freeze({ status: 'unknown', message, account: null, entitlements: null, error: detail }) : state;
      }
    });
  }
  function clear() {
    epoch++; capabilities = null;
    return emit('unavailable', 'Local account details cleared. Local clear does not perform server sign-out.');
  }
  const credentialsUnavailable = () => { throw new Error('credential_submission_unavailable'); };
  return Object.freeze({ snapshot: () => state, capabilities: () => capabilities,
    refresh, me: refresh, entitlements: refresh,
    signin: existingSession ? credentialsUnavailable : input => authenticate('signin', input),
    signup: existingSession ? credentialsUnavailable : input => authenticate('signup', input), signout,
    switchAccount: existingSession ? credentialsUnavailable : input => authenticate('signin', input),
    ...(existingSession ? { clear, invalidate: clear } : {}) });
}

export function createAccountAdapter(options) { return accountAdapter(options); }

export function createConfiguredAccountAdapter(options) {
  const configured = configuredSessionOptions(options);
  return accountAdapter(configured, false, configured.sessionDispatch);
}

// Explicit local contract seam; never used by the page mount or real runtime configuration.
export function createSyntheticContractAdapter(options) {
  const runtime = validateRuntimeConfig(options?.config, options?.browserOrigin);
  if (!runtime || ![runtime.apiBase, runtime.verifiedBrowserOrigin].every(origin => new URL(origin).hostname.endsWith('.invalid')) ||
      typeof options?.fetchImpl !== 'function' || options.fetchImpl === globalThis.fetch) throw new Error('synthetic_transport_required');
  return accountAdapter(options, true);
}

export async function mountAccount(root, { fetchImpl = globalThis.fetch, browserOrigin = globalThis.location?.origin } = {}) {
  let config = null;
  try {
    const response = await fetchImpl('/assets/runtime-config.json', { credentials: 'omit', cache: 'no-store', redirect: 'error' });
    if (response.ok) config = await response.json();
  } catch {}
  const status = root.querySelector('[data-account-status]'), member = root.querySelector('[data-member]');
  const forms = [...root.querySelectorAll('form')];
  const adapter = createAccountAdapter({ config, browserOrigin, fetchImpl, onChange(state) {
    status.textContent = state.message;
    member.textContent = state.account ? `${state.account.name} · ${state.account.onboardingComplete ? 'Onboarding complete' : 'Onboarding in progress'} · ${state.entitlements.active.includes('form_plus') ? 'Form Plus entitlement confirmed' : 'No active Form Plus entitlement'}. Download and checkout are unavailable.` : '';
    member.hidden = !state.account;
    for (const form of forms) form.querySelector('fieldset').disabled = true;
    root.querySelector('[data-signout]').disabled = !validateRuntimeConfig(config, browserOrigin);
    root.querySelector('[data-registration]').textContent = adapter.capabilities()?.registration === 'closed' ? 'Registration is closed.' : 'Registration availability is determined by the server allowlist.';
  } });
  for (const form of forms) form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form), input = { email: data.get('email'), password: data.get('password'), name: data.get('name') };
    form.querySelector('[name=password]').value = '';
    await adapter[form.dataset.auth](input);
  });
  root.querySelector('[data-signout]').addEventListener('click', () => { forms.forEach(form => form.reset()); adapter.signout(); });
  root.querySelector('[data-refresh]').addEventListener('click', () => adapter.refresh());
  await adapter.refresh();
  return adapter;
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('[data-account]');
  if (root) mountAccount(root);
}
