import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { CommunityGroup, CommunityMember } from '../../api/community';
import type { PreviewDenial } from '../../features/syntheticPreviewContract';
import type { COM01GroupListProps, COM01MembersProps } from './contracts';
import { theme as t } from './theme';

export type NoticeCopy = Readonly<{ title: string; body: string; neutral?: boolean }>;
export type Uncertainty = 'none' | 'current' | 'original';
export const roleLabels = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;
export const kindLabels = {
  create: 'Create group', sharing: 'Sharing', ballot: 'Ballot', growth_motion: 'Growth proposal',
  finalize_growth: 'Finalize growth', remove: 'Remove member', removal_motion: 'Removal proposal',
  finalize_removal: 'Finalize removal', alias: 'Alias', role: 'Role', leave: 'Leave group',
  close: 'Close group', issue_invitation: 'Issue invitation', revoke_invitation: 'Revoke invitation',
  replace_invitation: 'Replace invitation',
} as const;
const denialCopies: Record<PreviewDenial, NoticeCopy> = {
  release_or_unknown_build: { title: 'Preview unavailable', body: 'This preview is unavailable in this build.' },
  unknown_case: { title: 'Preview unavailable', body: 'This preview case is not supported.' },
  conflicting_entry: { title: 'Preview unavailable', body: 'Conflicting preview entries were supplied.' },
  invalid_fixture: { title: 'Invalid fixture', body: 'This fixture cannot be displayed safely.' },
  foreign_identity: { title: 'Preview identity changed', body: 'This fixture does not belong to this preview.' },
  session_changed: { title: 'Preview session changed', body: 'This snapshot belongs to an earlier preview session. Close the preview.' },
  presentation_changed: { title: 'Preview changed', body: 'This snapshot belongs to an earlier presentation.' },
  selection_changed: { title: 'Selection changed', body: 'This snapshot belongs to an earlier selection.' },
  not_foreground: { title: 'Preview inactive', body: 'This preview is no longer active. Close the preview.' },
  not_current: { title: 'Snapshot unavailable', body: 'No current fixture snapshot is available.' },
  stale_revision: { title: 'Revision changed', body: 'The fixture revision no longer matches. Reload the fixture before inspecting it again.' },
  role_not_eligible: { title: 'Role preview unavailable', body: 'Only an owner fixture can preview a non-owner member’s role.' },
  command_unresolved: { title: 'Command unresolved', body: 'A command is unresolved. This preview can’t resolve it.' },
  unsupported_state: { title: 'Preview unavailable', body: 'This preview state cannot be displayed safely.' },
  clock_unavailable: { title: 'Rest unavailable', body: 'A safe rest timer is not available.' },
};
export const malformedCopy: NoticeCopy = {
  title: 'Preview unavailable', body: 'This fixture cannot be displayed safely.',
};
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function has<T extends object>(map: T, key: unknown): key is keyof T {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key);
}
export function isDenial(value: unknown): value is PreviewDenial { return has(denialCopies, value); }
export function denialCopy(reason: PreviewDenial): NoticeCopy { return denialCopies[reason]; }
export function positiveRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function textValue(value: unknown, max = Number.MAX_SAFE_INTEGER): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f<>]/u.test(value);
}
export function memberId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export function validGroup(value: unknown): value is Readonly<CommunityGroup> {
  return object(value) && memberId(value.id) && memberId(value.memberId)
    && textValue(value.name, 80) && has(roleLabels, value.role) && positiveRevision(value.revision);
}
export function validMember(value: unknown): value is Readonly<CommunityMember> {
  return object(value) && memberId(value.memberId) && textValue(value.alias, 60)
    && has(roleLabels, value.role) && positiveRevision(value.revision);
}
export function validFence(value: unknown, family: 'community' | 'rest'): boolean {
  if (!object(value) || !object(value.identity)) return false;
  const id = value.identity;
  return id.kind === 'synthetic' && id.authority === 'none'
    && id.fixtureSet === 'form.training-community.preview/v1' && id.fixtureRevision === 1
    && id.accountId === 'synthetic:form-training-community:r1'
    && textValue(value.sessionGeneration)
    && typeof value.presentationGeneration === 'number' && Number.isSafeInteger(value.presentationGeneration)
    && value.presentationGeneration >= 0
    && typeof value.selectionGeneration === 'number' && Number.isSafeInteger(value.selectionGeneration)
    && value.selectionGeneration >= 0
    && (family === 'rest' ? value.scenario === 'rest-running' || value.scenario === 'rest-paused'
      : value.scenario === 'com01-owner-current' || value.scenario === 'com01-admin-current'
        || value.scenario === 'com01-member-current' || value.scenario === 'com01-stale');
}
export function fenceReason(value: unknown, family: 'community' | 'rest'): PreviewDenial | null {
  if (!object(value)) return 'invalid_fixture';
  if (value.scenario !== 'rest-running' && value.scenario !== 'rest-paused'
    && value.scenario !== 'com01-owner-current' && value.scenario !== 'com01-admin-current'
    && value.scenario !== 'com01-member-current' && value.scenario !== 'com01-stale') return 'unsupported_state';
  return validFence(value, family) ? null : 'invalid_fixture';
}
export function commonReason(props: unknown): PreviewDenial | null {
  return !object(props) || props.authority !== 'none' || props.productionActions !== 'denied'
    || typeof props.onClose !== 'function' || typeof props.onReloadFixture !== 'function'
    ? 'invalid_fixture' : fenceReason(props.fence, 'community');
}
export function scenarioRole(scenario: string): keyof typeof roleLabels | null {
  switch (scenario) {
    case 'com01-owner-current': return 'owner';
    case 'com01-admin-current': return 'admin';
    case 'com01-member-current': return 'member';
    default: return null;
  }
}

