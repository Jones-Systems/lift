// Current server resources only: missing legacy preference fields fail closed.
// These parsers confer no save, authentication, migration or runtime authority.
const MAX = Number.MAX_SAFE_INTEGER;
const fail = () => { throw new Error('invalid_resource'); };
const check = condition => { if (!condition) fail(); };
const record = value => check(value !== null && typeof value === 'object' && !Array.isArray(value));
const shape = (value, fields) => {
  record(value);
  const keys = Object.keys(value);
  check(keys.length === fields.length && fields.every(key => Object.hasOwn(value, key)));
};
const number = (value, min, max, integer = false) =>
  check(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isSafeInteger(value)));
const revision = value => number(value, 0, MAX, true);
const text = (value, max) => check(typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value);
const id = value => { text(value, 80); check(/^[a-zA-Z0-9_-]+$/.test(value)); };
const bool = value => check(typeof value === 'boolean');
const choice = (value, values) => check(values.includes(value));
const list = (value, min, max, validate) => {
  check(Array.isArray(value) && value.length >= min && value.length <= max);
  value.forEach(validate);
};
const unique = (values, key = value => value.id) => check(new Set(values.map(key)).size === values.length);
const timestamp = value => {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value));
  check(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
};
const dates = value => { timestamp(value.createdAt); timestamp(value.updatedAt); check(value.createdAt <= value.updatedAt); };

