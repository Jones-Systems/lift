import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountAdapter, createSyntheticContractAdapter, createConfiguredAccountAdapter, validateRuntimeConfig, parseMe, parseEntitlements, parseCapabilities, parsePurchaseCapabilities } from '../public/account.mjs';
import { accountPages } from '../src/account-page.mjs';

// SYNTHETIC CONTRACT TESTS ONLY. No DNS, provider, real account or credential is used.
const config = { apiBase: 'https://api.example.invalid', verifiedBrowserOrigin: 'https://site.example.invalid', trackingEnabled: false, checkout: null, download: null };
const browserOrigin = config.verifiedBrowserOrigin;
const credentials = { email: 'synthetic@example.invalid', password: 'synthetic-only-passphrase', name: 'Synthetic' };
const capabilities = (status = 'configured_unverified', registration = 'allowlist') => ({ authentication: { emailPassword: { status, registration, passwordRecovery: 'unconfigured', emailChange: 'unconfigured' }, session: { transport: 'signed_bearer_or_cookie', expiresInSeconds: 604800 } } });
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const me = (accountId = A) => ({ accountId, appAccountToken: accountId, profile: { revision: 0, name: 'Synthetic' }, preferences: { revision: 0 }, onboarding: { revision: 0, status: 'draft' } });
const purchases = (status = 'unconfigured') => ({ status, environment: 'Sandbox', chargesEnabled: false, verification: 'apple_jws_offline', onlineCertificateRevocation: false });
const entitlementsFor = (accountId = A) => ({ accountId, appAccountToken: accountId, grants: [], active: [], purchases: purchases() });
const entitlements = entitlementsFor();
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
function transport(overrides = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    const path = new URL(url).pathname; calls.push({ path, options });
    if (overrides[path]) return overrides[path](options);
    if (path === '/v1/capabilities') return response(capabilities());
    if (path === '/v1/me') return response(me());
    if (path === '/v1/entitlements') return response(entitlements);
    if (path === '/api/auth/sign-out') return response({ success: true });
    if (path === '/api/auth/sign-in/email' || path === '/api/auth/sign-up/email') return response({ user: { id: 'synthetic_user' } });
    assert.fail(`Unexpected synthetic route ${path}`);
  } };
}
const adapterFor = mock => createSyntheticContractAdapter({ config, browserOrigin, fetchImpl: mock.fetchImpl });

const configuredAdapterFor = mock => {
  let queue = Promise.resolve();
  return createConfiguredAccountAdapter({ config, browserOrigin, fetchImpl: mock.fetchImpl,
    sessionDispatch: { run(operation) { const result = queue.then(operation); queue = result.catch(() => {}); return result; } } });
};

test('configured account requires explicit transport and dispatcher without requests at construction', async () => {
  const mock = transport();
  assert.throws(() => createConfiguredAccountAdapter({ config, browserOrigin }), /configured_session_options_required/);
  assert.throws(() => createConfiguredAccountAdapter({ config, browserOrigin, fetchImpl: mock.fetchImpl }), /configured_session_options_required/);
  const adapter = configuredAdapterFor(mock);
  assert.equal(mock.calls.length, 0);
  await adapter.refresh();
  assert.equal(adapter.snapshot().status, 'authenticated');
  assert.deepEqual(mock.calls.map(call => call.path), ['/v1/capabilities', '/v1/me', '/v1/entitlements', '/v1/me']);
  assert.equal(adapter.capabilities().status, 'configured_unverified');
  const count = mock.calls.length;
  for (const method of ['signin', 'signup', 'switchAccount']) {
    assert.throws(() => adapter[method](credentials), /credential_submission_unavailable/);
  }
  assert.equal(mock.calls.length, count);
});

test('configured account metadata cannot replace server identity proof', async () => {
  const mock = transport({ '/v1/me': () => response({}, 401) });
  const adapter = configuredAdapterFor(mock);
  await adapter.refresh();
  assert.equal(adapter.snapshot().status, 'anonymous'); assert.equal(adapter.snapshot().account, null);
  assert.deepEqual(mock.calls.map(call => call.path), ['/v1/capabilities', '/v1/me']);
});

test('configured queued signout invalidated before dispatch performs no cookie mutation', async () => {
  const mock = transport(), adapter = configuredAdapterFor(mock);
  const pending = adapter.signout();
  adapter.clear();
  const result = await pending;
  assert.equal(result.status, 'unavailable'); assert.match(result.message, /Local clear does not perform server sign-out/);
  assert.equal(mock.calls.length, 0);
});