const readStatuses = ['idle', 'loading', 'ready', 'empty', 'error', 'stale'] as const;
export type ReadStatus = typeof readStatuses[number];
export function readStatus(value: unknown): value is ReadStatus {
  return typeof value === 'string' && (readStatuses as readonly string[]).includes(value);
}
export type SafeError = Readonly<{ code: string; status: number | null; uncertainty: Uncertainty;
  uncertaintyKnown: boolean; copy: NoticeCopy; malformed: boolean }>;
const errorCodes = [
  'community_forbidden', 'community_not_found', 'community_read_unavailable', 'community_unavailable',
  'community_invalid_input', 'community_invalid_response', 'invalid_response', 'stale_revision',
  'session_changed', 'unauthenticated', 'community_membership_changed', 'community_membership_unavailable',
  'community_governed_action_required', 'community_outcome_unknown', 'community_intent_in_flight',
  'community_membership_reconcile_required', 'network_unavailable', 'transport_interrupted', 'wire_result_unknown',
] as const;
export function safeError(value: unknown): SafeError | null {
  if (!object(value)) return null;
  const malformed = typeof value.effectUnknown !== 'boolean' || typeof value.originalEffectUnknown !== 'boolean';
  const code = typeof value.code === 'string' && (errorCodes as readonly string[]).includes(value.code)
    ? value.code : 'unrecognized';
  const status = typeof value.status === 'number' && Number.isInteger(value.status)
    && value.status >= 100 && value.status <= 599 ? value.status : null;
  let copy: NoticeCopy;
  if (status === 403 || code === 'community_forbidden') copy = {
    title: 'Access denied', body: 'This fixture read or command was denied. No role preview is available.',
  };
  else if (code === 'session_changed') copy = denialCopy('session_changed');
  else if (status === 401 || code === 'unauthenticated') copy = {
    title: 'Access unavailable', body: 'Access is not available for this fixture. No role preview is available.',
  };
  else if (status === 404 || code === 'community_not_found') copy = {
    title: 'Group not found', body: 'The selected fixture group is not available. No group or member is substituted.',
  };
  else if (code === 'stale_revision') copy = denialCopy('stale_revision');
  else if (code === 'community_membership_changed') copy = {
    title: 'Membership changed', body: 'This fixture membership no longer matches the selected snapshot.',
  };
  else if (code === 'community_governed_action_required') copy = {
    title: 'Action unavailable', body: 'This preview cannot perform the required governed action.',
  };
  else if (code === 'community_invalid_input' || code === 'community_invalid_response' || code === 'invalid_response')
    copy = denialCopy('invalid_fixture');
  else if (code === 'community_outcome_unknown' || code === 'community_intent_in_flight'
    || code === 'community_membership_reconcile_required') copy = denialCopy('command_unresolved');
  else copy = {
    title: 'Preview data unavailable', body: 'No safe fixture result is available. Reloading the fixture does not retry a command.',
  };
  return { code, status, copy, malformed,
    uncertaintyKnown: !malformed || value.originalEffectUnknown === true || value.effectUnknown === true,
    uncertainty: value.originalEffectUnknown === true ? 'original' : value.effectUnknown === true ? 'current' : 'none' };
}
export function mergeUncertainty(...values: readonly Uncertainty[]): Uncertainty {
  return values.includes('original') ? 'original' : values.includes('current') ? 'current' : 'none';
}
export function uncertaintyCopy(value: Uncertainty): NoticeCopy | null {
  if (value === 'original') return { title: 'Earlier change unconfirmed', body: 'An earlier change is still unconfirmed. This preview can’t resolve it.' };
  if (value === 'current') return { title: 'Change unconfirmed', body: 'The current change is unconfirmed. This preview can’t resolve it.' };
  return null;
}
export type CommandView = Readonly<{
  reason: PreviewDenial | null;
  status: COM01MembersProps['command']['status'] | null;
  kind: string | null;
  error: SafeError | null;
  uncertainty: Uncertainty;
  uncertaintyKnown: boolean;
  idle: boolean;
  copy: NoticeCopy | null;
}>;
export function commandView(value: unknown): CommandView {
  if (!object(value)) return { reason: 'invalid_fixture', status: null, kind: null,
    error: null, uncertainty: 'none', uncertaintyKnown: false, idle: false, copy: null };
  const status = value.status === 'idle' || value.status === 'pending' || value.status === 'confirmed' || value.status === 'error'
    ? value.status : null;
  const kind = value.kind === null ? 'No command' : has(kindLabels, value.kind) ? kindLabels[value.kind] : null;
  const knownUncertainty = value.uncertainty === 'none' || value.uncertainty === 'current' || value.uncertainty === 'original';
  const error = value.error === null ? null : safeError(value.error);
  const reason = status === null || kind === null || !knownUncertainty ? 'unsupported_state'
    : value.error !== null && (!error || error.malformed) ? 'invalid_fixture' : null;
  const explicit: Uncertainty = value.uncertainty === 'original' ? 'original' : value.uncertainty === 'current' ? 'current' : 'none';
  const uncertainty = mergeUncertainty(explicit, error?.uncertainty ?? 'none');
  let copy: NoticeCopy | null = null;
  if (error) copy = error.copy;
  else if (uncertainty === 'none' && !reason) {
    switch (status) {
      case 'pending': copy = { title: 'Command pending', body: 'A command is pending. No role preview is available.' }; break;
      case 'confirmed': copy = { title: 'Command confirmed', body: 'This observation does not include a role result. Reload the fixture before another role preview.' }; break;
      case 'error': copy = { title: 'Command failed', body: 'No safe error detail is available. Reload the fixture before another role preview.' }; break;
      case 'idle': if (value.kind !== null && value.kind !== 'role') copy = {
        title: 'Role preview unavailable', body: 'This command observation is outside the role preview.',
      }; break;
    }
  }
  return { reason, status, kind,
    error, uncertainty, uncertaintyKnown: knownUncertainty || error?.uncertaintyKnown === true,
    copy, idle: !reason && status === 'idle' && (value.kind === null || value.kind === 'role')
      && value.error === null && uncertainty === 'none' };
}
export function readCopy(status: ReadStatus, members: boolean, error: SafeError | null): NoticeCopy | null {
  switch (status) {
    case 'ready': return null;
    case 'idle': return { title: members ? 'Members not loaded' : 'Groups not loaded',
      body: members ? 'Load this local fixture to inspect its members.' : 'Load this local fixture to inspect its groups.', neutral: true };
    case 'loading': return { title: members ? 'Loading members' : 'Loading groups',
      body: members ? 'The fixture read has not finished. No member count is available.' : 'The fixture read has not finished. No group count is available.', neutral: true };
    case 'empty': return { title: members ? 'No members in this fixture' : 'No groups in this fixture',
      body: members ? 'This successful fixture read contains no members.' : 'This successful fixture read contains no groups.', neutral: true };
    case 'stale': return { title: 'Snapshot stale', body: 'This fixture snapshot is stale. Reload the fixture to inspect it again.' };
    case 'error': return error?.copy ?? denialCopy('invalid_fixture');
  }
}

