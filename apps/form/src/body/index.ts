// Public body module surface for root wiring. Contract: docs/workstreams/form-accounts-onboarding/continuation/body/ui/integration-contract.md
export { BodyFlow, type BodyFlowProps } from './BodyFlow';
export {
  BODY_CAPABILITIES, bodyPrivacySummary, isUsable, retentionGate,
  type BodyCapability, type BodyCapabilityId, type BodyChoiceRow, type BodyPrivacySummary, type CapabilityStatus,
  type RetentionDecision, type RetentionGate, type UnavailableReason,
} from './capabilities';
export type { BodyEntry } from './session';
