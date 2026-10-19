import { definitions, project } from './schemas.mjs';

const schemas = new Map(definitions.map(({ descriptor, dataSchema }) => [descriptor.name, dataSchema]));
const id = value => typeof value === 'string' && value.length >= 1 && value.length <= 80 && !/[^a-zA-Z0-9_-]/.test(value);
const sync = value => {
  if (value && typeof value.then === 'function') throw new Error('Synchronous read required');
  return value;
};

/**
 * Trusted composition only. The resolver must read an existing subject mapping.
 * withActiveAccountRead must enforce that mapping and current lifecycle state
 * before and after one synchronous read, without provisioning an account.
 * These requirements are supplied by Form's owner; no database fallback exists.
 */
export function createDomainReadPorts({ domain, resolveAccount, withActiveAccountRead, plansPage, now = Date.now } = {}) {
  if (!domain || typeof resolveAccount !== 'function' || typeof withActiveAccountRead !== 'function') {
    return Object.freeze({});
  }
  const history = typeof domain.history === 'function' ? domain.history.bind(domain) : null;
  const session = typeof domain.session === 'function' ? domain.session.bind(domain) : null;
  const plan = typeof domain.plan === 'function' ? domain.plan.bind(domain) : null;

  function read(identity, scope, operation) {
    const current = () => {
      if (!identity || !id(identity.accountId) || !id(identity.subject) ||
          !Number.isSafeInteger(identity.expiresAtMs) || identity.expiresAtMs <= now() ||
          !Array.isArray(identity.scopes) || !identity.scopes.includes(scope)) throw new Error('Read denied');
    };
    current();
    let called = false;
    let answer;
    const guarded = sync(withActiveAccountRead({ accountId: identity.accountId, subject: identity.subject }, () => {
      if (called) throw new Error('Read already consumed');
      called = true;
      current();
      if (sync(resolveAccount(identity.subject)) !== identity.accountId) throw new Error('Read denied');
      answer = sync(operation(identity.accountId));
      current();
      return answer;
    }));
    if (!called || guarded !== answer) throw new Error('Read denied');
    current();
    return answer;
  }
  function limit(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 20) throw new Error('Invalid limit');
    return value;
  }
  function detail(method, tool, scope, identity, recordId) {
    if (!id(recordId)) throw new Error('Invalid ID');
    return read(identity, scope, accountId => {
      let value;
      try { value = method(accountId, recordId); }
      catch (error) {
        if (error?.status === 404 && error?.code === 'not_found') return null;
        throw error;
      }
      const data = project(schemas.get(tool), sync(value));
      if (data.id !== recordId) throw new Error('Record mismatch');
      return { ...data, accountId };
    });
  }
  const ports = {};
  if (history) ports.listWorkouts = ({ identity, limit: count, before }) => {
    limit(count);
    if (before !== undefined && (typeof before !== 'string' || before.length < 1 || before.length > 512 || /[^a-zA-Z0-9_-]/.test(before))) {
      throw new Error('Invalid cursor');
    }
    return read(identity, 'form:workouts:read', accountId => {
      const data = project(schemas.get('form_list_workouts'), sync(history(accountId, count, before)));
      if (data.items.length > count) throw new Error('Page overflow');
      return { ...data, accountId, items: data.items.map(item => ({ ...item, accountId })) };
    });
  };
  if (session) ports.getWorkout = ({ identity, workoutId }) =>
    detail(session, 'form_get_workout', 'form:workouts:read', identity, workoutId);
  if (plan) ports.getPlan = ({ identity, planId }) =>
    detail(plan, 'form_get_plan', 'form:plans:read', identity, planId);
  if (typeof plansPage === 'function') ports.listPlans = ({ identity, limit: count }) => {
    limit(count);
    return read(identity, 'form:plans:read', accountId => {
      const data = project(schemas.get('form_list_plans'), sync(plansPage(accountId, count)));
      if (data.items.length > count) throw new Error('Page overflow');
      return { ...data, accountId, items: data.items.map(item => ({ ...item, accountId })) };
    });
  };
  return Object.freeze(ports);
}
