import type { CommunityGroupSnapshot, CommunityGroupCommandState, CommunityViewError } from '../../api/community';
import type { AliasExitMode, AliasExitNotice } from './contracts';

export function unresolvedCommand(command: CommunityGroupCommandState): boolean {
  return command.status === 'pending' || command.intent?.state === 'pending' || command.intent?.state === 'unknown' ||
    command.status === 'error' && !!(command.error?.effectUnknown || command.error?.originalEffectUnknown);
}

export function matchingCommand(command: CommunityGroupCommandState, groupId: string, mode: AliasExitMode): boolean {
  if (!command.key || command.groupId !== groupId || command.kind !== mode) return false;
  const path = mode === 'alias' ? `/groups/${groupId}/me` : `/groups/${groupId}/${mode}`;
  return !command.intent || command.intent.key === command.key && command.intent.path === path &&
    command.intent.method === (mode === 'alias' ? 'PATCH' : 'POST');
}

export function currentDetail(snapshot: CommunityGroupSnapshot, groupId: string) {
  const detail = snapshot.detail;
  return detail.status === 'ready' && detail.groupId === groupId && detail.data.id === groupId ? detail.data : null;
}

export function aliasValidation(value: string): string | null {
  const alias = value.trim();
  if (!alias.length) return 'Enter an alias.';
  if (alias.length > 60) return 'Use 60 characters or fewer.';
  if (/[\u0000-\u001f\u007f<>]/u.test(alias)) return 'Remove control characters and angle brackets.';
  return null;
}

export function semanticNotice(error: CommunityViewError | null): AliasExitNotice {
  const code = error?.code;
  const messages: Record<string, string> = {
    community_text_rejected: 'This alias cannot be used in Form groups. Rephrase it and try again.',
    community_text_moderation_unavailable: 'Alias review was unavailable for the previous change.',
    stale_revision: 'The previous change was rejected because the group or membership changed.',
    community_membership_changed: 'The previous change was rejected because your membership changed.',
    community_membership_reload_required: 'The previous change required current membership details.',
    community_owner_must_close: 'The group owner cannot leave this group.',
    community_forbidden: 'The previous change was not permitted for that membership.',
    community_not_found: 'The group was unavailable for the previous change.',
    community_adult_eligibility_unavailable: 'Community eligibility could not be confirmed.',
    community_rate_limited: 'The previous change was rate limited.',
    community_limiter_unavailable: 'The previous change was unavailable.',
    community_unavailable: 'Community was unavailable for the previous change.',
    community_governed_action_required: 'The previous change required a different group process.',
  };
  return { kind: 'error', text: messages[code ?? ''] ?? 'The previous change was not confirmed.' };
}

export function confirmedReceipt(command: CommunityGroupCommandState, groupId: string, mode: AliasExitMode): string | null {
  if (command.status !== 'confirmed' || !matchingCommand(command, groupId, mode)) return null;
  const result = command.membershipResult;
  if (mode === 'alias' && result?.kind === 'alias' && result.value.memberId === command.memberId)
    return `Alias saved: ${result.value.alias}`;
  if (mode === 'leave' && result?.kind === 'leave' && result.value.left === true) return 'You left the group.';
  if (mode === 'close' && result?.kind === 'close' && result.value.closed === true) return 'The group is closed.';
  return null;
}
