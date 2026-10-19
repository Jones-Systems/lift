import type { CaptureChoice, CaptureChoiceComposition, CaptureChoiceSource, CaptureFence, CapturePurposeChoice, CaptureScope } from './types';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function copyPurpose(value: unknown): CapturePurposeChoice | null {
  const choice = record(value);
  if (!choice || Object.keys(choice).sort().join(',') !== 'choice,consentVersion') return null;
  if (choice.choice === 'session_only' && choice.consentVersion === null) {
    return Object.freeze({ choice: 'session_only', consentVersion: null });
  }
  if (choice.choice === 'retain' && typeof choice.consentVersion === 'string'
    && choice.consentVersion.trim().length > 0 && choice.consentVersion.length <= 128) {
    return Object.freeze({ choice: 'retain', consentVersion: choice.consentVersion });
  }
  return null;
}

export function snapshotCaptureChoice(value: unknown): CaptureChoice | null {
  const choices = record(value);
  if (!choices || Object.keys(choices).sort().join(',') !== 'derived,photos') return null;
  const photos = copyPurpose(choices.photos), derived = copyPurpose(choices.derived);
  return photos && derived ? Object.freeze({ photos, derived }) : null;
}

// Copy each original consent version verbatim. Composition grants neither capture readiness nor storage permission.
export function composeCaptureChoice(source: CaptureChoiceSource, fence: CaptureFence): CaptureChoiceComposition {
  const validFence = (value: CaptureFence) => value && typeof value.accountId === 'string'
    && value.accountId.trim().length > 0 && value.accountId.length <= 128
    && Number.isSafeInteger(value.generation) && value.generation >= 0;
  if (!validFence(fence) || !source || !validFence(source)
    || source.accountId !== fence.accountId || source.generation !== fence.generation) {
    return Object.freeze({ status: 'blocked', reason: 'stale_session' });
  }
  const choice = snapshotCaptureChoice(source.choices);
  return choice ? Object.freeze({ status: 'ready', choice })
    : Object.freeze({ status: 'blocked', reason: 'explicit_choice_required' });
}

export function snapshotCaptureScope(value: CaptureScope, fence: CaptureFence): CaptureScope | null {
  if (!value || Object.keys(value).sort().join(',') !== 'accountId,choices,generation,shellSessionGeneration'
    || typeof value.shellSessionGeneration !== 'string' || value.shellSessionGeneration.length === 0) return null;
  const composed = composeCaptureChoice(value, fence);
  return composed.status === 'ready' ? Object.freeze({ accountId: fence.accountId, generation: fence.generation,
    shellSessionGeneration: value.shellSessionGeneration, choices: composed.choice }) : null;
}
