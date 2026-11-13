import React from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { CommunityResources, type CommunityGroupDetail } from '../../src/api/community';
import { FormTransport } from '../../src/api/transport';
import { AliasScreen, ExitConfirmation, createAliasExitPresentation, type AliasExitContext } from '../../src/community/alias-exit-ui';
import { commandKey } from '../../src/api/client';

const G = '11111111-1111-4111-8111-111111111111', M = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const json = (value: unknown, status = 200) => {
  const response = new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  // Parse serialized fixture bytes in the same Jest realm as the strict Community parser.
  response.json = async () => JSON.parse(await response.text());
  return response;
};
type Call = { path: string; method: string; raw: string | undefined; key: string | null };
const pendingCleanup: (() => void)[] = [];
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  pendingCleanup.push(() => resolve(json({ error: { code: 'community_unavailable' } }, 503)));
  return { promise, resolve };
}
async function fixture(role: 'owner' | 'admin' | 'member' = 'owner') {
  const calls: Call[] = [], state: {
    generation: number; detail: CommunityGroupDetail; response: ((call: Call) => Response | Promise<Response>) | null;
  } = { generation: 1, detail: { id: G, name: 'Synthetic group', role, memberId: M, revision: 4,
    members: [{ memberId: M, alias: 'Leaf', role, revision: 7 }] }, response: null };
  const transport = new FormTransport('https://form.renderer.invalid', {
    async load() { return null; }, async save() {}, async clear() {},
  }, async (url, init) => {
    if (String(url).includes('/api/auth/sign-in')) return new Response('{}', { headers: { 'set-auth-token': 'synthetic-session' } });
    const call = { path: new URL(String(url)).pathname.replace('/v1/community', ''), method: init?.method ?? 'GET',
      raw: init?.body === undefined ? undefined : String(init.body), key: new Headers(init?.headers).get('Idempotency-Key') };
    calls.push(call);
    if (state.response) return state.response(call);
    if (call.method === 'GET') return json(state.detail);
    if (call.path.endsWith('/me')) return json({ ...state.detail.members[0], alias: JSON.parse(call.raw!).alias, revision: 8 });
    return json(call.path.endsWith('/leave') ? { left: true } : { closed: true });
  });
  await transport.signIn('synthetic@example.invalid', 'synthetic-password');
  const resources = new CommunityResources(transport, () => true), controller = resources.createGroupController();
  await controller.loadDetail(G);
  const onClose = jest.fn();
  const context: AliasExitContext = { controller, groupId: G, sessionGeneration: 1,
    isCurrentSession: generation => state.generation === generation, onClose };
  return { calls, state, controller, context, onClose };
}
const writes = (calls: Call[]) => calls.filter(call => call.method !== 'GET');
afterEach(async () => {
  await cleanup();
  await act(async () => { pendingCleanup.splice(0).forEach(finish => finish()); });
});

test('ordinary alias form uses real own member and explicit member-revision save with announced receipt', async () => {
  const f = await fixture(); await render(<AliasScreen context={f.context} />);
  expect(screen.getByLabelText('Your alias').props.value).toBe('Leaf');
  expect(writes(f.calls)).toHaveLength(0);
  await fireEvent.changeText(screen.getByLabelText('Your alias'), 'New alias');
  await fireEvent.press(screen.getByTestId('community-alias-save'));
  expect(JSON.parse(writes(f.calls)[0].raw!)).toEqual({ alias: 'New alias', expectedRevision: 7 });
  expect(screen.getByText('Alias saved: New alias')).toBeTruthy();
  expect(screen.getByTestId('community-alias-exit-notice').props.accessibilityLiveRegion).toBe('polite');
  expect(screen.queryByText('You left the group.')).toBeNull();
  expect(f.onClose).not.toHaveBeenCalled();
});

