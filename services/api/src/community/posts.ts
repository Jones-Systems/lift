import { DAY_MS } from './governance.js';
export const postExpiry = (createdAt: string, published: boolean): string => new Date(Date.parse(createdAt) + (published ? 30 : 7) * DAY_MS).toISOString();
export const templates = Object.freeze({ checking_in: 'Checking in', at_my_pace: 'Taking it at my pace' });
export function postReadable(input: { state: string; expiresAt: string; createdAt: string; now: string; author: boolean; viewerJoinedAt: string; blocked: boolean }): boolean {
 return !input.blocked && input.expiresAt > input.now && (input.author || (input.state === 'published' && input.createdAt >= input.viewerJoinedAt));
}