test('absent, malformed and insecure configuration makes zero API requests', async () => {
  for (const candidate of [undefined, {}, { ...config, apiBase: null }, { ...config, apiBase: 'http://api.example.invalid' },
    { ...config, verifiedBrowserOrigin: 'https://other.example.invalid' }, { ...config, apiBase: 'https://user:pass@api.example.invalid' },
    { ...config, apiBase: 'https://api.example.invalid/path' }, { ...config, apiBase: 'https://api.example.invalid?key=x' }]) {
    let calls = 0;
    const adapter = createAccountAdapter({ config: candidate, browserOrigin, fetchImpl: () => { calls++; assert.fail('Network forbidden'); } });
    await adapter.refresh(); await adapter.signin(credentials); await adapter.signup(credentials); await adapter.signout();
    assert.equal(calls, 0); assert.equal(adapter.snapshot().status, 'unavailable');
  }
  assert.equal(validateRuntimeConfig(config, 'http://127.0.0.1:4000'), null);
});

test('unverified capability never submits credentials or grants access', async () => {
  const mock = transport({ '/v1/capabilities': () => response(capabilities('configured_unverified')) });
  const adapter = createAccountAdapter({ config, browserOrigin, fetchImpl: mock.fetchImpl });
  await adapter.refresh(); await adapter.signin(credentials);
  assert.equal(adapter.snapshot().status, 'unavailable');
  assert.ok(mock.calls.every(call => call.path === '/v1/capabilities'));
});

test('closed registration makes no auth mutation', async () => {
  const mock = transport({ '/v1/capabilities': () => response(capabilities('configured_unverified', 'closed')) });
  const adapter = adapterFor(mock); await adapter.signup(credentials);
  assert.equal(adapter.snapshot().status, 'registration-closed'); assert.equal(mock.calls.length, 1);
});

test('signin and signup require full server readback and include cookies only', async () => {
  for (const method of ['signin', 'signup']) {
    const mock = transport(), adapter = adapterFor(mock); await adapter[method](credentials);
    assert.equal(adapter.snapshot().status, 'authenticated'); assert.equal(adapter.snapshot().account.accountId, A);
    assert.deepEqual(adapter.snapshot().entitlements.active, []);
    assert.deepEqual(mock.calls.map(c => c.path), ['/v1/capabilities', '/api/auth/sign-out', method === 'signin' ? '/api/auth/sign-in/email' : '/api/auth/sign-up/email', '/v1/me', '/v1/entitlements', '/v1/me']);
    for (const { options } of mock.calls) { assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Origin, undefined); }
    const body = JSON.parse(mock.calls[2].options.body); assert.equal(body.rememberMe, false);
  }
});

test('malformed auth, account, capability and entitlement responses fail closed', async () => {
  for (const path of ['/v1/capabilities', '/api/auth/sign-in/email', '/v1/me', '/v1/entitlements']) {
    const adapter = adapterFor(transport({ [path]: () => response({ active: ['form_plus'], authenticated: true }) }));
    await adapter.signin(credentials); assert.equal(adapter.snapshot().status, 'unavailable');
    assert.equal(adapter.snapshot().account, null); assert.equal(adapter.snapshot().entitlements, null);
  }
  assert.throws(() => parseMe({ ...me(), onboarding: { revision: 0, completed: true } }));
  assert.throws(() => parseEntitlements({ ...entitlements, active: ['form_plus'] }, me()));
  assert.throws(() => parseEntitlements({ ...entitlements, grants: [{ id: 'x', active: true }] }, me()));
});

test('expired session and network failure clear previously confirmed access', async () => {
  let expired = false;
  const adapter = adapterFor(transport({ '/v1/me': () => response(expired ? {} : me(), expired ? 401 : 200) }));
  await adapter.refresh(); assert.equal(adapter.snapshot().status, 'authenticated');
  expired = true; await adapter.refresh(); assert.equal(adapter.snapshot().status, 'anonymous'); assert.equal(adapter.snapshot().account, null);
  const failed = adapterFor(transport({ '/v1/entitlements': () => { throw new Error('Synthetic offline'); } }));
  await failed.refresh(); assert.equal(failed.snapshot().status, 'unavailable'); assert.equal(failed.snapshot().entitlements, null);
});

test('logout immediately clears access and late readback cannot restore it', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const mock = transport({ '/v1/me': () => { entered(); return delayed; } });
  const adapter = adapterFor(mock), reading = adapter.refresh(); await started;
  const leaving = adapter.signout(); assert.equal(adapter.snapshot().account, null); assert.equal(adapter.snapshot().status, 'anonymous');
  release(response(me())); await reading; await leaving;
  assert.equal(adapter.snapshot().status, 'anonymous'); assert.equal(adapter.snapshot().entitlements, null);
  assert.equal(mock.calls.at(-1).path, '/api/auth/sign-out');
});

