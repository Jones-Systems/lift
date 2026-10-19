import { DomainError } from '../errors.js';
export const DAY_MS = 86400000;
export const requiredYes = (electorateSize: number): number => Math.max(3, Math.ceil(2 * electorateSize / 3));
export function motionOutcome(now: string, expiresAt: string, electorateSize: number, yes: number, activeElectors: number): 'open' | 'passed' | 'expired' {
 if (now < expiresAt) return 'open';
 return electorateSize >= 3 && activeElectors >= requiredYes(electorateSize) && yes >= requiredYes(electorateSize) ? 'passed' : 'expired';
}
export function reserveCapacity(capacity: number, active: number, reserved: number, requested: number): void {
 if (![capacity, active, reserved, requested].every(Number.isSafeInteger) || capacity < 4 || capacity > 20 || requested < 1 || active + reserved + requested > capacity) throw new DomainError(409, 'community_capacity_unavailable');
}
