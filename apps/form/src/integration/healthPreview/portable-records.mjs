function copy(value) {
  if (value instanceof Map) return new Map([...value].map(([k,v])=>[copy(k),copy(v)]));
  if (value instanceof Set) return new Set([...value].map(copy));
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,copy(v)]));
  return value;
}
const fail = code => { throw new Error(code); };
const rejected = code => ({status:'rejected', code});
const integer = (n, min=0) => Number.isSafeInteger(n) && n >= min;
const textId = s => typeof s === 'string' && s.length > 0 && s.length <= 2048;
const utc = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === (s.length === 20 ? s.replace('Z','.000Z') : s);
function closed(o, names) {
  if (!o || Object.getPrototypeOf(o) !== Object.prototype || Object.keys(o).sort().join('|') !== names.split(' ').sort().join('|')) fail('invalid_input');
}
function primitiveTree(o, depth=0) {
  if (depth > 16) fail('invalid_input');
  if (typeof o === 'number' && !Number.isFinite(o)) fail('invalid_input');
  if (typeof o === 'string' && o.length > 2048) fail('invalid_input');
  if (o === undefined || typeof o === 'function' || typeof o === 'symbol' || typeof o === 'bigint') fail('invalid_input');
  if (o && typeof o === 'object') {
    if (!Array.isArray(o) && Object.getPrototypeOf(o) !== Object.prototype) fail('invalid_input');
    for (const [key, value] of Object.entries(o)) {
      if (/body|no.?save|photo|proportion|fingerprint|token|credential|account/i.test(key) && key !== 'token') fail('no_save_forbidden');
      if (key === 'origin' && value === 'body_no_save') fail('no_save_forbidden');
      primitiveTree(value, depth+1);
    }
  }
}
function sorted(o) {
  if (Array.isArray(o)) return o.map(sorted);
  if (o && typeof o === 'object') return Object.fromEntries(Object.keys(o).sort().map(k => [k, sorted(o[k])]));
  return Object.is(o, -0) ? 0 : o;
}
// Sealing is equality evidence within this fixture codec, never authentication.
function seal(o) { return JSON.stringify(sorted(o)); }
function planValid(p) {
  primitiveTree(p); closed(p, 'revision id name minutes items archived createdAt updatedAt');
  if (!integer(p.revision) || !textId(p.id) || !textId(p.name) || !Number.isFinite(p.minutes) || p.minutes <= 0 || typeof p.archived !== 'boolean' || !utc(p.createdAt) || !utc(p.updatedAt) || !Array.isArray(p.items) || p.items.length === 0 || p.items.length > 100) fail('unsupported_plan');
  const seen = new Set();
  for (const i of p.items) {
    closed(i,'id exerciseId setTarget repMin repMax targetKg');
    if (!textId(i.id) || !textId(i.exerciseId) || seen.has(i.id) || !integer(i.setTarget,1) || !integer(i.repMin,1) || !integer(i.repMax,i.repMin) || !Number.isFinite(i.targetKg) || i.targetKg < 0) fail('unsupported_plan');
    seen.add(i.id);
  }
}
function commandValid(c,kind) {
    primitiveTree(c);closed(c,'schemaVersion key kind proposalId expectedProposalRevision expectedPlanRevision reviewedDigest applyReceiptId consent');
    if(c.schemaVersion!==1)fail('unsupported_version');
    if(!['apply','dismiss','undo'].includes(kind)||c.kind!==kind||![c.key,c.proposalId].every(textId)||!integer(c.expectedProposalRevision)||!(c.expectedPlanRevision===null||integer(c.expectedPlanRevision))||!(c.reviewedDigest===null||textId(c.reviewedDigest))||!(c.applyReceiptId===null||textId(c.applyReceiptId)))fail('invalid_input');
    if(c.consent!==({apply:'reviewed_apply',dismiss:'explicit_dismiss',undo:'explicit_undo'})[kind])fail('consent_required');
  }

export { copy, fail, rejected, integer, textId, utc, closed, primitiveTree, seal, planValid, commandValid };
