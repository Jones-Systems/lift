import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, statfsSync, readSync } from 'node:fs';

export type PackagedFormFollowupProjection =
  | { readonly status: 'available'; readonly projectionBytes: Uint8Array }
  | { readonly status: 'unavailable' };

const digest = '8fcb4cd3ac9a1edf1140fb591b731e74172095a7b534d758fb5f8d30d027de10';
const byteLength = 80588;
const unavailable = Object.freeze({ status: 'unavailable' as const });

export async function readPackagedFormFollowupProjection(): Promise<PackagedFormFollowupProjection> {
  const descriptors: number[] = [];
  let result: PackagedFormFollowupProjection = unavailable;
  try {
    if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK) return unavailable;
    const target = new URL(`../../grounding/${digest}/projection.json`, import.meta.url);
    if (target.protocol !== 'file:' || target.hostname !== '') return unavailable;
    const parts = decodeURIComponent(target.pathname).split('/').filter(Boolean);
    if (parts.length + 1 > 64 || parts.some(part => part === '.' || part === '..')) return unavailable;
    // Native procfs is a trusted host primitive; privileged mount/namespace replacement is outside this boundary.
    if (!lstatSync('/proc').isDirectory() || statfsSync('/proc').type !== 0x9fa0) return unavailable;
    let parent = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptors.push(parent);
    // Walk held directories, not mutable absolute prefixes: O_NOFOLLOW protects each package component.
    for (const part of parts.slice(0, -1)) {
      parent = openSync(`/proc/self/fd/${parent}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      descriptors.push(parent);
    }
    const file = openSync(`/proc/self/fd/${parent}/${parts.at(-1)!}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    descriptors.push(file);
    const before = fstatSync(file, { bigint: true });
    if (!before.isFile() || before.size !== BigInt(byteLength)) return unavailable;
    const bytes = new Uint8Array(byteLength + 1);
    let count = 0;
    while (count < bytes.length) {
      const amount = readSync(file, bytes, count, bytes.length - count, count);
      if (amount === 0) break;
      count += amount;
    }
    const after = fstatSync(file, { bigint: true });
    if (count !== byteLength || !after.isFile() || after.size !== before.size
      || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return unavailable;
    const projectionBytes = bytes.subarray(0, byteLength);
    if (createHash('sha256').update(projectionBytes).digest('hex') !== digest) return unavailable;
    result = Object.freeze({ status: 'available', projectionBytes });
  } catch {
    result = unavailable;
  } finally {
    // No await occurs while handles are owned; handled JS failures close here, process exit closes kernel descriptors.
    for (const descriptor of descriptors.reverse()) {
      try { closeSync(descriptor); } catch { result = unavailable; }
    }
  }
  return result;
}
