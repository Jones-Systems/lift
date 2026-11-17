import type { CommunityPost, CommunityPostsCommandState, CommunityPostsSnapshot } from '../../api/community';
import type { CheckinsRow, CheckinsView } from './contracts';

export function unresolvedPostCommand(command: CommunityPostsCommandState): boolean {
  return command.status === 'pending' || command.intent?.state === 'pending' || command.intent?.state === 'unknown' ||
    command.status === 'error' && !!(command.error?.effectUnknown || command.error?.originalEffectUnknown);
}

function row(post: CommunityPost): CheckinsRow {
  const base = { id: post.id, state: post.state, alias: null, text: null, template: null, createdAt: null, expiresAt: null };
  if (post.state !== 'published') {
    const labels = { pending: 'Pending post', hidden: 'Hidden post', rejected: 'Rejected post' };
    const notices = { pending: 'This post is pending. Publication is not confirmed.',
      hidden: 'This post is hidden. Its content is not displayed.', rejected: 'This post was rejected. Its content is not displayed.' };
    return { ...base, label: labels[post.state], notice: notices[post.state] };
  }
  return { ...base, label: post.kind === 'check_in' ? 'Published check-in' : 'Published win', notice: null,
    alias: post.alias ?? null, text: post.text ?? null,
    template: post.template === 'checking_in' ? 'Checking in' : post.template === 'at_my_pace' ? 'Taking it at my pace' : null,
    createdAt: post.createdAt, expiresAt: post.expiresAt };
}

export function endedCheckinsView(status: 'disposed' | 'sessionended'): CheckinsView {
  return { status, rows: [], nextCursor: null, busy: false, canRefresh: false, canNext: false, canClose: false,
    notice: { kind: 'info', text: status === 'disposed' ? 'Group check-ins are no longer available in this session.' : 'This Community session ended.' },
    commandNotice: null };
}

export function projectCheckins(snapshot: CommunityPostsSnapshot, groupId: string, reading = false): CheckinsView {
  if (snapshot.disposed) return endedCheckinsView('disposed');
  if (snapshot.groupId !== groupId || snapshot.page.groupId !== groupId) return endedCheckinsView('sessionended');
  const page = snapshot.page, unresolved = unresolvedPostCommand(snapshot.command);
  const data = page.status === 'ready' || page.status === 'empty' ? page.data : null;
  const busy = reading || page.status === 'loading';
  const canRefresh = !busy && !unresolved;
  const nextCursor = data?.nextCursor ?? null;
  const messages = {
    idle: 'Load group check-ins to read the current page.',
    loading: 'Loading group check-ins…',
    ready: 'Showing the current page of group posts.',
    empty: nextCursor !== null ? 'No posts on this page. You can read the next page.' : 'No posts on this page.',
    stale: 'This page changed. Refresh check-ins to read it again.',
    error: 'Group check-ins could not be loaded. Refresh to try again.',
  };
  return { status: page.status, rows: data ? data.posts.map(row) : [], nextCursor, busy,
    canRefresh, canNext: canRefresh && nextCursor !== null, canClose: !unresolved,
    notice: { kind: page.status === 'error' ? 'error' : page.status === 'stale' ? 'warning' : 'info', text: messages[page.status] },
    commandNotice: unresolved ? { kind: 'warning', text: snapshot.command.status === 'pending' || snapshot.command.intent?.state === 'pending'
      ? 'Another group post change is in progress. Wait before refreshing or leaving.'
      : 'Another group post change has an unconfirmed outcome. It must be reconciled on its original surface before refreshing or leaving.' } : null };
}
