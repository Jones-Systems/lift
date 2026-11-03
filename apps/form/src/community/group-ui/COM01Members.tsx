import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { CommunityGroupDetail } from '../../api/community';
import type { Frozen, PreviewDenial } from '../../features/syntheticPreviewContract';
import type { COM01MembersProps } from './contracts';
import { CloseFooter, DismissHeader, LocalMessage, NoticeStack, PreviewText, ReloadBlock,
  SafeMetadata, commandView, commonReason, denialCopy, malformedCopy, memberId, mergeUncertainty,
  object, readCopy, readStatus, roleLabels, safeError, scenarioRole, ui, useLocalResult,
  validGroup, validMember } from './COM01GroupList';
import type { ReadStatus, SafeError } from './COM01GroupList';
import { theme as t } from './theme';

export function COM01Members(props: COM01MembersProps) {
  const local = useLocalResult(props);
  const { fontScale } = useWindowDimensions();
  const command = commandView(props.command);
  const common = commonReason(props);
  let reason: PreviewDenial | null = common ?? command.reason;
  const raw: unknown = props.detail;
  let status: ReadStatus | null = object(raw) && readStatus(raw.status) ? raw.status : null;
  const error: SafeError | null = object(raw) && raw.error !== null ? safeError(raw.error) : null;
  let detail: Frozen<CommunityGroupDetail> | null = null;
  if (!reason) {
    if (!object(raw) || !memberId(props.selectedGroupId) || typeof props.onSelectMember !== 'function') reason = 'invalid_fixture';
    else if (!readStatus(raw.status)) reason = 'unsupported_state';
    else {
      status = raw.status;
      if (raw.groupId !== null && !memberId(raw.groupId)) reason = 'invalid_fixture';
      else if (raw.groupId !== null && raw.groupId !== props.selectedGroupId) reason = 'not_current';
      else if (raw.status === 'ready' || raw.status === 'empty') {
        const data = raw.data;
        const group = data;
        if (raw.groupId !== props.selectedGroupId || !validGroup(group) || group.id !== props.selectedGroupId
          || raw.error !== null || !object(data) || !Array.isArray(data.members)
          || !data.members.every(validMember) || data.members.length > 50
          || new Set(data.members.map(row => row.memberId)).size !== data.members.length) reason = 'invalid_fixture';
        else if (raw.status === 'empty') {
          if (data.members.length !== 0) reason = 'invalid_fixture';
        } else {
          const own = data.members.filter(row => row.memberId === group.memberId);
          if (data.members.length === 0 || own.length !== 1 || own[0].role !== group.role) reason = 'invalid_fixture';
          else if (props.fence.scenario === 'com01-stale') reason = 'not_current';
          else if (scenarioRole(props.fence.scenario) !== group.role) reason = 'invalid_fixture';
          else if (props.detail.status === 'ready') detail = props.detail.data;
        }
      } else if (raw.data !== null || (raw.status === 'error' ? !error || error.malformed : raw.error !== null)) reason = 'invalid_fixture';
    }
  }
  const uncertainty = mergeUncertainty(error?.uncertainty ?? 'none', command.uncertainty);
  const base = reason ? (common === 'invalid_fixture' || command.reason === 'invalid_fixture'
    ? malformedCopy : denialCopy(reason)) : status ? readCopy(status, true, error) : null;
  const selectable = detail !== null && command.idle && !local.blocked && local.canRequest('select');
  const own = detail?.members.find(row => row.memberId === detail.memberId);
  const blockedHelp = !command.idle || local.blocked;
  return <View testID="fdev-members" style={ui.page}>
    <DismissHeader id="fdev-community-close" onClose={() => local.close(props.onClose)} />
    <View style={ui.previewLabel}>
      {detail && <PreviewText id="fdev-group-name" kind="meta" secondary>{detail.name}</PreviewText>}
      <PreviewText id="fdev-preview-status" kind="caption" secondary>Synthetic preview</PreviewText>
      {detail && own && <PreviewText id="fdev-members-actor" kind="meta" secondary>
        Fixture actor: {own.alias} ({roleLabels[detail.role]})
      </PreviewText>}
    </View>
    <ScrollView style={ui.scroll} contentContainerStyle={ui.content} contentInsetAdjustmentBehavior="never">
      <View style={ui.heading}>
        <PreviewText kind="pageTitle" heading>Members</PreviewText>
        {detail && <PreviewText secondary>{detail.members.length} {detail.members.length === 1 ? 'member in this fixture.' : 'members in this fixture.'}</PreviewText>}
        {status && <Text testID="fdev-read-status" accessibilityLiveRegion="polite" allowFontScaling
          dynamicTypeRamp="footnote" style={[t.type.meta, ui.secondary]}>Read status: {status}</Text>}
      </View>
      {detail && <View testID="fdev-members-list" style={s.roster}>{detail.members.map(row => {
        const isOwn = row.memberId === detail.memberId;
        const label = roleLabels[row.role];
        const content = <>
          {fontScale < 2 && <View accessible={false} importantForAccessibility="no-hide-descendants" style={s.avatar}>
            <Text style={[t.type.bodyStrong, ui.text]}>{initials(row.alias)}</Text>
          </View>}
          <View style={s.memberCopy}>
            <PreviewText kind="bodyStrong">{row.alias}</PreviewText>
            <PreviewText kind="meta" secondary>{label}{isOwn ? ' (fixture actor)' : ''}</PreviewText>
          </View>
          {!isOwn && selectable && <View accessible={false} importantForAccessibility="no-hide-descendants" style={s.arrowTarget}>
            <View style={s.chevron} />
          </View>}
        </>;
        return !isOwn && selectable ? <Pressable key={row.memberId} testID={`fdev-member-${row.memberId}`}
          accessibilityRole="button" accessibilityLabel={`${row.alias}. ${label}. Inspect fixture role.`}
          onPress={() => local.request('select', () => props.onSelectMember(row.memberId))}
          style={({ pressed }) => [s.member, pressed && ui.rowPressed]}>{content}</Pressable>
          : <View key={row.memberId} testID={`fdev-member-${row.memberId}`} accessible
            accessibilityLabel={isOwn ? `${row.alias}. ${label}. Fixture actor.` : `${row.alias}. ${label}.`}
            style={s.member}>{content}</View>;
      })}</View>}
      {detail && <View style={s.help}>
        <PreviewText kind="bodyStrong">{blockedHelp ? 'Role preview unavailable' : detail.role === 'owner' ? 'Practice a role change' : 'Inspect member roles'}</PreviewText>
        <PreviewText secondary>{blockedHelp ? 'Resolve the current fixture observation before selecting another member.'
          : detail.role === 'owner' ? 'Choose a member to inspect a local role preview.'
            : detail.role === 'admin' ? 'Role simulation is unavailable for an admin fixture.'
              : 'Role simulation is unavailable for a member fixture.'}</PreviewText>
        {!blockedHelp && detail.role === 'owner' && <PreviewText kind="meta" secondary>This preview doesn’t change anyone’s group role.</PreviewText>}
      </View>}
      <NoticeStack base={base} baseId="fdev-read-notice" uncertainty={uncertainty} readError={error} command={command} local={local} />
      <SafeMetadata reason={reason} readError={error} command={command} uncertainty={uncertainty} localReason={local.reason} />
      <LocalMessage local={local} />
      {!common && <ReloadBlock id="fdev-members-reload" uncertainty={uncertainty} local={local} onReload={props.onReloadFixture} />}
    </ScrollView>
    <CloseFooter onClose={() => local.close(props.onClose)} />
  </View>;
}