test('pending disables native input/actions and omits actionable Back; retained close and double tap cannot bypass', async () => {
  const f = await fixture(), waiting = deferred(); f.state.response = () => waiting.promise;
  await render(<AliasScreen context={f.context} />);
  const back = screen.getByTestId('a-back').props.onPress;
  await fireEvent.changeText(screen.getByLabelText('Your alias'), 'Pending alias');
  await fireEvent.press(screen.getByTestId('community-alias-save'));
  await fireEvent.press(screen.getByTestId('community-alias-save'));
  await act(async () => { back(); });
  expect(writes(f.calls)).toHaveLength(1); expect(f.onClose).not.toHaveBeenCalled();
  expect(screen.queryByTestId('a-back')).toBeNull();
  expect(screen.getByLabelText('Your alias').props.editable).toBe(false);
  expect(screen.getByLabelText('Your alias').props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  expect(screen.getByTestId('community-alias-save').props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  await act(async () => { waiting.resolve(json({ memberId: M, alias: 'Pending alias', role: 'owner', revision: 8 })); });
  expect(screen.getByText('Alias saved: Pending alias')).toBeTruthy();
});

test('exit caution and cancellation precede dispatch and leave/close receipts stay distinct', async () => {
  for (const mode of ['leave', 'close'] as const) {
    const f = await fixture(); await render(<ExitConfirmation context={f.context} mode={mode} />);
    expect(screen.getByText(mode === 'leave' ? 'Confirm that you want to leave this group.' : 'Confirm that you want to close this group as its owner.')).toBeTruthy();
    expect(writes(f.calls)).toHaveLength(0);
    await fireEvent.press(screen.getByText('Cancel')); expect(f.onClose).toHaveBeenCalledTimes(1);
    expect(writes(f.calls)).toHaveLength(0); await cleanup();
    const next = await fixture(); await render(<ExitConfirmation context={next.context} mode={mode} />);
    await fireEvent.press(screen.getByTestId(`community-${mode}-confirm`));
    expect(JSON.parse(writes(next.calls)[0].raw!)).toEqual(mode === 'leave' ? {} : { expectedRevision: 4 });
    expect(screen.getByText(mode === 'leave' ? 'You left the group.' : 'The group is closed.')).toBeTruthy();
    expect(screen.queryByText(mode === 'leave' ? 'The group is closed.' : 'You left the group.')).toBeNull();
    expect(screen.getByText('Done')).toBeTruthy(); await cleanup();
  }
});

test('non-owner closure remains visibly disabled and known owner leave denial offers no close recovery', async () => {
  const f = await fixture('member'); await render(<ExitConfirmation context={f.context} mode="close" />);
  expect(screen.getByTestId('community-close-confirm').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByText('Only the current group owner can close this group.')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('community-close-confirm')); expect(writes(f.calls)).toHaveLength(0);
  await cleanup();
  const owner = await fixture(); owner.state.response = () => json({ error: { code: 'community_owner_must_close', message: 'RAW SERVER TEXT' } }, 409);
  await render(<ExitConfirmation context={owner.context} mode="leave" />);
  await fireEvent.press(screen.getByTestId('community-leave-confirm'));
  expect(screen.getByText('The group owner cannot leave this group.')).toBeTruthy();
  expect(screen.queryByText('Close group')).toBeNull(); expect(screen.queryByText('RAW SERVER TEXT')).toBeNull();
  expect(writes(owner.calls)).toHaveLength(1);
});

test('actual unmount/remount retains uncertain intent and retries same key/body without repeating initial load', async () => {
  const f = await fixture(); f.state.response = () => { throw new Error('lost response'); };
  const first = await render(<AliasScreen context={f.context} />);
  const oldEdit = screen.getByLabelText('Your alias').props.onChangeText;
  const oldSave = screen.getByTestId('community-alias-save').props.onPress;
  await fireEvent.changeText(screen.getByLabelText('Your alias'), 'Retained alias');
  await fireEvent.press(screen.getByTestId('community-alias-save')); const original = writes(f.calls)[0];
  expect(screen.queryByTestId('a-back')).toBeNull();
  await first.unmount();
  const count = f.calls.length; await render(<AliasScreen context={f.context} />);
  expect(f.calls).toHaveLength(count); expect(screen.getByLabelText('Your alias').props.editable).toBe(false);
  await act(async () => { oldEdit('Replayed'); oldSave(); }); expect(writes(f.calls)).toHaveLength(1);
  f.state.response = () => json({ memberId: M, alias: 'Retained alias', role: 'owner', revision: 8 });
  await fireEvent.press(screen.getByText('Retry original change'));
  expect(writes(f.calls)[1]).toMatchObject({ raw: original.raw, key: original.key });
  expect(screen.getByText('Alias saved: Retained alias')).toBeTruthy();
  expect(f.controller.getSnapshot().disposed).toBe(false);
});

test('foreign unknown command is visible and blocks refresh edit retry Back and exit success', async () => {
  const f = await fixture(); f.state.response = () => { throw new Error('lost'); };
  await expect(f.controller.leave(OTHER, { confirmed: true }, commandKey())).rejects.toBeTruthy();
  await render(<ExitConfirmation context={f.context} mode="leave" />);
  expect(screen.getByText(/Another Community change is unresolved/)).toBeTruthy();
  expect(screen.queryByTestId('a-back')).toBeNull();
  expect(screen.getByTestId('community-leave-confirm').props.accessibilityState.disabled).toBe(true);
  const count = f.calls.length; await fireEvent.press(screen.getByText('Retry original change'));
  await fireEvent.press(screen.getByText('Refresh group details')); await fireEvent.press(screen.getByText('Cancel'));
  expect(f.calls).toHaveLength(count); expect(f.onClose).not.toHaveBeenCalled();
  expect(screen.queryByText('You left the group.')).toBeNull();
});

test('revision replacement requires explicit fresh review and rejected alias never enters notice text', async () => {
  const f = await fixture(); await render(<AliasScreen context={f.context} />);
  await fireEvent.changeText(screen.getByLabelText('Your alias'), 'Private rejected draft');
  f.state.detail = { ...f.state.detail, revision: 5, members: [{ ...f.state.detail.members[0]!, alias: 'Current alias', revision: 11 }] };
  await act(async () => { await f.controller.loadDetail(G); });
  expect(screen.getByLabelText('Your alias').props.value).toBe('Private rejected draft');
  expect(screen.getByTestId('community-alias-save').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(screen.getByText('Review current details'));
  expect(screen.getByLabelText('Your alias').props.value).toBe('Current alias');
  await fireEvent.changeText(screen.getByLabelText('Your alias'), 'Private rejected draft');
  f.state.response = () => json({ error: { code: 'community_text_rejected', message: 'Private rejected draft RAW' } }, 422);
  await fireEvent.press(screen.getByTestId('community-alias-save'));
  expect(JSON.parse(writes(f.calls)[0].raw!).expectedRevision).toBe(11);
  expect(screen.getByText('This alias cannot be used in Form groups. Rephrase it and try again.')).toBeTruthy();
  expect(screen.queryByText('Private rejected draft RAW')).toBeNull();
});

test('same-account session replacement and mode/group/controller replacement invalidate captured callbacks', async () => {
  const f = await fixture(); const result = await render(<AliasScreen context={f.context} />);
  const oldSave = screen.getByTestId('community-alias-save').props.onPress;
  const oldBack = screen.getByTestId('a-back').props.onPress;
  f.state.generation = 2;
  const nextSession = await fixture();
  const replacement = { ...f.context, controller: nextSession.controller, sessionGeneration: 2 };
  await result.rerender(<ExitConfirmation context={replacement} mode="close" />);
  await act(async () => { oldSave(); oldBack(); }); expect(writes(f.calls)).toHaveLength(0);
  expect(f.onClose).not.toHaveBeenCalled();
  const oldConfirm = screen.getByTestId('community-close-confirm').props.onPress;
  await result.rerender(<ExitConfirmation context={replacement} mode="leave" />);
  await act(async () => { oldConfirm(); }); expect(writes(f.calls)).toHaveLength(0);
  expect(writes(nextSession.calls)).toHaveLength(0);
  const previousMode = screen.getByTestId('community-leave-confirm').props.onPress;
  await result.rerender(<ExitConfirmation context={{ ...replacement, groupId: OTHER }} mode="leave" />);
  await act(async () => { previousMode(); }); expect(writes(f.calls)).toHaveLength(0);
  expect(writes(nextSession.calls)).toHaveLength(0);
  const oldLeave = screen.getByTestId('community-leave-confirm').props.onPress;
  const other = await fixture(); await result.rerender(<ExitConfirmation context={other.context} mode="close" />);
  await act(async () => { oldLeave(); }); expect(writes(f.calls)).toHaveLength(0); expect(writes(other.calls)).toHaveLength(0);
  expect(writes(nextSession.calls)).toHaveLength(0);
});

test('late promise after account switch shows no old group alias receipt or enabled action', async () => {
  const f = await fixture(), waiting = deferred(); f.state.response = () => waiting.promise;
  const result = await render(<AliasScreen context={f.context} />);
  await fireEvent.changeText(screen.getByLabelText('Your alias'), 'Old private alias');
  await fireEvent.press(screen.getByTestId('community-alias-save'));
  f.state.generation = 2;
  await result.rerender(<AliasScreen context={f.context} />);
  await act(async () => { waiting.resolve(json({ memberId: M, alias: 'Old private alias', role: 'owner', revision: 8 })); });
  expect(screen.getByText('This Community session ended.')).toBeTruthy();
  expect(screen.queryByText('Synthetic group')).toBeNull(); expect(screen.queryByLabelText('Your alias')).toBeNull();
  expect(screen.queryByTestId('community-alias-save')).toBeNull(); expect(f.onClose).not.toHaveBeenCalled();
});

test('stress text stays complete, missing own row disables alias and is never an exit receipt', async () => {
  const f = await fixture(); f.state.detail = { ...f.state.detail, name: 'Long group '.repeat(7).trim(),
    members: [{ ...f.state.detail.members[0]!, alias: 'W'.repeat(60) }] };
  await f.controller.loadDetail(G); const result = await render(<AliasScreen context={f.context} />);
  expect(screen.getByText(f.state.detail.name)).toBeTruthy();
  expect(screen.getByLabelText('Your alias').props.value).toHaveLength(60);
  expect(screen.getByLabelText('Your alias').props.multiline).toBe(true);
  expect(screen.getByLabelText('Your alias').props.numberOfLines).toBeUndefined();
  f.state.detail = { ...f.state.detail, members: [] };
  await act(async () => { await f.controller.loadDetail(G); });
  expect(screen.getByLabelText('Your alias').props.editable).toBe(false);
  expect(screen.getByTestId('community-alias-save').props.accessibilityState.disabled).toBe(true);
  expect(screen.queryByText('You left the group.')).toBeNull();
  await result.unmount();
  const model = createAliasExitPresentation(f.context, 'leave', commandKey); model.attach();
  expect(model.getSnapshot().receipt).toBeNull(); model.detach();
});

test('equal-fields context replacement on the same AliasScreen permanently fences captured input Save and Back', async () => {
  const f = await fixture(), result = await render(<AliasScreen context={f.context} />);
  const oldEdit = screen.getByLabelText('Your alias').props.onChangeText;
  const oldSave = screen.getByTestId('community-alias-save').props.onPress;
  const oldBack = screen.getByTestId('a-back').props.onPress;
  await fireEvent.changeText(screen.getByLabelText('Your alias'), 'Old local draft');
  await result.rerender(<AliasScreen context={{ ...f.context }} />);
  await act(async () => { oldEdit('Replayed edit'); await oldSave(); oldBack(); });
  expect(screen.getByLabelText('Your alias').props.value).toBe('Leaf');
  expect(writes(f.calls)).toHaveLength(0); expect(f.onClose).not.toHaveBeenCalled();
  await result.rerender(<AliasScreen context={f.context} />);
  await act(async () => { oldEdit('Replayed again'); await oldSave(); oldBack(); });
  expect(screen.getByLabelText('Your alias').props.value).toBe('Leaf');
  expect(writes(f.calls)).toHaveLength(0); expect(f.onClose).not.toHaveBeenCalled();
  await fireEvent.changeText(screen.getByLabelText('Your alias'), 'Current explicit alias');
  await fireEvent.press(screen.getByTestId('community-alias-save'));
  expect(writes(f.calls)).toHaveLength(1);
  expect(JSON.parse(writes(f.calls)[0].raw!)).toEqual({ alias: 'Current explicit alias', expectedRevision: 7 });
  expect(screen.getByText('Alias saved: Current explicit alias')).toBeTruthy();
});

test('equal-fields context replacement on the same ExitConfirmation fences confirm Cancel and Back in both modes', async () => {
  for (const mode of ['leave', 'close'] as const) {
    const f = await fixture(), result = await render(<ExitConfirmation context={f.context} mode={mode} />);
    const oldConfirm = screen.getByTestId(`community-${mode}-confirm`).props.onPress;
    const oldCancel = screen.getByRole('button', { name: 'Cancel' }).props.onPress;
    const oldBack = screen.getByTestId('a-back').props.onPress;
    await result.rerender(<ExitConfirmation context={{ ...f.context }} mode={mode} />);
    await act(async () => { await oldConfirm(); oldCancel(); oldBack(); });
    expect(writes(f.calls)).toHaveLength(0); expect(f.onClose).not.toHaveBeenCalled();
    await result.rerender(<ExitConfirmation context={f.context} mode={mode} />);
    await act(async () => { await oldConfirm(); oldCancel(); oldBack(); });
    expect(writes(f.calls)).toHaveLength(0); expect(f.onClose).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId(`community-${mode}-confirm`));
    expect(writes(f.calls)).toHaveLength(1);
    expect(screen.getByText(mode === 'leave' ? 'You left the group.' : 'The group is closed.')).toBeTruthy();
    await result.unmount();
  }
});

test('leave 429 renders previous rejection alongside an available explicit leave control', async () => {
  const f = await fixture('member');
  f.state.response = () => json({ error: { code: 'community_rate_limited', message: 'RAW quota' } }, 429);
  await render(<ExitConfirmation context={f.context} mode="leave" />);
  await fireEvent.press(screen.getByTestId('community-leave-confirm'));
  expect(screen.getByText('The previous change was rate limited.')).toBeTruthy();
  expect(screen.getByText('Previous change')).toBeTruthy();
  expect(screen.getByText('You can submit a new leave request.')).toBeTruthy();
  expect(screen.getByTestId('community-leave-confirm').props.accessibilityState.disabled).toBe(false);
  expect(screen.queryByText(/A new change is unavailable/)).toBeNull();
  expect(screen.queryByText('RAW quota')).toBeNull(); expect(screen.queryByText('You left the group.')).toBeNull();
  const original = writes(f.calls)[0]; f.state.response = () => json({ left: true });
  await fireEvent.press(screen.getByTestId('community-leave-confirm'));
  expect(writes(f.calls)).toHaveLength(2); expect(writes(f.calls)[1].key).not.toBe(original.key);
  expect(screen.getByText('You left the group.')).toBeTruthy();
});

test('alias stale rejection renders current refresh then review then enabled Save guidance', async () => {
  const f = await fixture(); await render(<AliasScreen context={f.context} />);
  await fireEvent.changeText(screen.getByLabelText('Your alias'), 'Rejected draft');
  f.state.response = () => json({ error: { code: 'stale_revision', message: 'RAW revision' } }, 409);
  await fireEvent.press(screen.getByTestId('community-alias-save'));
  expect(screen.getByText('The previous change was rejected because the group or membership changed.')).toBeTruthy();
  expect(screen.getByText('Previous change')).toBeTruthy();
  expect(screen.getByText('Group details are stale. Refresh to review the current membership.')).toBeTruthy();
  expect(screen.getByTestId('community-alias-save').props.accessibilityState.disabled).toBe(true);
  expect(screen.queryByText('Review current details')).toBeNull();
  const waiting = deferred(); f.state.response = () => waiting.promise;
  await fireEvent.press(screen.getByText('Refresh group details'));
  expect(screen.getByText('Loading the current group…')).toBeTruthy();
  expect(screen.getByTestId('community-alias-save').props.accessibilityState.disabled).toBe(true);
  expect(screen.queryByText('Review current details')).toBeNull();
  f.state.detail = { ...f.state.detail, revision: 5, members: [{ ...f.state.detail.members[0]!, alias: 'Current alias', revision: 11 }] };
  await act(async () => { waiting.resolve(json(f.state.detail)); });
  expect(screen.getByText('Membership details changed or are missing. Review current details before continuing.')).toBeTruthy();
  expect(screen.getByTestId('community-alias-save').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(screen.getByText('Review current details'));
  expect(screen.getByLabelText('Your alias').props.value).toBe('Current alias');
  expect(screen.getByText('You can edit and save a new alias.')).toBeTruthy();
  expect(screen.getByTestId('community-alias-save').props.accessibilityState.disabled).toBe(false);
  expect(screen.queryByText(/Refresh to review/)).toBeNull();
  expect(screen.queryByText(/Review current details before continuing/)).toBeNull();
  expect(screen.queryByText('RAW revision')).toBeNull();
  f.state.response = () => json({ ...f.state.detail.members[0]!, alias: 'Reviewed alias', revision: 12 });
  await fireEvent.changeText(screen.getByLabelText('Your alias'), 'Reviewed alias');
  await fireEvent.press(screen.getByTestId('community-alias-save'));
  expect(JSON.parse(writes(f.calls)[1].raw!)).toEqual({ alias: 'Reviewed alias', expectedRevision: 11 });
  expect(screen.getByText('Alias saved: Reviewed alias')).toBeTruthy();
});

test('new generation reusing a pending controller never adopts its late receipt while a fresh controller remains valid', async () => {
  const f = await fixture(), waiting = deferred(); f.state.response = () => waiting.promise;
  const result = await render(<AliasScreen context={f.context} />);
  const oldSave = screen.getByTestId('community-alias-save').props.onPress;
  const oldBack = screen.getByTestId('a-back').props.onPress;
  await fireEvent.changeText(screen.getByLabelText('Your alias'), 'Previous generation alias');
  await fireEvent.press(screen.getByTestId('community-alias-save'));
  f.state.generation = 2; const replacement = { ...f.context, sessionGeneration: 2 };
  await result.rerender(<AliasScreen context={replacement} />);
  expect(screen.getByText('This Community session ended.')).toBeTruthy();
  expect(screen.queryByLabelText('Your alias')).toBeNull(); expect(screen.queryByText('Synthetic group')).toBeNull();
  await act(async () => { waiting.resolve(json({ memberId: M, alias: 'Previous generation alias', role: 'owner', revision: 8 })); });
  expect(f.controller.getSnapshot().command.status).toBe('confirmed');
  expect(screen.queryByText('Alias saved: Previous generation alias')).toBeNull();
  await result.rerender(<AliasScreen context={{ ...replacement }} />);
  expect(screen.getByText('This Community session ended.')).toBeTruthy();
  f.state.generation = 1; await result.rerender(<AliasScreen context={f.context} />);
  await act(async () => { await oldSave(); oldBack(); });
  expect(screen.getByText('This Community session ended.')).toBeTruthy();
  expect(writes(f.calls)).toHaveLength(1); expect(f.onClose).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot().disposed).toBe(false);
  const fresh = await fixture(); fresh.state.generation = 2;
  await result.rerender(<AliasScreen context={{ ...fresh.context, sessionGeneration: 2 }} />);
  expect(screen.getByLabelText('Your alias').props.value).toBe('Leaf');
  expect(screen.getByTestId('community-alias-save').props.accessibilityState.disabled).toBe(false);
  expect(screen.queryByText('Alias saved: Previous generation alias')).toBeNull();
});
