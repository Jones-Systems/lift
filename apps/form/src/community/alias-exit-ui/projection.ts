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
    community_text_moderation_unavailable: 'Alias review is unavailable. Refresh before trying a new change.',
    stale_revision: 'The group or membership changed. Refresh and review before trying again.',
    community_membership_changed: 'Your membership changed. Refresh and review your current membership.',
    community_membership_reload_required: 'Refresh and review the current membership before continuing.',
    community_owner_must_close: 'The group owner cannot leave this group.',
    community_forbidden: 'This action is not permitted for your current membership.',
    community_not_found: 'This group is unavailable.',
    community_adult_eligibility_unavailable: 'Community eligibility could not be confirmed.',
    community_rate_limited: 'This action is rate limited. A new change is unavailable right now.',
    community_limiter_unavailable: 'This action is unavailable right now.',
    community_unavailable: 'Community is unavailable right now.',
    community_governed_action_required: 'This action requires a different group process.',
  };
  return { kind: 'error', text: messages[code ?? ''] ?? 'The change was not confirmed. Refresh and review before a new change.' };
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