test('account switch clears details immediately and cannot display prior identity', async () => {
  let accountId = A;
  const mock = transport({ '/v1/me': () => response(me(accountId)), '/v1/entitlements': () => response(entitlementsFor(accountId)), '/api/auth/sign-in/email': () => { accountId = B; return response({ user: { id: 'synthetic_user_B' } }); } });
  const adapter = adapterFor(mock); await adapter.refresh();
  const switching = adapter.switchAccount(credentials); assert.equal(adapter.snapshot().account, null);
  await switching; assert.equal(adapter.snapshot().account.accountId, B);
});

test('identity drift during entitlement readback fails closed', async () => {
  let reads = 0;
  const adapter = adapterFor(transport({ '/v1/me': () => response(me(++reads === 1 ? A : B)) }));
  await adapter.refresh(); assert.equal(adapter.snapshot().status, 'unavailable'); assert.equal(adapter.snapshot().account, null);
});

test('logout failure clears local access and reports unconfirmed server effect', async () => {
  const adapter = adapterFor(transport({ '/api/auth/sign-out': () => response({}, 503) }));
  await adapter.refresh(); await adapter.signout();
  assert.equal(adapter.snapshot().account, null); assert.equal(adapter.snapshot().status, 'unavailable');
  assert.match(adapter.snapshot().message, /could not be confirmed/);
});

test('generated account and privacy routes use external modules and disabled credential fields', () => {
  const pages = accountPages(); assert.deepEqual(pages.map(x => x.path), ['account/index.html', 'privacy/index.html']);
  for (const { html } of pages) { assert.match(html, /^<!doctype html>/i); assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/); assert.doesNotMatch(html, /on(?:click|submit|change)=/); }
  assert.match(pages[0].html, /<fieldset disabled>/); assert.match(pages[0].html, /password recovery|Password recovery/);
});

test('logout waits behind in-flight signin cookie mutation without restoring local access', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const mock = transport({ '/api/auth/sign-in/email': () => { entered(); return held; } });
  const adapter = adapterFor(mock), signingIn = adapter.signin(credentials); await started;
  const signingOut = adapter.signout(); assert.equal(adapter.snapshot().account, null);
  release(response({ user: { id: 'synthetic_user' } }));
  await signingIn; await signingOut;
  assert.deepEqual(mock.calls.map(x => x.path), ['/v1/capabilities', '/api/auth/sign-out', '/api/auth/sign-in/email', '/api/auth/sign-out']);
  assert.equal(adapter.snapshot().status, 'anonymous'); assert.equal(adapter.snapshot().entitlements, null);
});

test('active entitlement can only come from coherent synthetic server grants', async () => {
  const grant = { id: 'synthetic_grant', entitlement: 'form_plus', source: 'promo', environment: 'zero_charge',
    grantedAt: '2026-10-09T00:00:00.000Z', expiresAt: '2027-10-09T00:00:00.000Z', active: true };
  const valid = { ...entitlements, grants: [grant], active: ['form_plus'] };
  const adapter = adapterFor(transport({ '/v1/entitlements': () => response(valid) }));
  await adapter.refresh(); assert.deepEqual(adapter.snapshot().entitlements.active, ['form_plus']);
  for (const invalid of [{ ...valid, active: ['form_plus', 'form_plus'] }, { ...valid, active: ['unknown_access'] },
    { ...valid, grants: [{ ...grant, active: false }] }, { ...valid, grants: [{ ...grant, expiresAt: 'invalid-date' }] },
    { ...valid, purchases: { status: 'verified', entitled: true } }]) assert.throws(() => parseEntitlements(invalid, me()));
});

test('failed signout on switch never submits replacement credentials', async () => {
  const mock = transport({ '/api/auth/sign-out': () => response({ success: false }) });
  const adapter = adapterFor(mock); await adapter.switchAccount(credentials);
  assert.equal(adapter.snapshot().status, 'unavailable'); assert.equal(adapter.snapshot().account, null);
  assert.ok(mock.calls.every(x => x.path !== '/api/auth/sign-in/email'));
});

const appleGrant = { id: 'synthetic_apple', entitlement: 'form_plus', source: 'apple', sourceId: '1234567890',
  grantedAt: '2026-01-01T00:00:00.000Z', expiresAt: null, environment: 'Sandbox', active: true };
const appleReadback = (accountId = A) => ({ ...entitlementsFor(accountId), grants: [appleGrant], active: ['form_plus'], purchases: purchases('configured_unverified') });

