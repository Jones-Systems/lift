import type { CommunityPost, CommunityPostsController, CommunityPostsSnapshot } from '../../api/community';

/** The host owns the controller and supplies a fresh one for each auth generation. */
export type CheckinsContext = Readonly<{
  controller: CommunityPostsController;
  groupId: string;
  sessionGeneration: number;
  isCurrentSession: (generation: number) => boolean;
  onClose: () => void;
}>;

export type CheckinsStatus = CommunityPostsSnapshot['page']['status'] | 'disposed' | 'sessionended';
export type CheckinsNotice = Readonly<{ kind: 'info' | 'warning' | 'error'; text: string }>;
export type CheckinsRow = Readonly<{
  id: string;
  state: CommunityPost['state'];
  label: string;
  notice: string | null;
  alias: string | null;
  text: string | null;
  template: string | null;
  createdAt: string | null;
  expiresAt: string | null;
}>;
export type CheckinsView = Readonly<{
  status: CheckinsStatus;
  rows: readonly CheckinsRow[];
  nextCursor: string | null;
  busy: boolean;
  canRefresh: boolean;
  canNext: boolean;
  canClose: boolean;
  notice: CheckinsNotice;
  commandNotice: CheckinsNotice | null;
}>;
export interface CheckinsPresentation {
  getSnapshot(): CheckinsView;
  subscribe(listener: () => void): { remove(): void };
  attach(): void;
  detach(): void;
  refresh(): Promise<void>;
  next(): Promise<void>;
  close(): void;
}
export type CheckinsRendererProps = Readonly<{ context: CheckinsContext }>;
