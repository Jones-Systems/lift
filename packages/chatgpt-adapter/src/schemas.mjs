const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const boolean = { type: 'boolean' };
const id = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9_-]+(?![\\s\\S])' };
const cursor = { type: 'string', minLength: 1, maxLength: 512, pattern: '^[a-zA-Z0-9_-]+(?![\\s\\S])' };
const timestamp = { type: 'string', minLength: 24, maxLength: 24, pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$' };
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const revision = integer(0, Number.MAX_SAFE_INTEGER);
const planItem = object({
  id, exerciseId: id, setTarget: integer(1, 20), repMin: integer(1, 100),
  repMax: integer(1, 100), targetKg: number(0, 500),
});
const planSummary = object({
  id, name: { type: 'string', minLength: 1, maxLength: 100 },
  minutes: integer(5, 180), revision, archived: boolean,
});
const plan = object({ ...planSummary.properties, items: array(planItem, 50) });
const workoutSummary = object({
  id, planId: id, planRevision: revision, revision,
  status: { type: 'string', enum: ['active', 'completed'] },
  startedAt: timestamp, completedAt: nullable(timestamp),
});
const workout = object({
  ...workoutSummary.properties,
  occurrences: array(object({
    id, itemId: id, exerciseId: id, position: integer(0, 49), target: planItem,
  }), 50),
  sets: array(object({
    id, occurrenceId: id, setNumber: integer(1, 100), reps: integer(0, 100),
    weightKg: number(0, 500), status: { type: 'string', enum: ['draft', 'confirmed', 'voided'] },
  }), 200),
});

export const ERROR_MESSAGES = Object.freeze({
  unknown_tool: 'This Form tool is not available.',
  invalid_input: 'The tool arguments do not match the bounded input schema.',
  authentication_required: 'A current verified Form identity is required.',
  permission_denied: 'The verified identity does not allow this Form read.',
  unavailable: 'This Form read is unavailable.',
  not_found: 'The requested Form record was not found.',
  invalid_result: 'Form could not safely return this result.',
});

const error = object({
  code: { type: 'string', enum: Object.keys(ERROR_MESSAGES) },
  message: { type: 'string', maxLength: 100 },
});
const output = data => ({
  type: 'object',
  oneOf: [object({ ok: { const: true }, data }), object({ ok: { const: false }, error })],
});
const definition = (name, title, description, inputSchema, dataSchema, scope = null) => ({
  descriptor: {
    name, title, description, inputSchema, outputSchema: output(dataSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  dataSchema, scope,
});

export const definitions = [
  definition('form_capabilities', 'Form read capabilities',
    'Check which Form read tools are wired for the verified account. Does not grant access or generate workouts.',
    object({}), object({
      listWorkouts: boolean, getWorkout: boolean, listPlans: boolean, getPlan: boolean,
      workoutGeneration: { const: false }, writes: { const: false },
    })),
  definition('form_list_workouts', 'List Form workouts',
    'Read a bounded page of the verified account’s recorded workout sessions. This does not create a workout.',
    object({ limit: integer(1, 20), before: cursor }, []),
    object({ items: array(workoutSummary, 20), nextBefore: nullable(cursor) }), 'form:workouts:read'),
  definition('form_get_workout', 'Read a Form workout',
    'Read one recorded workout and its saved exercise targets and sets. Oversized records are unavailable; data is never silently truncated.',
    object({ workoutId: id }), workout, 'form:workouts:read'),
  definition('form_list_plans', 'List Form saved plans',
    'Read up to 20 saved plans from the verified account. hasMore reports omitted plans; this tool has no continuation input.',
    object({ limit: integer(1, 20) }, []),
    object({ items: array(planSummary, 20), hasMore: boolean }), 'form:plans:read'),
  definition('form_get_plan', 'Read a Form saved plan',
    'Read a saved plan and its exercise targets for the verified account. This does not generate or modify a plan.',
    object({ planId: id }), plan, 'form:plans:read'),
];

export function project(schema, value, strict = false) {
  if (schema.anyOf || schema.oneOf) {
    for (const candidate of schema.anyOf ?? schema.oneOf) {
      try { return project(candidate, value, strict); } catch {}
    }
    throw new Error('invalid');
  }
  if ('const' in schema) {
    if (value !== schema.const) throw new Error('invalid');
    return value;
  }
  if (schema.type === 'null') {
    if (value !== null) throw new Error('invalid');
  } else if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('invalid');
    if (strict && Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) throw new Error('invalid');
    const result = {};
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key)) {
        if (schema.required.includes(key)) throw new Error('invalid');
      } else result[key] = project(child, value[key], strict);
    }
    return result;
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems) throw new Error('invalid');
    return Array.from(value, item => project(schema.items, item, strict));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) ||
        value.length > (schema.maxLength ?? Infinity) ||
        (schema.pattern && !(new RegExp(schema.pattern)).test(value))) throw new Error('invalid');
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value)) ||
        value < schema.minimum || value > schema.maximum) throw new Error('invalid');
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error('invalid');
  } else throw new Error('invalid');
  if (schema.enum && !schema.enum.includes(value)) throw new Error('invalid');
  return value;
}
