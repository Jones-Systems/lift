export class CatalogQualificationError extends Error {
  readonly code: 'invalid_artifact' | 'invalid_request' | 'invalid_policy' | 'stale_policy';

  constructor(code: CatalogQualificationError['code'], message: string) {
    super(message);
    this.name = 'CatalogQualificationError';
    this.code = code;
  }
}

export function requireValue(condition: unknown, code: CatalogQualificationError['code'], message: string): asserts condition {
  if (!condition) throw new CatalogQualificationError(code, message);
}

export function fields(value: unknown, keys: readonly string[], code: CatalogQualificationError['code']): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), code, 'expected object');
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null, code, 'expected plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(value);
  requireValue(actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key)), code, 'unexpected or missing fields');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    requireValue(descriptor && 'value' in descriptor && descriptor.enumerable, code, 'expected own data field');
    result[key] = descriptor.value;
  }
  return result;
}

export function textValue(value: unknown, code: CatalogQualificationError['code']): string {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value), code, 'expected nonempty exact text');
  return value;
}

export function dataArray(value: unknown, code: CatalogQualificationError['code'], max: number): unknown[] {
  requireValue(Array.isArray(value) && value.length <= max, code, 'expected bounded array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValue(Reflect.ownKeys(value).length === value.length + 1, code, 'expected dense array without extra fields');
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = descriptors[String(i)];
    requireValue(descriptor && 'value' in descriptor && descriptor.enumerable, code, 'expected array data item');
    result.push(descriptor.value);
  }
  return result;
}

export function identifiers(value: unknown, code: CatalogQualificationError['code'], max = 1000): string[] {
  const result = dataArray(value, code, max).map(item => textValue(item, code));
  requireValue(new Set(result).size === result.length, code, 'duplicate IDs');
  return result;
}

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
