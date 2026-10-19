import type { PresentationPolicy } from '../integration/presentationPolicy';

export type CompanionPhase = 'idle' | 'thinking' | 'retrieving' | 'responding' | 'answered' | 'ready' | 'error';
export type CompanionEvent = Readonly<{
  gen: string;
  requestId: string;
  type: 'retrieval-start' | 'retrieval-end' | 'retrieval-error' | 'stream-chunk' | 'stream-end' | 'routine-ready';
}>;
export type CompanionSnapshot = Readonly<{
  generation: string;
  requestId: string | null;
  phase: CompanionPhase;
  resultAvailable: boolean;
  decorationAllowed: boolean;
  connected: boolean;
  disposed: boolean;
}>;
export type CompanionInterruption = 'stop' | 'background' | 'user-scroll' | 'keyboard' | 'reflow' | 'anchor-unavailable';

/**
 * Unmounted, memory-only companion state for the retained premium-motion-v5 event contract.
 * The caller supplies its actual session generation and currentness guard; this component
 * neither authenticates that binding nor observes voice, network, native motion or app state.
 * Result content and actions remain caller-owned. Decoration eligibility proves no geometry
 * or animation completion, and never controls whether a routine-ready result is available.
 */
export function createCompanionLifecycle(
  binding: Readonly<{ generation: string; isCurrentSession(): boolean }>,
  presentation: PresentationPolicy,
) {
  const { generation, isCurrentSession } = binding;
  if (typeof generation !== 'string' || !generation.trim()) throw new TypeError('Session generation required');
  let visible = presentation.mascotVisible;
  let style = presentation.effectiveAnimationStyle;
  let phase: CompanionPhase = 'idle';
  let requestId: string | null = null;
  let epoch = 0;
  let active = false;
  let resultAvailable = false;
  let decorationCancelled = false;
  let connected = true;
  let disposed = false;

  function dispose() {
    if (disposed) return;
    disposed = true;
    epoch++;
    active = false;
    requestId = null;
    phase = 'idle';
    resultAvailable = false;
    decorationCancelled = true;
  }

  function current(): boolean {
    if (disposed) return false;
    try {
      if (isCurrentSession()) return true;
    } catch {
      // An unavailable caller guard cannot establish current session ownership.
    }
    dispose();
    return false;
  }

  function snapshot(): CompanionSnapshot {
    current();
    return Object.freeze({
      generation, requestId, phase, resultAvailable, connected, disposed,
      decorationAllowed: !disposed && connected && requestId !== null && visible && style !== 'static'
        && !decorationCancelled && phase !== 'idle' && phase !== 'error',
    });
  }

  function begin(nextRequestId: string) {
    if (!current() || !connected) return null;
    if (typeof nextRequestId !== 'string' || !nextRequestId.trim()) throw new TypeError('Request identity required');
    const requestEpoch = ++epoch;
    requestId = nextRequestId;
    active = true;
    resultAvailable = false;
    decorationCancelled = false;
    phase = 'thinking';

    // Retained callbacks belong to this request instance even if an external ID is reused.
    return Object.freeze({
      receive(event: CompanionEvent): boolean {
        if (!current() || !active || !connected || epoch !== requestEpoch
            || event.gen !== generation || event.requestId !== nextRequestId) return false;
        switch (event.type) {
          case 'retrieval-start': phase = 'retrieving'; break;
          case 'retrieval-end': phase = 'thinking'; break;
          case 'stream-chunk': phase = 'responding'; break;
          case 'stream-end': phase = 'answered'; break;
          case 'routine-ready':
            phase = 'ready';
            resultAvailable = true;
            active = false;
            break;
          case 'retrieval-error':
            phase = 'error';
            active = false;
            decorationCancelled = true;
            break;
          default: return false;
        }
        return true;
      },
    });
  }

  function interrupt(reason: CompanionInterruption) {
    if (!current()) return;
    decorationCancelled = true;
    if (reason === 'stop' || reason === 'background') {
      epoch++;
      active = false;
      phase = resultAvailable ? 'ready' : 'idle';
    }
  }

  function updatePresentation(next: PresentationPolicy) {
    if (!current()) return;
    if (next.mascotVisible !== visible || next.effectiveAnimationStyle !== style) {
      // A policy transition cancels this request's decoration; changing back never replays it.
      decorationCancelled = true;
    }
    visible = next.mascotVisible;
    style = next.effectiveAnimationStyle;
  }

  function connectionChanged(nextConnected: boolean) {
    if (!current() || connected === nextConnected) return;
    connected = nextConnected;
    if (!connected) {
      epoch++;
      active = false;
      decorationCancelled = true;
      phase = resultAvailable ? 'ready' : 'idle';
    }
    // Reconnection changes availability only. A new explicit begin is required for new work.
  }

  return Object.freeze({ begin, snapshot, interrupt, updatePresentation, connectionChanged, dispose });
}
