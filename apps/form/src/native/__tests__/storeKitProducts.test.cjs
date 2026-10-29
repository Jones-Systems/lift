const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const modules = new Map();
class FormNativeError extends Error { constructor(code, message) { super(message); this.code = code; } }
function load(name) {
  const file = path.resolve(root, name);
  assert.ok(file.startsWith(root + path.sep));
  if (file === path.join(root, 'runtime.ts')) return { FormNativeError,
    bindFormNativeModule() { throw new Error('Tests must inject their native binding'); } };
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(specifier => {
    assert.ok(specifier.startsWith('.'), `Unexpected runtime dependency: ${specifier}`);
    return load(path.relative(root, path.resolve(path.dirname(file), specifier + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const { decodeStoreKitProducts, copyStoreKitProduct } = load('storeKitProducts.ts');
const { FormStoreKitAdapter } = load('storeKit.ts');
const ID = 'synthetic.subscription';
const base = () => ({ id: ID, displayName: '会員プラン', description: 'تفاصيل الاشتراك',
  displayPrice: '12,30\u00a0€', price: '12.30000000000000000001', currencyCode: 'EUR', type: 'opaque-native-future-value' });
const metadata = () => ({ version: 1, status: 'available', subscriptionGroupId: 'synthetic-group',
  period: { unit: 'month', value: 3 }, introductoryOffer: { status: 'none' }, introductoryOfferEligibility: 'unknown' });
const product = () => ({ ...base(), subscriptionMetadata: metadata() });
const catalog = (p = product()) => ({ products: [p], missingProductIds: [] });
const decode = p => decodeStoreKitProducts(catalog(p), [ID]).products[0];
const normalized = m => decode({ ...base(), subscriptionMetadata: m }).subscriptionMetadata;
const unavailable = reason => ({ version: 1, status: 'unavailable', reason });
const offer = (paymentMode = 'free_trial') => ({ status: 'available', paymentMode,
  displayPrice: '無料', price: paymentMode === 'free_trial' ? '00.000' : '1.234567890123456789',
  period: { unit: 'week', value: 2 }, periodCount: paymentMode === 'pay_as_you_go' ? 6 : 1 });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('period units and non-unit counts retain calendar meaning independently of raw product type', () => {
  for (const unit of ['day', 'week', 'month', 'year']) {
    const m = metadata(); m.period = { unit, value: 7 };
    assert.deepEqual(normalized(m).period, { unit, value: 7 });
  }
  assert.equal(decode(product()).type, 'opaque-native-future-value');
  for (const period of [null, {}, { unit: 'fortnight', value: 1 }, ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1']
    .map(value => ({ unit: 'month', value }))])
    assert.deepEqual(normalized({ ...metadata(), period }), unavailable('invalid_metadata'));
});

test('known non-auto-renewing kinds and native unavailable reasons never gain subscription facts', () => {
  for (const productKind of ['consumable', 'non_consumable', 'non_renewing_subscription'])
    assert.deepEqual(normalized({ version: 1, status: 'not_applicable', productKind }), { version: 1, status: 'not_applicable', productKind });
  for (const reason of ['unsupported_product_type', 'subscription_missing', 'unsupported_period', 'invalid_metadata', 'legacy_bridge', 'unsupported_version'])
    assert.deepEqual(normalized(unavailable(reason)), unavailable(reason));
  assert.deepEqual(normalized({ version: 1, status: 'not_applicable', productKind: 'future' }), unavailable('invalid_metadata'));
});

test('legacy, future version and malformed v1 inputs normalize without rejecting valid base fields', () => {
  assert.deepEqual(decode(base()).subscriptionMetadata, unavailable('legacy_bridge'));
  assert.deepEqual(normalized({ version: 2, status: 'available', invented: true }), unavailable('unsupported_version'));
  for (const m of [null, [], {}, { version: 1 }, { ...metadata(), subscriptionGroupId: '' },
    { ...metadata(), introductoryOfferEligibility: true }, { ...metadata(), introductoryOffer: undefined },
    { version: 1, status: 'unavailable', reason: 'invented' }])
    assert.deepEqual(normalized(m), unavailable('invalid_metadata'));
  const withExtras = { ...metadata(), grantsMembership: true };
  assert.equal('grantsMembership' in normalized(withExtras), false);
});

test('offer presence and all eligibility states are independent, and no eligibility grants access', () => {
  for (const introductoryOfferEligibility of ['eligible', 'ineligible', 'unknown', 'unavailable']) {
    for (const introductoryOffer of [{ status: 'none' }, offer()]) {
      const m = normalized({ ...metadata(), introductoryOffer, introductoryOfferEligibility });
      assert.equal(m.introductoryOfferEligibility, introductoryOfferEligibility);
      assert.deepEqual(m.introductoryOffer, introductoryOffer);
      assert.equal('entitlements' in m, false);
    }
  }
});

test('every supported offer mode keeps its own period, exact price and discounted renewal count', () => {
  for (const mode of ['free_trial', 'pay_as_you_go', 'pay_up_front']) {
    const introductoryOffer = offer(mode), m = normalized({ ...metadata(), introductoryOffer });
    assert.deepEqual(m.period, { unit: 'month', value: 3 });
    assert.deepEqual(m.introductoryOffer, introductoryOffer);
  }
  for (const reason of ['unsupported_offer_type', 'unsupported_payment_mode', 'unsupported_period', 'invalid_metadata']) {
    const introductoryOffer = { status: 'unavailable', reason };
    assert.deepEqual(normalized({ ...metadata(), introductoryOffer }).introductoryOffer, introductoryOffer);
  }
});

test('malformed offers fail closed on count, mode, period, price and zero-price trial rules', () => {
  const invalid = [null, {}, { ...offer(), paymentMode: 'future' }, { ...offer(), period: { unit: 'future', value: 1 } },
    { ...offer(), price: '0.01' }, { ...offer(), price: '-0' }, { ...offer(), price: 0 }, { ...offer(), displayPrice: '' },
    { status: 'unavailable', reason: 'future' }];
  for (const mode of ['free_trial', 'pay_as_you_go', 'pay_up_front']) {
    for (const periodCount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) invalid.push({ ...offer(mode), periodCount });
    if (mode !== 'pay_as_you_go') invalid.push({ ...offer(mode), periodCount: 2 });
  }
  for (const introductoryOffer of invalid)
    assert.deepEqual(normalized({ ...metadata(), introductoryOffer }), unavailable('invalid_metadata'));
});

test('Unicode, nonbreaking spaces, comma localization, zero decimals and decimal text survive exactly', () => {
  for (const patch of [{}, { displayPrice: '￥1,200', price: '1200', currencyCode: 'JPY' },
    { displayPrice: 'مجاني\u202f٠', price: '0.00', currencyCode: 'KWD' }]) {
    const p = { ...base(), ...patch }, out = decode(p);
    for (const key of Object.keys(p)) assert.equal(out[key], p[key]);
  }
  for (const price of ['1,20', '-1', '+1', '1e2', 'NaN', 'Infinity', '.1', '1.', ' 1', 1, '1'.repeat(129)])
    assert.throws(() => decode({ ...base(), price }), { code: 'invalid_products' });
  for (const currencyCode of ['eur', 'EU', 'EURO', '', null])
    assert.throws(() => decode({ ...base(), currencyCode }), { code: 'invalid_products' });
});

test('catalog and request bounds, duplicates, foreign IDs, overlap and incomplete accounting are rejected', () => {
  const valid = catalog(base());
  for (const requested of [[], [ID, ID], ['bad id'], ['x'.repeat(201)], Array.from({ length: 33 }, (_, i) => `id${i}`)])
    assert.throws(() => decodeStoreKitProducts(valid, requested), { code: 'invalid_products' });
  for (const value of [null, [], {}, { products: {}, missingProductIds: [] }, { products: [], missingProductIds: null },
    { products: [base(), base()], missingProductIds: [] }, { products: [base()], missingProductIds: [ID] },
    { products: [], missingProductIds: [ID, ID] }, { products: [base()], missingProductIds: ['foreign'] },
    { products: [], missingProductIds: [] }, catalog({ ...base(), id: 'foreign' }),
    { products: Array(33).fill(base()), missingProductIds: [] }, { products: [], missingProductIds: Array(33).fill(ID) }])
    assert.throws(() => decodeStoreKitProducts(value, [ID]), { code: 'invalid_products' });
  for (const key of ['id', 'displayName', 'description', 'displayPrice', 'type'])
    for (const value of ['', null, ' '.repeat(2), 'x'.repeat(16385)])
      assert.throws(() => decode({ ...base(), [key]: value }), { code: 'invalid_products' });
  const ids = Array.from({ length: 32 }, (_, i) => `id${i}`);
  assert.equal(decodeStoreKitProducts({ products: ids.map(id => ({ ...base(), id })), missingProductIds: [] }, ids).products.length, 32);
  assert.deepEqual(decodeStoreKitProducts({ products: [base()], missingProductIds: ['missing'] }, [ID, 'missing']).missingProductIds, ['missing']);
});

test('decoding and copying isolate every nested period and offer from input and returned mutations', () => {
  const input = product(); input.subscriptionMetadata.introductoryOffer = offer();
  const out = decode(input), copy = copyStoreKitProduct(out);
  input.subscriptionMetadata.period.value = 99;
  input.subscriptionMetadata.introductoryOffer.period.unit = 'year';
  copy.subscriptionMetadata.period.value = 77;
  copy.subscriptionMetadata.introductoryOffer.period.value = 55;
  assert.deepEqual(out.subscriptionMetadata.period, { unit: 'month', value: 3 });
  assert.deepEqual(out.subscriptionMetadata.introductoryOffer.period, { unit: 'week', value: 2 });
});

async function adapterFixture(change = () => {}) {
  const calls = [], native = {
    configure: async ids => { calls.push(['configure', ids]); return { configured: true }; },
    products: async ids => { calls.push(['products', ids]); return catalog(); },
    stopObserving: async () => { calls.push(['stop']); return { observing: false }; },
  };
  for (const method of ['purchase', 'restore', 'currentEntitlements', 'unfinishedTransactions', 'acknowledgeServerDelivery', 'startObserving', 'addListener'])
    native[method] = () => { throw new Error(`Forbidden metadata effect: ${method}`); };
  const delivery = { currentAccount() { throw new Error('Metadata must not read account delivery port'); },
    verifyAndDeliver() { throw new Error('Metadata must not deliver'); } };
  const binding = { module: native, reason: 'available' };
  change(native);
  const adapter = new FormStoreKitAdapter(delivery, binding);
  await adapter.configure([ID]);
  return { adapter, native, binding, calls };
}

test('adapter validates the original requested list even if a native port mutates its argument', async () => {
  const f = await adapterFixture(native => { native.products = async ids => {
    ids.push('foreign'); return { products: [], missingProductIds: ids };
  }; });
  try { await assert.rejects(f.adapter.products(), { code: 'invalid_products' }); }
  finally { await f.adapter.dispose(); }
});

test('overlapping adapter lookups discard an older result even after a newer lookup fails', async () => {
  const f = await adapterFixture(), older = deferred(), newer = deferred();
  try {
    let call = 0; f.native.products = () => ++call === 1 ? older.promise : newer.promise;
    const oldResult = f.adapter.products(), newResult = f.adapter.products();
    const oldRejected = assert.rejects(oldResult, { code: 'products_stale' });
    const newRejected = assert.rejects(newResult, /lookup failure/);
    newer.reject(new Error('lookup failure')); older.resolve(catalog());
    await Promise.all([oldRejected, newRejected]);
    f.native.products = async () => catalog();
    assert.equal((await f.adapter.products()).products[0].id, ID);
  } finally { await f.adapter.dispose(); }
});

test('adapter disposal or native binding replacement fences late lookup results', async () => {
  for (const action of ['dispose', 'replace-native']) {
    const f = await adapterFixture(), pending = deferred();
    f.native.products = () => pending.promise;
    const result = f.adapter.products(), rejected = assert.rejects(result, { code: 'products_stale' });
    if (action === 'dispose') await f.adapter.dispose();
    else f.binding.module = { ...f.native };
    pending.resolve(catalog()); await rejected;
    if (action !== 'dispose') await f.adapter.dispose();
  }
});

test('configuration copies its original IDs and rejects a superseded or disposed configuration', async () => {
  for (const action of ['supersede', 'dispose']) {
    const pending = deferred(), calls = [], native = {
      configure(ids) { calls.push(ids); return calls.length === 1 ? pending.promise : Promise.resolve({ configured: true }); },
      stopObserving: async () => ({ observing: false }), products: async ids => ({ products: [], missingProductIds: ids }),
    };
    const adapter = new FormStoreKitAdapter({}, { module: native, reason: 'available' });
    const ids = [ID], first = adapter.configure(ids), rejected = assert.rejects(first, { code: 'products_stale' });
    ids[0] = 'caller-mutated';
    if (action === 'supersede') await adapter.configure(['replacement']);
    else await adapter.dispose();
    pending.resolve({ configured: true }); await rejected;
    assert.deepEqual(calls[0], [ID]);
    if (action === 'supersede') {
      assert.deepEqual((await adapter.products()).missingProductIds, ['replacement']);
      await adapter.dispose();
    }
  }
});

test('independent device/session adapters obtain separate snapshots and metadata performs no delivery or entitlement effects', async () => {
  const oldPhone = await adapterFixture(), newPhone = await adapterFixture();
  try {
    oldPhone.native.products = async () => catalog({ ...product(), subscriptionMetadata: { ...metadata(), introductoryOfferEligibility: 'ineligible' } });
    newPhone.native.products = async ids => { newPhone.calls.push(['products', ids]); return catalog(); };
    const first = await oldPhone.adapter.products(), second = await newPhone.adapter.products();
    first.products[0].subscriptionMetadata.period.value = 99;
    assert.equal(second.products[0].subscriptionMetadata.period.value, 3);
    assert.equal(second.products[0].subscriptionMetadata.introductoryOfferEligibility, 'unknown');
    assert.deepEqual(newPhone.calls.map(call => call[0]), ['configure', 'products']);
  } finally { await oldPhone.adapter.dispose(); await newPhone.adapter.dispose(); }
});