test('exact dormant purchase capabilities accept both source states without enabling checkout', () => {
  for (const status of ['unconfigured', 'configured_unverified']) assert.equal(parsePurchaseCapabilities(purchases(status)).chargesEnabled, false);
  for (const invalid of [{status:'unconfigured'}, {...purchases(),status:'verified'}, {...purchases(),environment:'Production'},
    {...purchases(),chargesEnabled:true}, {...purchases(),verification:'client_claim'}, {...purchases(),onlineCertificateRevocation:true},
    {...purchases(),checkout:'https://example.invalid'}]) assert.throws(() => parsePurchaseCapabilities(invalid));
});

test('identity requires the canonical stable UUID and token; entitlement identity must match me', async () => {
  for (const invalid of [{...me(),appAccountToken:B}, {...me(),accountId:'synthetic_A',appAccountToken:'synthetic_A'}, {...me(),appAccountToken:undefined}]) assert.throws(() => parseMe(invalid));
  for (const invalid of [{...appleReadback(),accountId:B,appAccountToken:B}, {...appleReadback(),appAccountToken:B},
    {...appleReadback(),accountId:undefined}, {...appleReadback(),appAccountToken:undefined}]) {
    assert.throws(() => parseEntitlements(invalid,me()));
    const adapter = adapterFor(transport({'/v1/entitlements':()=>response(invalid)}));
    await adapter.refresh();assert.equal(adapter.snapshot().status,'unavailable');assert.equal(adapter.snapshot().entitlements,null);
  }
  assert.throws(()=>parseEntitlements(appleReadback()));
});

test('current promo and Sandbox Apple union accepts null nonconsumable expiry and server revocation', async () => {
  const promo={id:'synthetic_promo',entitlement:'form_plus',source:'promo',environment:'zero_charge',grantedAt:'2026-01-01T00:00:00.000Z',expiresAt:'2027-01-01T00:00:00.000Z',active:true};
  const value={...appleReadback(),grants:[promo,appleGrant]};
  assert.deepEqual(parseEntitlements(value,me()).active,['form_plus']);
  assert.equal(parseEntitlements(value,me()).purchases,'unavailable');
  const adapter=adapterFor(transport({'/v1/entitlements':()=>response(value)}));await adapter.refresh();assert.equal(adapter.snapshot().account.appAccountToken,A);
  for (const expiry of [null,'2027-01-01T00:00:00.000Z']) assert.deepEqual(parseEntitlements({...appleReadback(),grants:[{...appleGrant,expiresAt:expiry}]},me()).active,['form_plus']);
  assert.deepEqual(parseEntitlements({...appleReadback(),grants:[{...appleGrant,active:false,expiresAt:'2026-02-01T00:00:00.000Z'}],active:[]},me()).active,[]);
  for(const grant of [{...appleGrant,source:'stripe'},{...appleGrant,environment:'Production'},{...appleGrant,sourceId:undefined},
    {...appleGrant,sourceId:'JWS.fake.proof'},{...appleGrant,sourceId:''},{...appleGrant,expiresAt:42},{...appleGrant,expiresAt:'2026-02-30T00:00:00.000Z'},
    {...appleGrant,expiresAt:'not-a-date'},{...appleGrant,grantedAt:null},{...appleGrant,proof:'not-accepted'}, {...promo,expiresAt:null}]) assert.throws(()=>parseEntitlements({...value,grants:[grant]},me()));
  assert.throws(()=>parseEntitlements({...appleReadback(),purchases:purchases()},me()));
  assert.throws(()=>parseEntitlements({...appleReadback(),grants:[appleGrant,appleGrant]},me()));
  assert.throws(()=>parseEntitlements({...appleReadback(),grants:[appleGrant,{...appleGrant,id:'another_grant'}]},me()));
});

test('production adapter never authenticates from dormant or hypothetical capability status', async () => {
  for(const status of ['configured_unverified','unconfigured','verified']) {
    const mock=transport({'/v1/capabilities':()=>response(capabilities(status))});
    const adapter=createAccountAdapter({config,browserOrigin,fetchImpl:mock.fetchImpl});await adapter.refresh();await adapter.signin(credentials);
    assert.equal(adapter.snapshot().status,'unavailable');assert.ok(mock.calls.every(x=>x.path==='/v1/capabilities'));
  }
  assert.throws(()=>parseCapabilities(capabilities('verified')));
  assert.throws(()=>parseCapabilities({...capabilities(),authentication:{...capabilities().authentication,session:{transport:'signed_bearer_or_cookie',expiresInSeconds:1}}}));
  assert.throws(()=>createSyntheticContractAdapter({config,browserOrigin}));
  assert.throws(()=>createSyntheticContractAdapter({config:{...config,apiBase:'https://real.example.com'},browserOrigin,fetchImpl:async()=>{}}));
});

