import type { GroupProfileShare } from './extension-types.js';
export const privateProfile = (): GroupProfileShare => ({ revision: 0, flags: { age: false, sex: false, region: false, avatar: false, adherence: false, ranking: false }, sexDescription: null, region: null, avatar: null });
export function profileProjection(profile: GroupProfileShare): { sexDescription?: string; region?: string; avatar?: string } {
 return { ...(profile.flags.sex && profile.sexDescription ? { sexDescription: profile.sexDescription } : {}), ...(profile.flags.region && profile.region ? { region: profile.region } : {}), ...(profile.flags.avatar && profile.avatar ? { avatar: profile.avatar } : {}) };
}
