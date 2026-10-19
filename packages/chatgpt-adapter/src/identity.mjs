const validId = value => typeof value === 'string' && value.length >= 1 && value.length <= 80 && !/[^a-zA-Z0-9_-]/.test(value);

export function identitySnapshot(value, now) {
  if (!value || !validId(value.accountId) || !validId(value.subject) ||
      !Number.isSafeInteger(now) || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= now ||
      !Array.isArray(value.scopes) || value.scopes.length > 20 ||
      value.scopes.some(scope => typeof scope !== 'string' || scope.length > 100)) throw new Error('identity');
  return Object.freeze({ accountId: value.accountId, subject: value.subject, expiresAtMs: value.expiresAtMs,
    scopes: Object.freeze([...value.scopes]) });
}
