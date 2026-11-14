import React, { useLayoutEffect } from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { View } from 'react-native';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { CommunityResources, type CommunityPost, type CommunityPostsPage } from '../../src/api/community';
import { FormTransport } from '../../src/api/transport';
import { CheckinsList, createCheckinsRenderer, type CheckinsContext } from '../../src/community/checkins-ui';

const mockActions = new Map<string, (() => void) | undefined>();
let mockBack: (() => void) | undefined;
jest.mock('../../src/features/shared/ui', () => {
  const React = require('react') as typeof import('react');
  const actual = jest.requireActual<typeof import('../../src/features/shared/ui')>('../../src/features/shared/ui');
  return { ...actual,
    PrimaryAction(props: React.ComponentProps<typeof actual.PrimaryAction>) {
      if (props.captureId) mockActions.set(props.captureId, props.onPress);
      return React.createElement(actual.PrimaryAction, props);
    },
    PlainAction(props: React.ComponentProps<typeof actual.PlainAction>) {
      if (props.captureId) mockActions.set(props.captureId, props.onPress);
      return React.createElement(actual.PlainAction, props);
    },
    Nav(props: React.ComponentProps<typeof actual.Nav>) {
      mockBack = props.onBack;
      return React.createElement(actual.Nav, props);
    },
  };
});

const G = '11111111-1111-4111-8111-111111111111', P = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const at = '2026-10-09T12:00:00.000Z';
const post = (extra: Partial<CommunityPost> = {}): CommunityPost => ({ id: P, revision: 1, kind: 'check_in', state: 'published',
  createdAt: at, expiresAt: at, ...extra });
const json = (value: unknown, status = 200) => {
  const response = new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  // Parse serialized bytes in the same Jest realm as the strict production parser.
  response.json = async () => JSON.parse(await response.text());
  return response;
};
type Call = { path: string; search: string; method: string; raw: string | undefined };
const pendingCleanup: (() => void)[] = [], resourceCleanup: (() => void)[] = [];
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  pendingCleanup.push(() => resolve(json({ error: { code: 'community_unavailable' } }, 503)));
  return { promise, resolve };
}
async function fixture() {
  const calls: Call[] = [], state: { generation: number; page: CommunityPostsPage; response: ((call: Call) => Response | Promise<Response>) | null } = {
    generation: 1, page: { posts: [post({ text: 'Current page content', alias: 'Leaf', template: 'checking_in' })], nextCursor: C }, response: null,
  };
  const transport = new FormTransport('https://form.renderer.invalid', {
    async load() { return null; }, async save() {}, async clear() {},
  }, async (url, init) => {
    if (String(url).includes('/api/auth/sign-in')) return new Response('{}', { headers: { 'set-auth-token': 'synthetic-session' } });
    const parsed = new URL(String(url)), call = { path: parsed.pathname, search: parsed.search, method: init?.method ?? 'GET',
      raw: init?.body === undefined ? undefined : String(init.body) };
    calls.push(call); return state.response ? state.response(call) : json(state.page);
  });
  await transport.signIn('synthetic@example.invalid', 'synthetic-password');
  const resources = new CommunityResources(transport, () => true), controller = resources.createPostsController(G);
  resourceCleanup.push(() => resources.dispose());
  const onClose = jest.fn();
  const context: CheckinsContext = { controller, groupId: G, sessionGeneration: 1,
    isCurrentSession: generation => state.generation === generation, onClose };
  return { calls, state, transport, controller, context, onClose };
}
function captureActions() {
  const refresh = mockActions.get('community-checkins-refresh'), next = mockActions.get('community-checkins-next'), close = mockBack;
  expect(typeof refresh).toBe('function'); expect(typeof next).toBe('function'); expect(typeof close).toBe('function');
  return { refresh: refresh!, next: next!, close: close! };
}
async function refresh() { await fireEvent.press(screen.getByRole('button', { name: 'Refresh check-ins' })); }
afterEach(async () => {
  await cleanup();
  await act(async () => { resourceCleanup.splice(0).forEach(dispose => dispose()); pendingCleanup.splice(0).forEach(finish => finish()); });
  mockActions.clear(); mockBack = undefined;
});