// Local callback observations are scoped to immutable input identity, never membership state.
export function useLocalResult(source: unknown) {
  const [, redraw] = useState(0);
  const state = useRef<{ source: unknown; notice: NoticeCopy | null; reason: PreviewDenial | null;
    requestText: string | null; blocked: boolean; taken: Set<string>; closed: boolean }>(
    { source, notice: null, reason: null, requestText: null, blocked: false, taken: new Set(), closed: false });
  if (state.current.source !== source) state.current = {
    source, notice: null, reason: null, requestText: null, blocked: false, taken: new Set(), closed: false,
  };
  const current = state.current;
  function request(key: string, callback: () => unknown, reload = false) {
    if (state.current !== current || current.closed || current.taken.has(key) || (!reload && current.blocked)) return;
    current.taken.add(key);
    let reason: PreviewDenial | null = 'unsupported_state';
    try {
      const result: unknown = callback();
      if (object(result) && result.status === 'previewed' && result.effect === 'local-only'
        && Object.keys(result).length === 2 && Object.keys(result).every(key => key === 'status' || key === 'effect')) reason = null;
      else if (object(result) && result.status === 'ignored' && isDenial(result.reason)
        && Object.keys(result).length === 2 && Object.keys(result).every(key => key === 'status' || key === 'reason')) reason = result.reason;
    } catch { reason = 'unsupported_state'; }
    if (state.current !== current || current.closed) return;
    if (reason === null) current.requestText = reload ? 'Local fixture reload requested.' : 'Local preview requested.';
    else {
      current.reason = reason;
      current.notice = denialCopy(reason);
      current.requestText = null;
      current.blocked = true;
    }
    redraw(n => n + 1);
  }
  return { ...current, request, canRequest: (key: string) => !current.closed && !current.taken.has(key),
    close: (callback: () => void) => {
      if (state.current !== current || current.closed) return;
      current.closed = true;
      if (typeof callback === 'function') callback();
    } };
}

