import { definitions, ERROR_MESSAGES, project } from './schemas.mjs';
import { identitySnapshot } from './identity.mjs';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
freeze(definitions);
export const toolDescriptors = freeze(definitions.map(item => item.descriptor));
const byName = new Map(definitions.map(item => [item.descriptor.name, item]));

function result(body) {
  return {
    isError: !body.ok,
    content: [{ type: 'text', text: body.ok ? 'Form read completed.' : body.error.message }],
    structuredContent: body,
  };
}
const failure = code => result({ ok: false, error: { code, message: ERROR_MESSAGES[code] } });

function owned(value, identity) {
  if (!value || value.accountId !== identity.accountId) throw new Error('ownership');
}

function validDate(value) {
  if (value !== null && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) {
    throw new Error('date');
  }
}
function validateWorkout(value) {
  validDate(value.startedAt);
  validDate(value.completedAt);
  if ((value.status === 'completed') !== (value.completedAt !== null) ||
      (value.completedAt && value.completedAt < value.startedAt)) throw new Error('status');
}
function uniqueIds(values) {
  if (new Set(values.map(value => value.id)).size !== values.length) throw new Error('duplicate');
}
function validatePlanItems(items) {
  uniqueIds(items);
  if (!items.length || items.some(item => item.repMax < item.repMin)) throw new Error('targets');
}

/**
 * Trusted runtime injection only: see docs/chatgpt-experience/engineering-spec.md.
 * verifyIdentity must validate the server-owned request context on every call.
 * Ports must enforce active account/subject authorization at the data read.
 */
export function createFormAdapter({ verifyIdentity, ports = {}, now = Date.now } = {}) {
  const { listWorkouts, getWorkout, listPlans, getPlan } = ports;
  const configured = fn => typeof fn === 'function';

  async function dispatch(name, input, requestContext) {
    const definition = byName.get(name);
    if (!definition) return failure('unknown_tool');
    let args;
    try { args = project(definition.descriptor.inputSchema, input, true); }
    catch { return failure('invalid_input'); }
    if (!configured(verifyIdentity)) return failure('unavailable');
    let identity;
    try { identity = identitySnapshot(await verifyIdentity(requestContext), now()); }
    catch { return failure('authentication_required'); }
    if (definition.scope && !identity.scopes.includes(definition.scope)) return failure('permission_denied');

    let raw;
    const limit = args.limit ?? 10;
    try {
      switch (name) {
        case 'form_capabilities': {
          const workouts = identity.scopes.includes('form:workouts:read');
          const plans = identity.scopes.includes('form:plans:read');
          raw = {
            listWorkouts: workouts && configured(listWorkouts), getWorkout: workouts && configured(getWorkout),
            listPlans: plans && configured(listPlans), getPlan: plans && configured(getPlan),
            workoutGeneration: false, writes: false,
          };
          break;
        }
        case 'form_list_workouts':
          if (!configured(listWorkouts)) return failure('unavailable');
          raw = await listWorkouts({ identity, limit, ...(args.before ? { before: args.before } : {}) });
          break;
        case 'form_get_workout':
          if (!configured(getWorkout)) return failure('unavailable');
          raw = await getWorkout({ identity, workoutId: args.workoutId });
          break;
        case 'form_list_plans':
          if (!configured(listPlans)) return failure('unavailable');
          raw = await listPlans({ identity, limit });
          break;
        case 'form_get_plan':
          if (!configured(getPlan)) return failure('unavailable');
          raw = await getPlan({ identity, planId: args.planId });
          break;
      }
    } catch { return failure('unavailable'); }
    try { identitySnapshot(identity, now()); }
    catch { return failure('authentication_required'); }
    if (raw === null && (name === 'form_get_workout' || name === 'form_get_plan')) return failure('not_found');
    try {
      if (name !== 'form_capabilities') {
        owned(raw, identity);
        if (name === 'form_list_workouts' || name === 'form_list_plans') {
          if (!Array.isArray(raw.items) || raw.items.length > limit) throw new Error('bounds');
          raw.items.forEach(item => owned(item, identity));
        }
      }
      const data = project(definition.dataSchema, raw);
      switch (name) {
        case 'form_list_workouts':
          uniqueIds(data.items);
          data.items.forEach(validateWorkout);
          if (data.nextBefore !== null && (!data.items.length || data.nextBefore === args.before)) throw new Error('cursor');
          break;
        case 'form_get_workout': {
          if (data.id !== args.workoutId) throw new Error('identity');
          validateWorkout(data);
          uniqueIds(data.occurrences);
          uniqueIds(data.sets);
          for (const occurrence of data.occurrences) {
            if (occurrence.target.id !== occurrence.itemId || occurrence.target.exerciseId !== occurrence.exerciseId ||
                occurrence.target.repMax < occurrence.target.repMin) throw new Error('target');
          }
          const occurrenceIds = new Set(data.occurrences.map(item => item.id));
          if (data.sets.some(set => !occurrenceIds.has(set.occurrenceId) ||
              (set.status === 'confirmed' && set.reps < 1))) throw new Error('sets');
          break;
        }
        case 'form_list_plans': uniqueIds(data.items); break;
        case 'form_get_plan':
          if (data.id !== args.planId) throw new Error('identity');
          validatePlanItems(data.items);
          break;
      }
      return result({ ok: true, data });
    } catch { return failure('invalid_result'); }
  }

  return Object.freeze({ descriptors: toolDescriptors, dispatch });
}