test('renderer factory composes the real controls with explicit idle loading and current-page content', async () => {
  const f = await fixture(), Renderer = createCheckinsRenderer(); await render(<Renderer context={f.context} />);
  expect(screen.getByRole('header', { name: 'Group check-ins' })).toBeTruthy();
  expect(screen.getByText('Load group check-ins to read the current page.')).toBeTruthy(); expect(f.calls).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(true);
  await refresh();
  expect(screen.getByText('Current page content')).toBeTruthy(); expect(screen.getByText('Leaf')).toBeTruthy();
  expect(screen.getByText('Checking in')).toBeTruthy();
  expect(screen.getByText(`Recorded creation (UTC): ${at}`)).toBeTruthy();
  expect(screen.getByText(`Recorded expiry (UTC): ${at}`)).toBeTruthy();
  expect(screen.getByTestId('community-checkins-notice').props.accessibilityLiveRegion).toBe('polite');
  expect(f.calls).toEqual([{ path: `/v1/community/groups/${G}/posts`, search: '', method: 'GET', raw: undefined }]);
  expect(screen.queryByRole('button', { name: /Post|Hide|Report|Retry|React/ })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Back to Group' })); expect(f.onClose).toHaveBeenCalledTimes(1);
});

test('published optional fields stay absent and full long content remains untruncated and read-only', async () => {
  const f = await fixture(); f.state.page = { posts: [post(), post({ id: C, kind: 'win', text: 'W'.repeat(500), alias: 'A'.repeat(60) })], nextCursor: null };
  await render(<CheckinsList context={f.context} />); await refresh();
  expect(screen.getByText('Published check-in')).toBeTruthy(); expect(screen.getByText('Published win')).toBeTruthy();
  expect(screen.queryByText('Anonymous')).toBeNull(); expect(screen.queryByText('Checking in')).toBeNull();
  expect(screen.queryByTestId(`community-checkins-text-${P}`)).toBeNull();
  expect(screen.getByText('W'.repeat(500)).props.numberOfLines).toBeUndefined();
  expect(screen.getByText('A'.repeat(60)).props.numberOfLines).toBeUndefined();
  expect(screen.getByTestId(`community-checkins-row-${C}`).props.onPress).toBeUndefined();
  expect(f.calls.every(call => call.method === 'GET')).toBe(true);
});

test('pending hidden and rejected rows show distinct generic notices without echoing their DTO content', async () => {
  const f = await fixture(); f.state.page = { posts: (['pending', 'hidden', 'rejected'] as const).map((state, i) =>
    post({ id: [P, C, D][i]!, state, alias: `Private ${state}`, text: `Secret ${state}`, template: 'at_my_pace' })), nextCursor: null };
  await render(<CheckinsList context={f.context} />); await refresh();
  for (const label of ['Pending post', 'Hidden post', 'Rejected post']) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText('This post is pending. Publication is not confirmed.')).toBeTruthy();
  for (const state of ['pending', 'hidden', 'rejected']) {
    expect(screen.queryByText(`Private ${state}`)).toBeNull(); expect(screen.queryByText(`Secret ${state}`)).toBeNull();
  }
  expect(screen.queryByText('Taking it at my pace')).toBeNull(); expect(screen.queryByText(/Recorded creation/)).toBeNull();
});

