import { createHash } from 'node:crypto';
import { canonical, detach } from './strict-json.js';
export function same(a: unknown, b: unknown): boolean { return canonical(detach(a, 2 * 1024 * 1024, true)) === canonical(detach(b, 2 * 1024 * 1024, true)); }
export function hash(domain: 'blob' | 'evidence' | 'review' | 'intent' | 'snapshot', value: unknown): string {
  return createHash('sha256').update(`form.training.synthetic.${domain}/v1\0`).update(canonical(detach(value, 2 * 1024 * 1024, true))).digest('hex');
}
// Fake dependency generations are not source versions. Their content preimages retain the exact domain and semantic version.
export const dependencyDigest = (value: unknown) => hash('blob', value);