// Defensive consumer ceilings, not server quotas: lists 1,000, sets 5,000,
// JSON depth 12 / 300,000 nodes / 4,194,304 UTF-16 code units across one resource.
// Copy only plain data descriptors; getters, cycles and dangerous keys never enter output.
function detached(value) {
  let nodes = 0, characters = 0;
  const ancestors = new Set();
  function copy(input, depth) {
    check(++nodes <= 300000 && depth <= 12);
    if (typeof input === 'string') {
      characters += input.length;
      check(input.length <= 4000 && characters <= 4 * 1024 * 1024);
      return input;
    }
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') { check(Number.isFinite(input)); return input; }
    check(typeof input === 'object' && !ancestors.has(input));
    const array = Array.isArray(input);
    check(Object.getPrototypeOf(input) === (array ? Array.prototype : Object.prototype) || (!array && Object.getPrototypeOf(input) === null));
    const keys = Reflect.ownKeys(input);
    check(keys.length <= (array ? 5001 : 100));
    ancestors.add(input);
    let output;
    if (array) {
      check(input.length <= 5000 && keys.length === input.length + 1);
      output = [];
      for (let index = 0; index < input.length; index++) {
        const field = Object.getOwnPropertyDescriptor(input, String(index));
        check(field && Object.hasOwn(field, 'value') && field.enumerable);
        output.push(copy(field.value, depth + 1));
      }
    } else {
      output = {};
      for (const key of keys) {
        check(typeof key === 'string' && key.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(key));
        characters += key.length;
        check(characters <= 4 * 1024 * 1024);
        const field = Object.getOwnPropertyDescriptor(input, key);
        check(field && Object.hasOwn(field, 'value') && field.enumerable);
        output[key] = copy(field.value, depth + 1);
      }
    }
    ancestors.delete(input);
    return Object.freeze(output);
  }
  return copy(value, 0);
}
function parse(value, code, validate) {
  try { const output = detached(value); validate(output); return output; }
  catch { throw new Error(code); }
}
function profile(value) {
  shape(value, ['revision', 'name', 'age', 'heightCm', 'weightKg', 'trainingBackground', 'injuryHistory', 'goals',
    ...(Object.hasOwn(value, 'trainingContext') ? ['trainingContext'] : [])]);
  revision(value.revision);
  // Provisioned names and stored context are read as facts, not normalized like PATCH input.
  const storedText = (input, max, nonblank = false) => check(typeof input === 'string' && input.length <= max && (!nonblank || input.trim().length > 0));
  storedText(value.name, 100, true);
  if (value.age !== null) number(value.age, 13, 120, true);
  if (value.heightCm !== null) number(value.heightCm, 50, 260);
  if (value.weightKg !== null) number(value.weightKg, 15, 500);
  if (value.trainingBackground !== null) choice(value.trainingBackground, ['new', 'returning', 'regular']);
  storedText(value.injuryHistory, 4000);
  if (Object.hasOwn(value, 'trainingContext')) storedText(value.trainingContext, 4000);
  list(value.goals, 0, 30, entry => storedText(entry, 200, true));
}
function preferences(value) {
  shape(value, ['revision', 'appMode', 'mascot', 'animationStyle', 'loadUnit', 'heightUnit', 'coachVoice', 'communication', 'trainingDaysPerWeek', 'sessionMinutes', 'equipment', 'remindersEnabled']);
  revision(value.revision);
  choice(value.appMode, ['basic', 'advanced']);
  choice(value.mascot, ['scholarly', 'baby', 'buff', 'none']);
  choice(value.animationStyle, ['short', 'long']);
  choice(value.loadUnit, ['kg', 'lb']); choice(value.heightUnit, ['cm', 'ft-in']);
  choice(value.coachVoice, ['calm', 'direct', 'encouraging']); choice(value.communication, ['concise', 'detailed']);
  number(value.trainingDaysPerWeek, 1, 7, true); number(value.sessionMinutes, 5, 180, true);
  list(value.equipment, 0, 30, entry => text(entry, 200)); bool(value.remindersEnabled);
}
const itemFields = ['id', 'exerciseId', 'setTarget', 'repMin', 'repMax', 'targetKg'];
function item(value) {
  shape(value, itemFields); id(value.id); id(value.exerciseId);
  number(value.setTarget, 1, 20, true); number(value.repMin, 1, 100, true); number(value.repMax, value.repMin, 100, true);
  number(value.targetKg, 0, 500);
}
function plan(value) {
  shape(value, ['id', 'revision', 'name', 'minutes', 'items', 'archived', 'createdAt', 'updatedAt']);
  id(value.id); revision(value.revision); check(value.revision >= 1);
  text(value.name, 100); number(value.minutes, 5, 180, true);
  list(value.items, 1, 50, item); unique(value.items); bool(value.archived); dates(value);
}
function performedSet(value) {
  shape(value, ['id', 'occurrenceId', 'setNumber', 'revision', 'reps', 'weightKg', 'status', 'createdAt', 'updatedAt']);
  id(value.id); id(value.occurrenceId); revision(value.revision); check(value.revision >= 1);
  number(value.setNumber, 1, 100, true); choice(value.status, ['draft', 'confirmed', 'voided']);
  number(value.reps, value.status === 'confirmed' ? 1 : 0, 100, true); number(value.weightKg, 0, 500); dates(value);
}
function session(value) {
  shape(value, ['id', 'planId', 'planRevision', 'revision', 'status', 'planSnapshot', 'occurrences', 'sets', 'startedAt', 'completedAt']);
  id(value.id); id(value.planId); revision(value.planRevision); revision(value.revision);
  check(value.planRevision >= 1 && value.revision >= 1); choice(value.status, ['active', 'completed']);
  // Domain.startSession stores the full plan, including identity and revision.
  plan(value.planSnapshot);
  check(value.planSnapshot.id === value.planId && value.planSnapshot.revision === value.planRevision && !value.planSnapshot.archived);
  timestamp(value.startedAt); check(value.planSnapshot.updatedAt <= value.startedAt);
  if (value.status === 'active') check(value.completedAt === null);
  else { timestamp(value.completedAt); check(value.completedAt >= value.startedAt && value.revision >= 2); }
  list(value.occurrences, value.planSnapshot.items.length, value.planSnapshot.items.length, (occurrence, position) => {
    shape(occurrence, ['id', 'itemId', 'exerciseId', 'position', 'target']);
    id(occurrence.id); id(occurrence.itemId); id(occurrence.exerciseId); number(occurrence.position, 0, 49, true);
    check(occurrence.position === position); item(occurrence.target);
    const original = value.planSnapshot.items[position];
    check(occurrence.itemId === original.id && occurrence.exerciseId === original.exerciseId);
    check(itemFields.every(field => occurrence.target[field] === original[field]));
  });
  unique(value.occurrences);
  const members = new Set(value.occurrences.map(occurrence => occurrence.id));
  list(value.sets, 0, 5000, set => {
    performedSet(set); check(members.has(set.occurrenceId));
    check(set.createdAt >= value.startedAt && set.revision < value.revision);
  });
  unique(value.sets); unique(value.sets, set => `${set.occurrenceId}:${set.setNumber}`);
  // Every creation/edit/void advances the session, independently of plan targets.
  check(value.sets.reduce((sum, set) => sum + set.revision, 1) + (value.status === 'completed' ? 1 : 0) === value.revision);
}
function history(value) {
  shape(value, ['items', 'nextBefore']); list(value.items, 0, 50, session); unique(value.items);
  if (value.nextBefore !== null) {
    text(value.nextBefore, 256); check(/^[A-Za-z0-9_-]+$/.test(value.nextBefore) && value.items.length > 0);
  }
  for (let index = 1; index < value.items.length; index++) {
    const before = value.items[index - 1], after = value.items[index];
    check(before.startedAt > after.startedAt || (before.startedAt === after.startedAt && before.id > after.id));
  }
}
const near = (left, right, operations = 16) => Math.abs(left - right) <= Number.EPSILON * operations * Math.max(1, Math.abs(left), Math.abs(right));
function totals(value) {
  number(value.confirmedSets, 0, MAX, true); number(value.repetitions, 0, MAX, true); number(value.volumeKg, 0, MAX);
  check(value.repetitions >= value.confirmedSets && value.repetitions <= value.confirmedSets * 100);
  check(value.volumeKg <= value.repetitions * 500 || near(value.volumeKg, value.repetitions * 500));
  if (value.confirmedSets === 0) check(value.repetitions === 0 && value.volumeKg === 0);
}
function stats(value) {
  shape(value, ['confirmedSets', 'repetitions', 'volumeKg', 'completedSessions', 'byExercise', 'units', 'includesActiveConfirmedSets']);
  totals(value); number(value.completedSessions, 0, MAX, true);
  shape(value.units, ['load', 'volume']); check(value.units.load === 'kg' && value.units.volume === 'kg-repetitions');
  check(value.includesActiveConfirmedSets === true);
  list(value.byExercise, 0, 1000, entry => {
    shape(entry, ['exerciseId', 'confirmedSets', 'repetitions', 'volumeKg', 'maxWeightKg']); id(entry.exerciseId); totals(entry);
    check(entry.confirmedSets > 0); number(entry.maxWeightKg, 0, 500);
    check(entry.volumeKg >= entry.maxWeightKg || near(entry.volumeKg, entry.maxWeightKg));
    check(entry.volumeKg <= entry.repetitions * entry.maxWeightKg || near(entry.volumeKg, entry.repetitions * entry.maxWeightKg));
  });
  unique(value.byExercise, entry => entry.exerciseId);
  const sum = field => value.byExercise.reduce((total, entry) => total + entry[field], 0);
  // SQL total and grouped sums may accumulate fractional kg in different orders.
  check(sum('confirmedSets') === value.confirmedSets && sum('repetitions') === value.repetitions && near(sum('volumeKg'), value.volumeKg, Math.max(16, value.byExercise.length * 4)));
}
function exercise(value) {
  shape(value, ['id', 'name', 'loadLabel', 'retired', 'provenance', 'requiredConstraints', 'cues']);
  id(value.id); text(value.name, 200); text(value.loadLabel, 200); bool(value.retired); record(value.provenance);
  const cue = entry => {
    shape(entry, ['id', 'text', 'required']); id(entry.id); text(entry.text, 4000); bool(entry.required);
  };
  list(value.requiredConstraints, 0, 20, entry => { cue(entry); check(entry.required === true); });
  list(value.cues, 0, 20, cue); unique([...value.requiredConstraints, ...value.cues]);
}
export const parseProfile = value => parse(value, 'invalid_profile', profile);
export const parsePreferences = value => parse(value, 'invalid_preferences', preferences);
export const parsePlan = value => parse(value, 'invalid_plan', plan);
export const parsePlans = value => parse(value, 'invalid_plans', output => {
  shape(output, ['items']); list(output.items, 0, 1000, plan); unique(output.items);
});
export const parseSet = value => parse(value, 'invalid_set', performedSet);
export const parseSession = value => parse(value, 'invalid_session', session);
export const parseHistory = value => parse(value, 'invalid_history', history);
export const parseStats = value => parse(value, 'invalid_stats', stats);
export const parseExercises = value => parse(value, 'invalid_exercises', output => {
  shape(output, ['items']); list(output.items, 0, 1000, exercise); unique(output.items);
});
