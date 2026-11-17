import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyStripeSignature(raw: Uint8Array, header: string, secrets: readonly string[], nowSeconds: number, tolerance = 300): boolean {
  if (!(raw instanceof Uint8Array) || raw.byteLength > 1_048_576 || !raw.byteLength || typeof header !== 'string' || header.length > 4096
    || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0 || !Number.isSafeInteger(tolerance) || tolerance < 1 || tolerance > 300
    || secrets.length < 1 || secrets.length > 3 || secrets.some(s => typeof s !== 'string' || s.length < 16 || s.length > 1024)) return false;
  const fields = header.split(',').map(x => x.trim().split('='));
  const times = fields.filter(x => x[0] === 't');
  if (times.length !== 1 || times[0]!.length !== 2 || !/^[0-9]{1,12}$/.test(times[0]![1]!)) return false;
  const timestamp = Number(times[0]![1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > tolerance) return false;
  const signatures = fields.filter(x => x[0] === 'v1' && x.length === 2 && /^[a-f0-9]{64}$/i.test(x[1]!));
  if (!signatures.length || signatures.length > 10) return false;
  let valid = 0;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(times[0]![1]! + '.').update(raw).digest();
    for (const signature of signatures) valid |= Number(timingSafeEqual(expected, Buffer.from(signature[1]!, 'hex')));
  }
  return valid !== 0;
}
