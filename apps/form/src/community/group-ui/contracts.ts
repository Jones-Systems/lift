import type { CommunityGroup, CommunityGroupDetail, CommunityMember,
  CommunityReadState, CommunityGroupCommandState } from '../../api/community';
import type { Frozen, PreviewFence, PreviewResult,
  PreviewDenial } from '../../features/syntheticPreviewContract';

type CommandObservation = Frozen<Pick<CommunityGroupCommandState,
  'status' | 'kind' | 'error'> & {
  uncertainty: 'none' | 'current' | 'original';
}>;
type Common = Readonly<{
  fence: PreviewFence;
  authority: 'none';
  productionActions: 'denied';
  onClose(): void;
}>;

export type COM01GroupListProps = Common & Readonly<{
  groups: Frozen<CommunityReadState<readonly CommunityGroup[]>>;
  onSelectGroup(groupId: string): PreviewResult;
  onReloadFixture(): PreviewResult;
}>;

export type COM01MembersProps = Common & Readonly<{
  selectedGroupId: string;
  detail: Frozen<CommunityReadState<CommunityGroupDetail>>;
  command: CommandObservation;
  onSelectMember(memberId: string): PreviewResult;
  onReloadFixture(): PreviewResult;
}>;

export type RolePreviewIntent = Readonly<{
  groupId: string;
  expectedGroupRevision: number; // selection fence, NOT role PATCH revision
  memberId: string;
  expectedMemberRevision: number;
  role: 'admin' | 'member';
}>;

type RoleSubject = Frozen<{
  group: CommunityGroup;
  target: CommunityMember;
  currentness: 'fixture-current';
}>;

export type COM01RoleState =
  | Readonly<{
      status: 'current'; subject: RoleSubject;
      eligibility: 'owner-to-non-owner-fixture';
      onPreviewRoleChange(intent: RolePreviewIntent): PreviewResult;
    }>
  | Readonly<{
      status: 'denied'; subject: RoleSubject;
      reason: 'role_not_eligible' | 'command_unresolved';
    }>
  | Readonly<{
      status: 'not-current'; subject: null;
      reason: PreviewDenial | 'idle' | 'loading' | 'stale' | 'error';
    }>;

export type COM01RoleStateProps = Common & Readonly<{
  roleState: COM01RoleState;
  command: CommandObservation;
  onReloadFixture(): PreviewResult;
}>;