export function PreviewText({ children, kind = 'body', id, heading = false, secondary = false, centered = false }:
  { children: ReactNode; kind?: 'body' | 'bodyStrong' | 'pageTitle' | 'sectionTitle' | 'exerciseTitle' | 'stat' | 'button' | 'meta' | 'caption';
    id?: string; heading?: boolean; secondary?: boolean; centered?: boolean }) {
  const ramps = { body: 'body', bodyStrong: 'headline', pageTitle: 'title1', sectionTitle: 'title2',
    exerciseTitle: 'headline', stat: 'title1', button: 'body', meta: 'footnote', caption: 'caption1' } as const;
  return <Text testID={id} accessibilityRole={heading ? 'header' : undefined} allowFontScaling
    dynamicTypeRamp={ramps[kind]} style={[t.type[kind], ui.text, secondary && ui.secondary, centered && ui.centerText]}>{children}</Text>;
}
export function Xmark({ ink = false }: { ink?: boolean }) {
  return <View accessible={false} importantForAccessibility="no-hide-descendants" style={ui.icon}>
    <View style={[ui.xmark, ink && ui.xmarkInk, ui.xmarkForward]} /><View style={[ui.xmark, ink && ui.xmarkInk, ui.xmarkReverse]} />
  </View>;
}
export function DismissHeader({ id, onClose }: { id: string; onClose(): void }) {
  return <View style={ui.nav}><Pressable testID={id} accessibilityRole="button"
    accessibilityLabel="Close entire synthetic preview" onPress={onClose}
    style={({ pressed }) => [ui.dismiss, pressed && ui.rowPressed]}>
    <Xmark /><Text allowFontScaling dynamicTypeRamp="body" style={[t.type.body, ui.actionText]}>Close</Text>
  </Pressable></View>;
}
export function PrimaryButton({ id, label, onPress, disabled = false }:
  { id: string; label: string; onPress(): void; disabled?: boolean }) {
  return <Pressable testID={id} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={() => { if (!disabled) onPress(); }}
    style={({ pressed }) => [ui.primary, pressed && ui.primaryPressed]}>
    <Text allowFontScaling dynamicTypeRamp="body" style={[t.type.button, ui.primaryText]}>{label}</Text>
  </Pressable>;
}
export function CloseFooter({ onClose }: { onClose(): void }) {
  return <View style={ui.footer}><PrimaryButton id="fdev-preview-close-primary" label="Close preview" onPress={onClose} /></View>;
}
export function PreviewNotice({ copy, id }: { copy: NoticeCopy; id: string }) {
  const { fontScale } = useWindowDimensions();
  return <View testID={id} accessible accessibilityLiveRegion="polite"
    style={[ui.notice, copy.neutral ? ui.neutral : ui.warning, fontScale >= 2 && ui.stacked]}>
    {!copy.neutral && <View accessible={false} importantForAccessibility="no-hide-descendants" style={ui.noticeSymbol}>
      <Text style={[t.type.bodyStrong, ui.warningText]} allowFontScaling={false}>!</Text>
    </View>}
    <View style={[ui.noticeCopy, fontScale >= 2 && ui.stackedNoticeCopy]}>
      <Text style={[t.type.bodyStrong, copy.neutral ? ui.text : ui.warningText]} allowFontScaling dynamicTypeRamp="headline">{copy.title}</Text>
      <Text style={[t.type.body, copy.neutral ? ui.text : ui.warningText]} allowFontScaling dynamicTypeRamp="body">{copy.body}</Text>
    </View>
  </View>;
}
export function NoticeStack({ base, baseId, uncertainty, readError, command, local }:
  { base: NoticeCopy | null; baseId: string; uncertainty: Uncertainty; command?: CommandView;
    readError?: SafeError | null; local: ReturnType<typeof useLocalResult> }) {
  const seen = new Set<string>();
  const rows = [
    { copy: base, id: baseId }, { copy: readError?.copy ?? null, id: 'fdev-read-error-notice' },
    { copy: uncertaintyCopy(uncertainty), id: 'fdev-command-notice' },
    { copy: command?.copy ?? null, id: uncertainty === 'none' ? 'fdev-command-notice' : 'fdev-command-error-notice' },
    { copy: local.reason === 'command_unresolved' && uncertainty !== 'none' ? null : local.notice, id: 'fdev-local-result-notice' },
  ];
  return <>{rows.map(({ copy, id }) => {
    if (!copy) return null;
    const key = `${copy.title}\n${copy.body}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return <View key={id} style={ui.sectionGap}><PreviewNotice copy={copy} id={id} /></View>;
  })}</>;
}
export function SafeMetadata({ reason, readError, command, uncertainty, localReason }:
  { reason?: string | null; readError?: SafeError | null; command?: CommandView;
    uncertainty: Uncertainty; localReason?: PreviewDenial | null }) {
  if (!reason && !localReason && !readError && !command && uncertainty === 'none') return null;
  const errorRows = (error: SafeError) => <>
    <PreviewText kind="meta" secondary>Code: {error.code}</PreviewText>
    <PreviewText kind="meta" secondary>Status: {error.status ?? 'unavailable'}</PreviewText>
  </>;
  return <View testID="fdev-safe-metadata" style={ui.metadata}>
    {reason && <PreviewText kind="meta" secondary>Reason: {reason}</PreviewText>}
    {localReason && localReason !== reason && <PreviewText kind="meta" secondary>Reason: {localReason}</PreviewText>}
    {readError && <>
      {command?.error && <PreviewText kind="bodyStrong">Read error</PreviewText>}
      {errorRows(readError)}
      {readError.uncertaintyKnown && <PreviewText kind="meta" secondary>Uncertainty: {readError.uncertainty}</PreviewText>}
    </>}
    {command && <>
      {readError && command.error && <PreviewText kind="bodyStrong">Command error</PreviewText>}
      {command.status !== null && <PreviewText kind="meta" secondary>Command status: {command.status}</PreviewText>}
      {command.kind !== null && <PreviewText kind="meta" secondary>Command kind: {command.kind}</PreviewText>}
      {command.error && errorRows(command.error)}
      {command.uncertaintyKnown && <PreviewText kind="meta" secondary>Uncertainty: {command.uncertainty}</PreviewText>}
    </>}
    {!readError && !command && uncertainty !== 'none' && <PreviewText kind="meta" secondary>Uncertainty: {uncertainty}</PreviewText>}
  </View>;
}
export function LocalMessage({ local }: { local: ReturnType<typeof useLocalResult> }) {
  return local.requestText ? <View style={ui.smallGap} accessibilityLiveRegion="polite">
    <PreviewText id="fdev-local-result" kind="meta" secondary>{local.requestText}</PreviewText>
  </View> : null;
}
export function ReloadBlock({ id, uncertainty, local, onReload }:
  { id: string; uncertainty: Uncertainty; local: ReturnType<typeof useLocalResult>; onReload(): unknown }) {
  const qualifier = uncertainty === 'none' ? 'Local fixture only. Does not retry a command.' : 'Does not retry or resolve it.';
  return <View style={ui.reload}>
    <Pressable testID={id} accessibilityRole="button" accessibilityLabel="Reload fixture only"
      accessibilityHint={qualifier} accessibilityState={{ disabled: !local.canRequest('reload') }}
      disabled={!local.canRequest('reload')} onPress={() => local.request('reload', onReload, true)}
      style={({ pressed }) => [ui.outline, pressed && ui.rowPressed]}>
      <PreviewText kind="bodyStrong">Reload fixture only</PreviewText>
    </Pressable>
    <View style={ui.center}><PreviewText id="fdev-reload-qualifier" kind="caption" secondary centered>{qualifier}</PreviewText></View>
  </View>;
}

export function COM01GroupList(props: COM01GroupListProps) {
  const local = useLocalResult(props);
  const raw: unknown = props.groups;
  const common = commonReason(props);
  let reason = common;
  let status: ReadStatus | null = object(raw) && readStatus(raw.status) ? raw.status : null;
  const error = object(raw) && raw.error !== null ? safeError(raw.error) : null;
  let rows: readonly Readonly<CommunityGroup>[] = [];
  if (!reason) {
    if (!object(raw)) reason = 'invalid_fixture';
    else if (!readStatus(raw.status)) reason = 'unsupported_state';
    else {
      status = raw.status;
      if (raw.groupId !== null || typeof props.onSelectGroup !== 'function') reason = 'invalid_fixture';
      else if (raw.status === 'ready' || raw.status === 'empty') {
        if (raw.error !== null || !Array.isArray(raw.data) || !raw.data.every(validGroup)
          || new Set(raw.data.map(row => row.id)).size !== raw.data.length
          || (raw.status === 'ready' ? raw.data.length === 0 : raw.data.length !== 0)) reason = 'invalid_fixture';
        else if (raw.status === 'ready') rows = raw.data;
      } else if (raw.data !== null || (raw.status === 'error' ? !error || error.malformed : raw.error !== null)) reason = 'invalid_fixture';
    }
  }
  const uncertainty = error?.uncertainty ?? 'none';
  const base = reason ? (common === 'invalid_fixture' ? malformedCopy : denialCopy(reason)) : status ? readCopy(status, false, error) : null;
  return <View testID="fdev-groups" style={ui.page}>
    <DismissHeader id="fdev-community-close" onClose={() => local.close(props.onClose)} />
    <View style={ui.previewLabel}><PreviewText id="fdev-preview-status" kind="caption" secondary>Synthetic preview</PreviewText></View>
    <ScrollView style={ui.scroll} contentContainerStyle={ui.content} contentInsetAdjustmentBehavior="never">
      <View style={ui.heading}>
        <PreviewText kind="pageTitle" heading>Your groups</PreviewText>
        {!reason && status === 'ready' && <PreviewText secondary>Choose a group from this local fixture.</PreviewText>}
        {status && <Text testID="fdev-read-status" accessibilityLiveRegion="polite" allowFontScaling
          dynamicTypeRamp="footnote" style={[t.type.meta, ui.secondary]}>Read status: {status}</Text>}
      </View>
      <NoticeStack base={base} baseId="fdev-read-notice" uncertainty={uncertainty} readError={error} local={local} />
      {!reason && rows.length > 0 && <View style={ui.sectionGap}>{rows.map(row =>
        <Pressable key={row.id} testID={`fdev-group-${row.id}`} accessibilityRole="button"
          accessibilityLabel={`${row.name}. Fixture role: ${roleLabels[row.role]}.`}
          accessibilityState={{ disabled: local.blocked || !local.canRequest('select') }}
          disabled={local.blocked || !local.canRequest('select')}
          onPress={() => local.request('select', () => props.onSelectGroup(row.id))}
          style={({ pressed }) => [ui.groupRow, pressed && ui.rowPressed]}>
          <Text allowFontScaling dynamicTypeRamp="headline" style={[t.type.bodyStrong, ui.actionText]}>{row.name}</Text>
          <PreviewText kind="meta" secondary>Fixture role: {roleLabels[row.role]}</PreviewText>
        </Pressable>)}</View>}
      <SafeMetadata reason={reason} readError={error} uncertainty={uncertainty} localReason={local.reason} />
      <LocalMessage local={local} />
      {!common && <ReloadBlock id="fdev-groups-reload" uncertainty={uncertainty} local={local} onReload={props.onReloadFixture} />}
    </ScrollView>
    <CloseFooter onClose={() => local.close(props.onClose)} />
  </View>;
}

export const ui = StyleSheet.create({
  page: { flex: 1, backgroundColor: t.color.canvas }, scroll: { flex: 1 },
  text: { color: t.color.ink, flexShrink: 1 }, secondary: { color: t.color.secondary },
  actionText: { color: t.color.action, flexShrink: 1 }, center: { alignItems: 'center' }, centerText: { textAlign: 'center' },
  content: { paddingHorizontal: t.layout.frame.gutter, paddingTop: t.space.s16, paddingBottom: t.checkpoint.scrollPad },
  heading: { gap: t.space.s8 }, sectionGap: { marginTop: t.space.s24 }, smallGap: { marginTop: t.space.s16 },
  nav: { marginTop: t.layout.frame.navGap, marginHorizontal: t.layout.frame.gutter, minHeight: t.layout.frame.navHeight,
    flexDirection: 'row', alignItems: 'center', gap: t.space.s12 },
  dismiss: { minHeight: t.layout.frame.minimumTarget, minWidth: t.layout.frame.minimumTarget,
    flexDirection: 'row', alignItems: 'center', gap: t.space.s4, flexShrink: 1,
    borderWidth: t.stroke.divider, borderColor: t.color.transparent },
  icon: { width: t.layout.icon.standard, height: t.layout.icon.standard, alignItems: 'center', justifyContent: 'center' },
  xmark: { position: 'absolute', width: t.iconGeometry.xmarkLine, height: t.stroke.icon, backgroundColor: t.color.action,
    borderRadius: t.radius.capsule },
  xmarkInk: { backgroundColor: t.color.ink },
  xmarkForward: { transform: [{ rotate: t.iconGeometry.xmarkRotate }] },
  xmarkReverse: { transform: [{ rotate: t.iconGeometry.xmarkReverse }] },
  previewLabel: { paddingTop: t.space.s4, paddingHorizontal: t.layout.frame.gutter, paddingBottom: t.space.s8, gap: t.space.s4 },
  footer: { paddingTop: t.space.s12, paddingHorizontal: t.layout.frame.gutter, paddingBottom: t.space.s16, gap: t.space.s8 },
  primary: { minHeight: t.layout.button.minHeight, paddingVertical: t.layout.button.paddingY,
    paddingHorizontal: t.layout.button.paddingX, borderRadius: t.radius.button, borderCurve: 'continuous',
    borderWidth: t.stroke.divider, borderColor: t.color.transparent,
    alignItems: 'center', justifyContent: 'center', backgroundColor: t.color.action },
  primaryPressed: { backgroundColor: t.color.actionPressed }, primaryText: { color: t.color.onAction, textAlign: 'center', flexShrink: 1 },
  outline: { minHeight: t.layout.frame.minimumTarget, paddingVertical: t.space.s8, paddingHorizontal: t.space.s16,
    borderRadius: t.radius.button, borderCurve: 'continuous', borderWidth: t.stroke.control,
    borderColor: t.color.controlBorder, backgroundColor: t.color.surface, alignItems: 'center', justifyContent: 'center' },
  rowPressed: { backgroundColor: t.color.selection },
  groupRow: { minHeight: t.layout.frame.minimumTarget, paddingVertical: t.space.s16, gap: t.space.s4,
    borderWidth: t.stroke.divider, borderColor: t.color.transparent, borderBottomColor: t.color.line },
  reload: { marginTop: t.space.s16, gap: t.space.s8 }, metadata: { marginTop: t.space.s16, gap: t.space.s4 },
  notice: { flexDirection: 'row', gap: t.layout.notice.iconGap, borderRadius: t.radius.notice, borderCurve: 'continuous',
    padding: t.layout.notice.padding },
  neutral: { backgroundColor: t.color.selection, padding: t.space.s20 }, warning: { backgroundColor: t.color.warningSurface },
  stacked: { flexDirection: 'column' }, noticeCopy: { flex: 1, gap: t.layout.notice.textGap, minWidth: 0 },
  stackedNoticeCopy: { flex: 0, alignSelf: 'stretch' },
  noticeSymbol: { width: t.layout.icon.standard, height: t.layout.icon.standard, borderRadius: t.radius.capsule,
    borderWidth: t.stroke.icon, borderColor: t.color.warning, alignItems: 'center', justifyContent: 'center' },
  warningText: { color: t.color.warning, flexShrink: 1 },
});
