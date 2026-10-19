const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../' + name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(specifier => {
    assert.ok(specifier.startsWith('./')); return load(specifier.slice(2));
  }, module, module.exports);
  cache.set(name, module.exports); return module.exports;
}
const { captureSourceSetDraft, captureSourceSetChanges, createSourceTrainingResources } = load('sourceTrainingResources');
const { decodePerformedSet } = load('trainingCodec');
const date = '2026-10-13T00:00:00.000Z';
const known = (value = 12, unit = 'kg', basis = 'total') => ({ state: 'knownValue', value, unit, basis });
const unknown = { state: 'unknown', confirmed: true };
const draft = (load = known(), version = 2) => ({ schema: `form.source-performed-set/v${version}`, occurrenceId: 'occurrence', setNumber: 1, status: 'confirmed',
  performance: { schema: `form.source-performance/v${version}`, kind: 'repetitions', reps: 8, load } });
const saved = (input, revision = 1) => ({ ...structuredClone(input), id: 'set', revision, createdAt: date, updatedAt: date });
const session = { id: 'session', revision: 1 };
const invalid = error => error.code === 'invalid_source_training_command';
const badReceipt = error => error.code === 'training_response_invalid' && error.effectUnknown;

test('v2 capture/decoder preserve each literal meaning, detach and freeze every performance field', () => {
  const loads = [unknown, ...['bodyweight', 'unloaded', 'timedActivity'].map(reason => ({ state: 'notApplicable', reason }))];
  for (const basis of ['total', 'perImplement', 'perSide', 'assistance']) for (const unit of ['kg', 'lb'])
    for (const value of [0, 12, 500]) loads.push(known(value, unit, basis));
  for (const reported of loads) {
    const input = draft(reported), capture = captureSourceSetDraft(input), decoded = decodePerformedSet(saved(input));
    assert.deepEqual(capture, input); assert.deepEqual(decoded, saved(input));
    assert.notEqual(capture.performance.load, input.performance.load);
    assert.ok(Object.isFrozen(capture) && Object.isFrozen(capture.performance) && Object.isFrozen(capture.performance.load));
    assert.ok(Object.isFrozen(decoded) && Object.isFrozen(decoded.performance) && Object.isFrozen(decoded.performance.load));
  }
  const input = draft(); delete input.performance.load;
  const capture = captureSourceSetDraft(input);
  assert.deepEqual(capture.performance.load, unknown);
  assert.throws(() => decodePerformedSet(saved(input)), badReceipt);
  const practice = draft(unknown); practice.performance.kind = 'controlled-practice'; delete practice.performance.reps;
  assert.deepEqual(captureSourceSetDraft(practice), practice);
  assert.equal(Object.hasOwn(captureSourceSetDraft(practice).performance, 'reps'), false);
});

test('closed v1/v2 pairing rejects accessors, mixed versions, unsupported basis and invalid values before request', async () => {
  let reads = 0, requests = 0;
  const getter = draft(); Object.defineProperty(getter.performance, 'load', { enumerable: true, get() { reads++; return known(); } });
  assert.throws(() => captureSourceSetDraft(getter), invalid); assert.equal(reads, 0);
  assert.throws(() => decodePerformedSet({ ...saved(draft()), performance: getter.performance }), badReceipt); assert.equal(reads, 0);
  const resources = createSourceTrainingResources(async () => { requests++; return {}; }, () => {});
  const malformed = [draft(null), draft({ ...known(), basis: 'unspecified' }), draft({ ...unknown, confirmed: false }),
    draft({ state: 'notApplicable', reason: 'unspecified' }), draft({ ...known(), extra: true }),
    ...[-1, 501, Infinity, -Infinity, NaN, '1'].map(value => draft(known(value))), draft(known(1200, 'lb')),
    { ...draft(), schema: 'form.source-performed-set/v1' }, { ...draft(), performance: draft(unknown, 1).performance }];
  for (const value of malformed) await assert.rejects(resources.addSet(session, value, 'key'), invalid);
  assert.equal(requests, 0);
  const zero = draft(); zero.performance.reps = 0;
  assert.throws(() => captureSourceSetDraft(zero), invalid);
  assert.equal(captureSourceSetDraft({ ...zero, status: 'draft' }).performance.reps, 0);
});

test('retained capture resends identical complete v2 load after uncertain acknowledgement', async () => {
  const sends = []; let attempts = 0;
  const source = createSourceTrainingResources(async (_path, _method, body, key) => {
    sends.push({ body: JSON.stringify(body), key });
    if (++attempts === 1) throw new Error('synthetic lost acknowledgement');
    return { set: saved(captured), sessionRevision: 2 };
  }, () => {});
  const original = draft(known(0, 'lb', 'assistance')), captured = captureSourceSetDraft(original);
  await assert.rejects(source.addSet(session, captured, 'original-key'));
  original.performance.load.value = 99; original.performance.load.unit = 'kg'; original.performance.load.basis = 'total';
  await source.addSet(session, captured, 'original-key');
  assert.deepEqual(sends[1], sends[0]);
  assert.deepEqual(JSON.parse(sends[1].body).performance.load, known(0, 'lb', 'assistance'));
});