function initials(alias: string) {
  const words = alias.trim().split(/\s+/u);
  return [words[0], ...(words.length > 1 ? [words[words.length - 1]] : [])]
    .map(word => Array.from(word)[0]).join('').toLocaleUpperCase();
}

const s = StyleSheet.create({
  roster: { marginTop: t.space.s20 },
  member: { flexDirection: 'row', alignItems: 'center', minHeight: t.checkpoint.rosterRow,
    gap: t.space.s12, paddingVertical: t.space.s12, borderWidth: t.stroke.divider,
    borderColor: t.color.transparent, borderBottomColor: t.color.line },
  memberCopy: { flex: 1, minWidth: 0, gap: t.space.s2 },
  avatar: { width: t.checkpoint.memberAvatar, height: t.checkpoint.memberAvatar, borderRadius: t.radius.capsule,
    backgroundColor: t.color.selection, alignItems: 'center', justifyContent: 'center' },
  arrowTarget: { width: t.layout.frame.minimumTarget, height: t.layout.frame.minimumTarget, alignItems: 'center', justifyContent: 'center' },
  chevron: { width: t.iconGeometry.chevronSide, height: t.iconGeometry.chevronSide,
    borderRightWidth: t.stroke.icon, borderBottomWidth: t.stroke.icon, borderColor: t.color.action,
    transform: [{ rotate: t.iconGeometry.chevronRotate }] },
  help: { paddingTop: t.space.s24, gap: t.space.s8 },
});