test('opaque next page replaces rows, empty pages can continue, and Refresh explicitly returns to the first page', async () => {
  const f = await fixture();
  f.state.response = call => json(call.search.includes(C) ? { posts: [], nextCursor: D } :
    call.search.includes(D) ? { posts: [post({ id: D, text: 'Later page' })], nextCursor: null } : f.state.page);
  await render(<CheckinsList context={f.context} />); await refresh();
  await fireEvent.press(screen.getByRole('button', { name: 'Next page' }));
  expect(f.calls[1]!.search).toBe(`?cursor=${C}`); expect(screen.queryByText('Current page content')).toBeNull();
  expect(screen.getByText('No posts on this page. You can read the next page.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(screen.getByRole('button', { name: 'Next page' }));
  expect(f.calls[2]!.search).toBe(`?cursor=${D}`); expect(screen.getByText('Later page')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(true);
  await refresh(); expect(f.calls[3]!.search).toBe(''); expect(screen.queryByText('Later page')).toBeNull();
  expect(screen.getByText('Current page content')).toBeTruthy();
});

test('loading announces busy and blocks synchronous original callback replays for both read actions', async () => {
  const f = await fixture(); await render(<CheckinsList context={f.context} />); const original = captureActions();
  const waiting = deferred(); f.state.response = () => waiting.promise;
  await act(async () => { original.refresh(); original.refresh(); original.next(); });
  expect(f.calls).toHaveLength(1); expect(screen.getByText('Loading group check-ins…')).toBeTruthy();
  expect(screen.getByTestId('community-checkins-refresh').props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  expect(screen.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(true);
  await act(async () => { waiting.resolve(json(f.state.page)); });
  expect(screen.getByTestId('community-checkins-refresh').props.accessibilityState).toMatchObject({ disabled: false, busy: false });
  const next = deferred(); f.state.response = () => next.promise;
  await act(async () => { original.next(); original.next(); original.refresh(); }); expect(f.calls).toHaveLength(2);
  await act(async () => { next.resolve(json({ posts: [], nextCursor: null })); });
  expect(screen.getByText('No posts on this page.')).toBeTruthy();
});

test('errors and stale pages remove previous content while real current read availability controls recovery', async () => {
  const f = await fixture(); await render(<CheckinsList context={f.context} />); await refresh();
  f.state.response = () => json({ error: { code: 'community_unavailable', message: 'RAW private failure' } }, 503);
  await refresh(); expect(screen.getByText('Group check-ins could not be loaded. Refresh to try again.')).toBeTruthy();
  expect(screen.queryByText('Current page content')).toBeNull(); expect(screen.queryByText('RAW private failure')).toBeNull();
  expect(screen.getByRole('button', { name: 'Refresh check-ins' }).props.accessibilityState.disabled).toBe(false);
  expect(f.calls).toHaveLength(2);
  f.state.response = () => json({ id: P, revision: 2, state: 'hidden' });
  await act(async () => { await f.controller.hidePost(P, 1, 'host-hide'); });
  expect(screen.getByText('This page changed. Refresh check-ins to read it again.')).toBeTruthy();
  expect(screen.queryByText('Current page content')).toBeNull();
  f.state.response = () => json({ posts: [], nextCursor: null }); await refresh();
  expect(screen.getByText('No posts on this page.')).toBeTruthy(); expect(f.calls).toHaveLength(4);
});

test('latest real controller read wins over an older leaf read with no retained rows or derived cursors', async () => {
  const f = await fixture(), first = deferred(), latest = deferred();
  f.state.response = call => call.search ? latest.promise : first.promise;
  await render(<CheckinsList context={f.context} />); await refresh();
  let reading!: Promise<void>;
  await act(async () => { reading = f.controller.loadPage({ cursor: C }); });
  await act(async () => { latest.resolve(json({ posts: [post({ text: 'Newest content' })], nextCursor: null })); await reading; });
  await act(async () => { first.resolve(json(f.state.page)); });
  expect(screen.getByText('Newest content')).toBeTruthy(); expect(screen.queryByText('Current page content')).toBeNull();
  expect(screen.getByRole('button', { name: 'Next page' }).props.accessibilityState.disabled).toBe(true);
});

test('close before completion never navigates again or repopulates expired presentation', async () => {
  const f = await fixture(), waiting = deferred(); f.state.response = () => waiting.promise;
  await render(<CheckinsList context={f.context} />); const old = captureActions(); await refresh();
  await fireEvent.press(screen.getByRole('button', { name: 'Back to Group' }));
  expect(f.onClose).toHaveBeenCalledTimes(1);
  await act(async () => { waiting.resolve(json(f.state.page)); });
  expect(screen.getByText('This Community session ended.')).toBeTruthy(); expect(screen.queryByText('Current page content')).toBeNull();
  await act(async () => { old.refresh(); old.next(); old.close(); });
  expect(f.calls).toHaveLength(1); expect(f.onClose).toHaveBeenCalledTimes(1); expect(f.controller.getSnapshot().disposed).toBe(false);
});

test('equal-valued context replacement and returning the original object permanently expire original callbacks', async () => {
  const f = await fixture(), result = await render(<CheckinsList context={f.context} />);
  await refresh(); const old = captureActions();
  await result.rerender(<CheckinsList context={{ ...f.context }} />);
  await act(async () => { old.refresh(); old.next(); old.close(); });
  expect(f.calls).toHaveLength(1); expect(f.onClose).not.toHaveBeenCalled();
  await result.rerender(<CheckinsList context={f.context} />);
  await act(async () => { old.refresh(); old.next(); old.close(); });
  expect(f.calls).toHaveLength(1); expect(screen.getByText('Current page content')).toBeTruthy();
  await refresh(); expect(f.calls).toHaveLength(2);
});

test('layout removal expires callbacks before a parent layout effect can replay them and real remount retains host page', async () => {
  const f = await fixture(); let replay = () => {};
  function Host({ shown }: { shown: boolean }) {
    useLayoutEffect(() => { if (!shown) replay(); }, [shown]);
    return shown ? <CheckinsList context={f.context} /> : <View testID="replacement" />;
  }
  const result = await render(<Host shown />); await refresh(); const old = captureActions();
  let replayed = false;
  replay = () => { replayed = true; old.refresh(); old.next(); old.close(); };
  await result.rerender(<Host shown={false} />);
  expect(replayed).toBe(true); expect(screen.getByTestId('replacement')).toBeTruthy();
  expect(f.calls).toHaveLength(1); expect(f.onClose).not.toHaveBeenCalled();
  await result.rerender(<Host shown />);
  expect(screen.getByText('Current page content')).toBeTruthy(); expect(f.calls).toHaveLength(1);
  await act(async () => { old.refresh(); old.next(); old.close(); });
  expect(f.calls).toHaveLength(1); expect(f.onClose).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Back to Group' })); expect(f.onClose).toHaveBeenCalledTimes(1);
});

test('session replacement cannot adopt old controller data or late completion; fresh controller remains usable', async () => {
  const f = await fixture(), waiting = deferred(); f.state.response = () => waiting.promise;
  const result = await render(<CheckinsList context={f.context} />); const old = captureActions(); await refresh();
  f.state.generation = 2;
  await result.rerender(<CheckinsList context={{ ...f.context, sessionGeneration: 2 }} />);
  await act(async () => { waiting.resolve(json(f.state.page)); old.refresh(); old.next(); old.close(); });
  expect(screen.getByText('This Community session ended.')).toBeTruthy(); expect(screen.queryByText('Current page content')).toBeNull();
  expect(f.calls).toHaveLength(1); expect(f.onClose).not.toHaveBeenCalled();
  f.state.generation = 1; await result.rerender(<CheckinsList context={f.context} />);
  expect(screen.getByText('This Community session ended.')).toBeTruthy();
  const fresh = await fixture(); fresh.state.generation = 2;
  await result.rerender(<CheckinsList context={{ ...fresh.context, sessionGeneration: 2 }} />); await refresh();
  expect(screen.getByText('Current page content')).toBeTruthy(); expect(fresh.calls).toHaveLength(1);
});

test('a session guard ending without context replacement redacts visible content on the next guarded action', async () => {
  const f = await fixture(); await render(<CheckinsList context={f.context} />); await refresh(); const old = captureActions();
  f.state.generation = 2;
  await act(async () => { old.refresh(); old.next(); old.close(); });
  expect(screen.getByText('This Community session ended.')).toBeTruthy();
  expect(screen.queryByText('Current page content')).toBeNull(); expect(screen.queryByText('Leaf')).toBeNull();
  expect(screen.queryByTestId('community-checkins-refresh')).toBeNull();
  expect(f.calls).toHaveLength(1); expect(f.onClose).not.toHaveBeenCalled();
});

test('disposed or mismatched bindings redact old rows and prevent captured actions', async () => {
  for (const kind of ['disposed', 'group'] as const) {
    const f = await fixture(), result = await render(<CheckinsList context={f.context} />); await refresh(); const old = captureActions();
    if (kind === 'disposed') await act(async () => { f.controller.dispose(); });
    else await result.rerender(<CheckinsList context={{ ...f.context, groupId: D }} />);
    expect(screen.queryByText('Current page content')).toBeNull(); expect(screen.queryByText('Leaf')).toBeNull();
    expect(screen.queryByTestId('community-checkins-refresh')).toBeNull(); expect(screen.queryByTestId('a-back')).toBeNull();
    await act(async () => { old.refresh(); old.next(); old.close(); });
    expect(f.calls).toHaveLength(1); expect(f.onClose).not.toHaveBeenCalled(); await result.unmount();
  }
});

test('foreign pending and unknown commands omit Back and never expose writes retries or a false saving claim', async () => {
  const f = await fixture(), waiting = deferred(); await render(<CheckinsList context={f.context} />); const old = captureActions();
  f.state.response = () => waiting.promise;
  let command!: Promise<unknown>;
  await act(async () => { command = f.controller.createPost({ kind: 'win', text: 'Private host draft', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'host-post').catch(error => error); });
  expect(screen.getByText('Another group post change is in progress. Wait before refreshing or leaving.')).toBeTruthy();
  expect(screen.queryByTestId('a-back')).toBeNull();
  await act(async () => { old.refresh(); old.next(); old.close(); }); expect(f.calls).toHaveLength(1);
  await act(async () => { waiting.resolve(json({ error: { code: 'community_posting_unavailable' } }, 503)); await command; });
  expect(screen.getByText(/Another group post change has an unconfirmed outcome/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Retry|Post|Hide|Report|React/ })).toBeNull();
  expect(screen.queryByText('Private host draft')).toBeNull(); expect(screen.queryByText(/nothing was saved/i)).toBeNull();
  expect(screen.getByRole('button', { name: 'Refresh check-ins' }).props.accessibilityState.disabled).toBe(true);
  await act(async () => { old.refresh(); old.next(); old.close(); });
  expect(f.calls).toHaveLength(1); expect(f.onClose).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().command.intent?.state).toBe('unknown');
});

test('known rejection does not echo rejected text and leaves explicit reads and navigation available', async () => {
  const f = await fixture(); await render(<CheckinsList context={f.context} />);
  f.state.response = () => json({ error: { code: 'community_text_rejected', message: 'Private rejected text' } }, 422);
  await act(async () => { await f.controller.createPost({ kind: 'win', text: 'Private rejected text', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'host-rejected').catch(() => {}); });
  expect(screen.queryByText('Private rejected text')).toBeNull();
  expect(screen.getByRole('button', { name: 'Refresh check-ins' }).props.accessibilityState.disabled).toBe(false);
  expect(screen.getByRole('button', { name: 'Back to Group' })).toBeTruthy();
  f.state.response = () => json(f.state.page); await refresh(); expect(screen.getByText('Current page content')).toBeTruthy();
  expect(f.calls).toHaveLength(2);
});
