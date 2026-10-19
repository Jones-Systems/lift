// Public entry for the Activity lane (root wiring imports only from here).
// Contracts, resources and drafts are owned by the parser lane; screens/model.ts is the UI presentation model.
// ActivityEntryConsumer connects authoritative reads and the root-owned draft controller without rendering.
// ActivitySlot (the renderActivity component) is intentionally not exported yet: production screens wait for a
// READY design package (docs/workstreams/form-accounts-onboarding/continuation/activity/ui/integration-contract.md).
// Until then root leaves FormAccountAppProps.renderActivity unset, so Home shows no Activity entry point.
export type * from './contracts';
export { ActivityResources } from './resources';
export type { ActivityApi, ActivityEntryQuery, ActivityListQuery } from './resources';
export { DraftController, freezeCaptureContext } from './drafts';
export type { CaptureContext, DraftPhase, DraftResult, DraftState } from './drafts';
export * from './screens/model';
export { ActivityEntryConsumer } from './entryConsumer';
export type { ActivityEntryBinding, ActivityEntryState, ActivityCaptureInput, ActivityRead, ActivityVoidIntent, ActivityScheduleInput, ActivityScheduleIntent, ActivityPersonalCreateIntent, ActivityPersonalChangeIntent, ActivityCalendarIntent } from './entryConsumer';
