import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { PreviewDenial } from '../../features/syntheticPreviewContract';
import type { COM01RoleStateProps, RolePreviewIntent } from './contracts';
import { LocalMessage, NoticeStack, PreviewText, PrimaryButton, ReloadBlock, SafeMetadata, Xmark,
  commandView, commonReason, denialCopy, isDenial, malformedCopy, object, readCopy, roleLabels,
  scenarioRole, ui, useLocalResult, validGroup, validMember } from './COM01GroupList';
import type { NoticeCopy } from './COM01GroupList';
import { theme as t } from './theme';

export function COM01RoleState(props: COM01RoleStateProps) {
  const local = useLocalResult(props);
  const common = commonReason(props);
  const command = commandView(props.command);
  let reason: PreviewDenial | 'idle' | 'loading' | 'stale' | 'error' | null = common ?? command.reason;
  let subject: Exclude<COM01RoleStateProps['roleState'], { status: 'not-current' }>['subject'] | null = null;
  let current: Extract<COM01RoleStateProps['roleState'], { status: 'current' }> | null = null;
  let missing = false;
  let armDenied = false;
  const raw: unknown = props.roleState;
  if (!reason) {
    if (!object(raw)) reason = 'invalid_fixture';
    else if (raw.status !== 'current' && raw.status !== 'denied' && raw.status !== 'not-current') reason = 'unsupported_state';
    else if (raw.status === 'not-current') {
      if (raw.subject !== null) reason = 'invalid_fixture';
      else if (isDenial(raw.reason) || raw.reason === 'idle' || raw.reason === 'loading' || raw.reason === 'stale' || raw.reason === 'error') {
        reason = raw.reason;
        missing = true;
      } else reason = 'unsupported_state';
    } else {
      const candidate = raw.subject;
      if (!object(candidate) || candidate.currentness !== 'fixture-current'
        || !validGroup(candidate.group) || !validMember(candidate.target)
        || scenarioRole(props.fence.scenario) !== candidate.group.role) reason = 'invalid_fixture';
      else if (raw.status === 'current') {
        if (raw.eligibility !== 'owner-to-non-owner-fixture' || props.fence.scenario !== 'com01-owner-current'
          || candidate.group.role !== 'owner' || candidate.target.role === 'owner'
          || candidate.target.memberId === candidate.group.memberId
          || typeof raw.onPreviewRoleChange !== 'function') reason = 'invalid_fixture';
        else if (props.roleState.status === 'current') {
          subject = props.roleState.subject;
          current = props.roleState;
        }
      } else if (raw.reason !== 'role_not_eligible' && raw.reason !== 'command_unresolved') reason = 'unsupported_state';
      else if (props.roleState.status === 'denied') {
        subject = props.roleState.subject;
        reason = props.roleState.reason;
        armDenied = true;
      }
    }
  }
  let base: NoticeCopy | null = null;
  if (common === 'invalid_fixture' || command.reason === 'invalid_fixture') base = malformedCopy;
  else if (reason === 'idle') base = { title: 'Role preview not loaded', body: 'Load this local fixture to inspect a member role.' };
  else if (reason === 'loading') base = { title: 'Loading role preview', body: 'No current group or member is available yet.' };
  else if (reason === 'stale') base = readCopy('stale', true, null);
  else if (reason === 'error') base = { title: 'Role preview unavailable', body: 'No current role snapshot is available.' };
  else if (reason) base = reason === 'command_unresolved' && command.uncertainty !== 'none' ? null : denialCopy(reason);
  const eligible = current !== null && subject !== null && !armDenied && reason === null && command.idle && !local.blocked;
  const role = subject?.target.role === 'member' ? 'admin' : 'member';
  function previewRole() {
    if (!eligible || !subject || !current) return;
    const intent: RolePreviewIntent = {
      groupId: subject.group.id,
      expectedGroupRevision: subject.group.revision,
      memberId: subject.target.memberId,
      expectedMemberRevision: subject.target.revision,
      role,
    };
    const callback = current.onPreviewRoleChange;
    local.request('role', () => callback(intent));
  }
  return <View testID="fdev-role-state" style={s.page}>
    <View testID="fdev-member-sheet" accessibilityViewIsModal style={s.sheet}>
      <View accessible={false} importantForAccessibility="no-hide-descendants" style={s.handleRow}><View style={s.handle} /></View>
      <View style={s.header}>
        <View style={s.heading}>
          <PreviewText id="fdev-preview-status" kind="caption" secondary>Synthetic preview</PreviewText>
          {subject && <PreviewText id="fdev-group-name" kind="meta" secondary>{subject.group.name}</PreviewText>}
          <PreviewText id="fdev-role-title" kind="sectionTitle" heading>{subject ? subject.target.alias : 'Role preview unavailable'}</PreviewText>
        </View>
        <Pressable testID="fdev-member-close" accessibilityRole="button" accessibilityLabel="Close entire synthetic preview"
          onPress={() => local.close(props.onClose)} style={({ pressed }) => [s.close, pressed && ui.rowPressed]}><Xmark ink /></Pressable>
      </View>
      <ScrollView style={ui.scroll} contentContainerStyle={s.content} contentInsetAdjustmentBehavior="never">
        {subject && <>
          <View style={ui.heading}>
            <PreviewText kind="meta" secondary>Current fixture role</PreviewText>
            <PreviewText id="fdev-member-role" kind="bodyStrong">{roleLabels[subject.target.role]}</PreviewText>
          </View>
          <View style={s.intent}>
            <PreviewText kind="meta" secondary>Acting role in this fixture</PreviewText>
            <PreviewText id="fdev-role-actor" kind="bodyStrong">{roleLabels[subject.group.role]}</PreviewText>
          </View>
          {eligible && <View style={ui.sectionGap}><PreviewText secondary>{role === 'admin'
            ? 'Preview an admin role for this member. Group roles stay unchanged.'
            : 'Preview a member role for this member. Group roles stay unchanged.'}</PreviewText></View>}
        </>}
        {missing && <PreviewText secondary>No current group or member selected.</PreviewText>}
        <NoticeStack base={base} baseId="fdev-role-notice" uncertainty={command.uncertainty} command={command} local={local} />
        <SafeMetadata reason={reason} command={command} uncertainty={command.uncertainty} localReason={local.reason} />
        <LocalMessage local={local} />
        {!common && <ReloadBlock id="fdev-role-reload" uncertainty={command.uncertainty} local={local} onReload={props.onReloadFixture} />}
      </ScrollView>
      <View style={s.footer}>
        {eligible && subject ? <>
          <View style={ui.center}><PreviewText id="fdev-role-action-context" kind="meta" secondary centered>For {subject.target.alias}</PreviewText></View>
          <PrimaryButton id="fdev-role-preview-change" label={role === 'admin' ? 'Preview admin role' : 'Preview member role'}
            disabled={!local.canRequest('role')} onPress={previewRole} />
          <View style={ui.center}><PreviewText id="fdev-role-local-only" kind="caption" secondary centered>Local simulation only</PreviewText></View>
        </> : <PrimaryButton id="fdev-preview-close-primary" label="Close preview" onPress={() => local.close(props.onClose)} />}
      </View>
    </View>
  </View>;
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: t.color.surface },
  sheet: { flex: 1, backgroundColor: t.color.surface, borderTopLeftRadius: t.layout.sheet.topRadius,
    borderTopRightRadius: t.layout.sheet.topRadius, borderCurve: 'continuous', overflow: 'hidden' },
  handleRow: { paddingTop: t.layout.sheet.paddingTop, alignItems: 'center' },
  handle: { width: t.layout.sheet.handleWidth, height: t.layout.sheet.handleHeight,
    borderRadius: t.radius.capsule, backgroundColor: t.color.controlBorder },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: t.space.s12,
    paddingVertical: t.space.s12, paddingHorizontal: t.layout.sheet.paddingX },
  heading: { flex: 1, minWidth: 0, gap: t.space.s4 },
  close: { minWidth: t.layout.sheet.closeTarget, minHeight: t.layout.sheet.closeTarget,
    borderWidth: t.stroke.divider, borderColor: t.color.transparent, alignItems: 'center', justifyContent: 'center' },
  content: { paddingTop: t.space.s8, paddingHorizontal: t.layout.sheet.paddingX, paddingBottom: t.space.s24 },
  intent: { marginTop: t.space.s24, paddingVertical: t.space.s16, gap: t.space.s4,
    borderTopWidth: t.stroke.divider, borderBottomWidth: t.stroke.divider, borderColor: t.color.line },
  footer: { paddingVertical: t.space.s12, paddingHorizontal: t.layout.sheet.paddingX, gap: t.space.s8 },
});