test('late account-bound Apple entitlement readback cannot restore previous account after switch', async () => {
  let entered,release,accountId=A,held=true;const started=new Promise(r=>entered=r),delayed=new Promise(r=>release=r),states=[];
  const mock=transport({'/v1/me':()=>response(me(accountId)), '/v1/entitlements':()=>{if(held){held=false;entered();return delayed;}return response(entitlementsFor(accountId));},
    '/api/auth/sign-in/email':()=>{accountId=B;return response({user:{id:'synthetic_user_B'}});}});
  const adapter=createSyntheticContractAdapter({config,browserOrigin,fetchImpl:mock.fetchImpl,onChange:s=>states.push(s)});
  const reading=adapter.refresh();await started;const switching=adapter.switchAccount(credentials);assert.equal(adapter.snapshot().account,null);
  release(response(appleReadback(A)));await reading;await switching;
  assert.equal(adapter.snapshot().account.accountId,B);assert.deepEqual(adapter.snapshot().entitlements.active,[]);
  assert.ok(states.filter(s=>s.status==='authenticated').every(s=>s.account.accountId===B));
});


test('current four-field mail metadata is preserved without enabling credential or recovery actions', async () => {
  for (const mailStatus of ['unconfigured', 'configured_unverified', 'verified']) {
    const actual = capabilities();
    Object.assign(actual.authentication.emailPassword, { passwordRecovery: mailStatus, emailChange: mailStatus });
    Object.assign(actual.authentication, { google: { status: 'unconfigured' }, apple: { status: 'unconfigured' }, phone: { status: 'unconfigured' } });
    const parsed = parseCapabilities(actual);
    assert.deepEqual(parsed, { status: 'configured_unverified', registration: 'allowlist', passwordRecovery: mailStatus, emailChange: mailStatus, recovery: 'unavailable' });
    assert.equal(Object.isFrozen(parsed), true);
    const mock = transport({ '/v1/capabilities': () => response(actual) });
    const adapter = configuredAdapterFor(mock);
    await adapter.refresh();
    assert.equal(adapter.snapshot().status, 'authenticated');
    assert.deepEqual(mock.calls.map(call => call.path), ['/v1/capabilities', '/v1/me', '/v1/entitlements', '/v1/me']);
    const count = mock.calls.length;
    for (const method of ['signin', 'signup', 'switchAccount']) assert.throws(() => adapter[method](credentials), /credential_submission_unavailable/);
    assert.equal(mock.calls.length, count);
    const closed = createAccountAdapter({ config, browserOrigin, fetchImpl: mock.fetchImpl });
    await closed.refresh();
    assert.equal(closed.snapshot().status, 'unavailable');
    assert.equal(mock.calls.at(-1).path, '/v1/capabilities');
  }
});

test('strict capability fields and statuses reject missing, extra and invented metadata', async () => {
  for (const mutate of [
    value => { delete value.authentication.emailPassword.emailChange; },
    value => { value.authentication.emailPassword.extra = 'unconfigured'; },
    value => { value.authentication.emailPassword.passwordRecovery = 'enabled'; },
    value => { value.authentication.emailPassword.emailChange = true; },
    value => { value.authentication.emailPassword.status = 'verified'; },
    value => { value.authentication.session.expiresInSeconds = 0; },
    value => { value.authentication.session.extra = true; },
  ]) {
    const invalid = capabilities(); mutate(invalid);
    assert.throws(() => parseCapabilities(invalid), /invalid_capabilities/);
    const mock = transport({ '/v1/capabilities': () => response(invalid) });
    const adapter = configuredAdapterFor(mock); await adapter.refresh();
    assert.equal(adapter.snapshot().status, 'unavailable');
    assert.equal(adapter.snapshot().account, null);
    assert.deepEqual(mock.calls.map(call => call.path), ['/v1/capabilities']);
  }
  const mock = transport({ '/v1/capabilities': () => response(capabilities('unconfigured', 'closed')) });
  const adapter = configuredAdapterFor(mock); await adapter.refresh();
  assert.equal(adapter.snapshot().status, 'unavailable');
  assert.equal(adapter.capabilities().status, 'unconfigured');
  assert.equal(adapter.capabilities().recovery, 'unavailable');
  assert.deepEqual(mock.calls.map(call => call.path), ['/v1/capabilities']);
});
