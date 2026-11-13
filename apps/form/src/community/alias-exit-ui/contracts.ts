import type { CommunityGroupController } from '../../api/community';

export type AliasExitMode = 'alias' | 'leave' | 'close';

/** Caller owns the controller and must replace this binding when its session changes. */
export type AliasExitContext = Readonly<{
  controller: CommunityGroupController;
  groupId: string;
  sessionGeneration: number;
  isCurrentSession: (generation: number) => boolean;
  onClose: () => void;
}>;

export type AliasExitNotice = Readonly<{
  kind: 'info' | 'warning' | 'error' | 'success';
  text: string;
}>;

export type AliasExitView = Readonly<{
  ended: boolean;
  mode: AliasExitMode;
  detailStatus: 'idle' | 'loading' | 'stale' | 'ready' | 'empty' | 'error';
  groupName: string | null;
  draft: string;
  canEdit: boolean;
  canSubmit: boolean;
  canRefresh: boolean;
  canReview: boolean;
  canClose: boolean;
  canRetry: boolean;
  pending: boolean;
  unresolved: boolean;
  receipt: string | null;
  notice: AliasExitNotice | null;
}>;

export interface AliasExitPresentation {
  getSnapshot(): AliasExitView;
  subscribe(listener: () => void): { remove(): void };
  attach(): void;
  detach(): void;
  setDraft(value: string): void;
  review(): void;
  refresh(): Promise<void>;
  submit(): Promise<void>;
  retry(): Promise<void>;
  close(): void;
}
