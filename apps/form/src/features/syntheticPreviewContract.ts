/** Type-only synthetic preview DTOs. No admission gate or live lease is implemented here. */
export type FixtureCase =
  | 'rest-running' | 'rest-paused'
  | 'com01-owner-current' | 'com01-admin-current'
  | 'com01-member-current' | 'com01-stale';

export type PreviewIdentity = Readonly<{
  kind: 'synthetic';
  fixtureSet: 'form.training-community.preview/v1';
  fixtureRevision: 1;
  accountId: 'synthetic:form-training-community:r1';
  authority: 'none';
}>;

export type PreviewFence = Readonly<{
  identity: PreviewIdentity;
  scenario: FixtureCase;
  sessionGeneration: string; // preview-local, not an auth/session token
  presentationGeneration: number;
  selectionGeneration: number;
}>;

export type PreviewDenial =
  | 'release_or_unknown_build' | 'unknown_case' | 'conflicting_entry'
  | 'invalid_fixture' | 'foreign_identity' | 'session_changed'
  | 'presentation_changed' | 'selection_changed' | 'not_foreground'
  | 'not_current' | 'stale_revision' | 'role_not_eligible'
  | 'command_unresolved' | 'unsupported_state' | 'clock_unavailable';

export type PreviewResult =
  | Readonly<{ status: 'previewed'; effect: 'local-only' }>
  | Readonly<{ status: 'ignored'; reason: PreviewDenial }>;

export type Frozen<T> = T extends readonly (infer U)[]
  ? readonly Frozen<U>[]
  : T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;

/** An admitted DTO carries provenance only; a future live lease remains host-private. */
export type PreviewAdmission =
  | Readonly<{ status: 'off' }>
  | Readonly<{ status: 'denied'; reason: PreviewDenial }>
  | Readonly<{ status: 'admitted'; fence: PreviewFence }>;