test('authoritative receipt equality includes value, unit, basis, state and non-applicability reason', async () => {
  for (const changed of [known(13), known(12, 'lb'), known(12, 'kg', 'perImplement'), known(12, 'kg', 'perSide'),
    known(12, 'kg', 'assistance'), unknown, { state: 'notApplicable', reason: 'bodyweight' }]) {
    const source = createSourceTrainingResources(async () => ({ set: saved(draft(changed)), sessionRevision: 2 }), () => {});
    await assert.rejects(source.addSet(session, draft(), 'key'), badReceipt);
  }
  const source = createSourceTrainingResources(async () => ({ set: saved(draft({ state: 'notApplicable', reason: 'unloaded' })), sessionRevision: 2 }), () => {});
  await assert.rejects(source.addSet(session, draft({ state: 'notApplicable', reason: 'bodyweight' }), 'key'), badReceipt);
});

test('v1 correction to v2, explicit clearing and version-preserving void use the existing ports', async () => {
  const v1 = draft({ kind: 'unspecified', basis: 'unknown' }, 1), calls = [];
  const source = createSourceTrainingResources(async (path, method, body, key) => {
    calls.push({ path, method, body, key });
    const next = path.endsWith('/void') ? { ...saved(draft(unknown), 4), status: 'voided' }
      : saved({ ...draft(), schema: body.schema, status: body.status, performance: body.performance }, body.expectedRevision + 1);
    return { set: next, sessionRevision: 5 };
  }, () => {});
  const edit = { schema: 'form.source-performed-set/v2', status: 'confirmed', performance: draft().performance };
  const corrected = await source.editSet('session', saved(v1), edit, 'correction');
  assert.equal(corrected.set.schema, 'form.source-performed-set/v2');
  const clearing = { ...edit, performance: { schema: 'form.source-performance/v2', kind: 'repetitions', reps: 8 } };
  assert.deepEqual(captureSourceSetChanges(clearing).performance.load, unknown);
  const cleared = await source.editSet('session', corrected.set, clearing, 'clearing');
  assert.deepEqual(cleared.set.performance.load, unknown);
  const voided = await source.voidSet('session', cleared.set, 'void');
  assert.equal(voided.set.status, 'voided'); assert.deepEqual(voided.set.performance, cleared.set.performance);
  const count = calls.length;
  await assert.rejects(source.editSet('session', corrected.set, { schema: v1.schema, status: v1.status, performance: v1.performance }, 'downgrade'), invalid);
  assert.equal(calls.length, count);
});

test('late response cannot cross the existing current-owner fence', async () => {
  let current = true;
  const source = createSourceTrainingResources(async () => { current = false; return { set: saved(draft()), sessionRevision: 2 }; }, () => {
    if (!current) throw new Error('synthetic stale account');
  });
  await assert.rejects(source.addSet(session, draft(), 'key'), /stale account/);
});


test('shared APP create/patch/saved/draft/change types retain paired versions', () => {
  const virtual = path.join(__dirname, 'source-reported-load-types.virtual.ts');
  const content = `
    import type { SourceSetCreate, SourceSetPatch, SourcePerformedSet, SourcePerformanceV1, SourcePerformanceV2 } from '../domain';
    import type { SourceSetDraft, SourceSetChanges } from '../sourceTrainingResources';
    type AssertTrue<T extends true> = T;
    type Pair<S extends string, P> = { schema: S; performance: P; status: 'confirmed'; expectedRevision: 1 };
    type WrongV1 = Pair<'form.source-performed-set/v1', SourcePerformanceV2>;
    type WrongV2 = Pair<'form.source-performed-set/v2', SourcePerformanceV1>;
    type Identity = { occurrenceId: 'occurrence'; setNumber: 1 };
    type SavedIdentity = Identity & { id: 'set'; revision: 1; createdAt: string; updatedAt: string };
    type RejectPatchV1 = AssertTrue<WrongV1 extends SourceSetPatch ? false : true>;
    type RejectPatchV2 = AssertTrue<WrongV2 extends SourceSetPatch ? false : true>;
    type RejectCreateV1 = AssertTrue<(WrongV1 & Identity) extends SourceSetCreate ? false : true>;
    type RejectCreateV2 = AssertTrue<(WrongV2 & Identity) extends SourceSetCreate ? false : true>;
    type RejectSavedV1 = AssertTrue<(Omit<WrongV1, 'expectedRevision'> & SavedIdentity) extends SourcePerformedSet ? false : true>;
    type RejectSavedV2 = AssertTrue<(Omit<WrongV2, 'expectedRevision'> & SavedIdentity) extends SourcePerformedSet ? false : true>;
    type RejectDraftV1 = AssertTrue<Omit<WrongV1 & Identity, 'expectedRevision'> extends SourceSetDraft ? false : true>;
    type RejectDraftV2 = AssertTrue<Omit<WrongV2 & Identity, 'expectedRevision'> extends SourceSetDraft ? false : true>;
    type RejectChangesV1 = AssertTrue<Omit<WrongV1, 'expectedRevision'> extends SourceSetChanges ? false : true>;
    type RejectChangesV2 = AssertTrue<Omit<WrongV2, 'expectedRevision'> extends SourceSetChanges ? false : true>;
    type AcceptCreate = AssertTrue<(Pair<'form.source-performed-set/v2', SourcePerformanceV2> & Identity) extends SourceSetCreate ? true : false>;
    type AcceptDraft = AssertTrue<Omit<Pair<'form.source-performed-set/v1', SourcePerformanceV1> & Identity, 'expectedRevision'> extends SourceSetDraft ? true : false>;
  `;
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, skipLibCheck: true, noEmit: true, types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'] };
  const host = ts.createCompilerHost(options), originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => file === virtual
    ? ts.createSourceFile(file, content, languageVersion, true)
    : originalGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([virtual], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});
