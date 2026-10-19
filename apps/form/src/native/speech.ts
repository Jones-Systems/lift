import { bindFormNativeModule, FormNativeError } from './runtime';
import type { NativeBinding, NativeSubscription } from './runtime';
import type { FormSpeechNative, ReviewedSpeechText, SpeechAvailability, SpeechDraft, SpeechError, SpeechState, SpeechSessionHook } from './speech.types';

export type * from './speech.types';
let sessionSequence = 0;

export async function getSpeechAvailability(locale: string): Promise<SpeechAvailability> {
  return probeSpeech(bindFormNativeModule<FormSpeechNative>('FormSpeech'), locale);
}

async function probeSpeech(binding: NativeBinding<FormSpeechNative>, locale: string): Promise<SpeechAvailability> {
  const unavailable = (reason: SpeechAvailability['reason']): SpeechAvailability => ({
    available: false, reason, locale, permissions: null, onDeviceSupported: false,
  });
  if (!binding.module) return unavailable(binding.reason);
  try { return await binding.module.availability(locale); }
  catch { return unavailable('native_probe_failed'); }
}

/** Capture and review only. The consuming feature owns an explicit profile apply operation. */
export class FormSpeechAdapter {
  private readonly binding: NativeBinding<FormSpeechNative>;
  private readonly subscriptions: NativeSubscription[] = [];
  private readonly observers = new Set<(draft: SpeechDraft | null) => void>();
  private draft: SpeechDraft | null = null;
  private disposed = false;
  private pendingStart: { sessionId: string; result: Promise<{ sessionId: string }> } | null = null;
  private cleanup: { sessionId: string; result: Promise<void> } | null = null;
  private nativeSessionId: string | null = null;
  private cleanupFailed = false;

  constructor(binding = bindFormNativeModule<FormSpeechNative>('FormSpeech'), private readonly shared?: SpeechSessionHook) {
    this.binding = binding;
    const native = binding.module;
    if (native) {
      this.subscriptions.push(
        native.addListener('onResult', result => {
          if (this.disposed || (this.shared && !this.shared.isCurrent()) || this.draft?.sessionId !== result.sessionId || this.draft.state === 'discarded') return;
          this.draft = { ...this.draft, text: result.text, isFinal: result.isFinal };
          this.notify();
        }),
        native.addListener('onState', state => this.receiveState(state)),
        native.addListener('onError', error => this.receiveError(error)),
      );
    }
  }

  async availability(locale: string): Promise<SpeechAvailability> {
    const unavailable = (): SpeechAvailability => ({ available: false, reason: 'shared_scope_unavailable', locale,
      permissions: null, onDeviceSupported: false });
    if (this.shared && !this.shared.isCurrent()) return unavailable();
    const result = await probeSpeech(this.binding, locale);
    return this.shared && !this.shared.isCurrent() ? unavailable() : result;
  }
  requestPermissions() {
    if (this.shared && !this.shared.isCurrent()) throw new FormNativeError('session_changed', 'The account session changed.');
    return this.native().requestPermissions();
  }
  getDraft(): SpeechDraft | null { return this.shared && !this.shared.isCurrent() ? null : this.draft ? { ...this.draft, error: this.draft.error ? { ...this.draft.error } : null } : null; }
  subscribe(observer: (draft: SpeechDraft | null) => void): NativeSubscription {
    this.observers.add(observer);
    observer(this.getDraft());
    return { remove: () => { this.observers.delete(observer); } };
  }

  async start(locale: string): Promise<string> {
    const native = this.native();
    if (this.cleanupFailed) throw new FormNativeError('audio_cleanup_failed', 'Previous capture cleanup is unresolved.');
    if (this.pendingStart || this.cleanup || (this.draft && ['starting', 'recording', 'stopping'].includes(this.draft.state))) {
      throw new FormNativeError('busy', 'Another capture is active.');
    }
    const id = `form-speech-${Date.now()}-${++sessionSequence}`;
    this.draft = { sessionId: id, locale, text: '', isFinal: false, state: 'starting', error: null };
    this.notify();
    try {
      const availability = await this.availability(locale);
      if (this.disposed || this.draft?.sessionId !== id || this.draft.state !== 'starting') {
        throw new FormNativeError('cancelled', 'Capture was cancelled before starting.');
      }
      if (!availability.available) throw new FormNativeError(availability.reason, 'On-device speech is unavailable.');
      this.nativeSessionId = id;
      const result = Promise.resolve().then(() => {
        if (this.isSessionCancelled(id)) throw new FormNativeError('cancelled', 'Capture was cancelled before starting.');
        return this.shared ? this.shared.start(locale, id) : native.start(locale, id);
      });
      this.pendingStart = { sessionId: id, result };
      const started = await result;
      if (started.sessionId !== id) throw new FormNativeError('stale_session', 'Native capture returned a different session.');
      if (this.isSessionCancelled(id)) throw new FormNativeError('cancelled', 'Capture was cancelled while starting.');
      return id;
    } catch (error) {
      if (this.draft?.sessionId === id) this.discard();
      if (this.nativeSessionId === id) await this.releaseSession(id);
      throw error;
    } finally {
      if (this.pendingStart?.sessionId === id) this.pendingStart = null;
    }
  }

  async stop(): Promise<void> {
    if (this.draft?.state === 'recording') {
      if (this.shared) await this.shared.stop(this.draft.sessionId);
      else await this.native().stop(this.draft.sessionId);
    }
  }

  async cancel(): Promise<void> {
    const id = this.nativeSessionId ?? this.draft?.sessionId;
    this.discard();
    if (id && this.binding.module) await this.releaseSession(id);
  }

  acceptReview(review: { sessionId: string; text: string; reviewed: true }): ReviewedSpeechText {
    const draft = this.draft;
    if (this.disposed || (this.shared && !this.shared.isCurrent()) || !draft || draft.sessionId !== review.sessionId || draft.state !== 'review' || !draft.isFinal || draft.error) {
      throw new FormNativeError('review_unavailable', 'A completed speech draft is required.');
    }
    const text = review.text.trim();
    if (review.reviewed !== true || !text || text.length > 12000) throw new FormNativeError('invalid_review', 'Review a nonempty bounded transcript.');
    const accepted: ReviewedSpeechText = { source: 'apple_on_device', sessionId: draft.sessionId, locale: draft.locale, text, reviewed: true };
    this.discard();
    return accepted;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    try { await this.cancel(); }
    finally {
      this.subscriptions.forEach(subscription => subscription.remove());
      this.observers.clear();
      this.draft = null;
      this.shared?.onDispose?.();
    }
  }

  private releaseSession(id: string): Promise<void> {
    if (this.cleanup) return this.cleanup.result;
    const native = this.binding.module;
    if (!native) return Promise.resolve();
    const starting = this.pendingStart?.sessionId === id ? this.pendingStart.result : null;
    const cancel = () => this.shared ? this.shared.cancel(id) : native.cancel(id);
    // Wait for the native/session-hook operation, never adapter start(): it also awaits this cleanup.
    const result = Promise.resolve().then(async () => {
      let initialFailure: unknown;
      let initiallyFailed = false;
      try { await cancel(); }
      catch (error) { initiallyFailed = true; initialFailure = error; }
      if (starting) {
        await starting.catch(() => undefined);
        // A late native start can reacquire audio after the first cancellation.
        await cancel();
      }
      if (initiallyFailed) throw initialFailure;
      this.cleanupFailed = false;
      if (this.nativeSessionId === id) this.nativeSessionId = null;
    }).catch(error => {
      this.nativeSessionId = id;
      this.cleanupFailed = true;
      throw error;
    }).finally(() => { this.cleanup = null; });
    this.cleanup = { sessionId: id, result };
    return result;
  }

  private native(): FormSpeechNative {
    if (this.disposed) throw new FormNativeError('module_destroyed', 'Speech adapter was disposed.');
    if (!this.binding.module) throw new FormNativeError(this.binding.reason, 'Form speech requires a native iOS build.');
    return this.binding.module;
  }
  private isSessionCancelled(id: string): boolean {
    return this.disposed || (this.shared && !this.shared.isCurrent()) || this.draft?.sessionId !== id || this.draft.state === 'discarded';
  }
  private receiveState(event: SpeechState): void {
    if (this.disposed || (this.shared && !this.shared.isCurrent()) || !this.draft || this.draft.sessionId !== event.sessionId || this.draft.state === 'discarded') return;
    if (event.state === 'ended' && this.shared) {
      const id = event.sessionId;
      const reviewable = event.reason === 'final' && this.draft.isFinal && !this.draft.error;
      if (reviewable) { this.draft = { ...this.draft, state: 'stopping' }; this.notify(); }
      else this.discard();
      // An ended event preserves review intent, but only shared local cleanup releases ownership.
      void this.releaseSession(id).then(() => {
        if (reviewable && !this.isSessionCancelled(id) && this.draft?.sessionId === id && !this.draft.error) {
          this.draft = { ...this.draft, state: 'review' }; this.notify();
        }
      }).catch(() => this.receiveError({ sessionId: id, code: 'audio_cleanup_failed', message: 'Audio cleanup is incomplete.' }));
      return;
    }
    if (event.state === 'ended') {
      if (event.reason === 'final' && this.draft.isFinal && !this.draft.error) this.draft = { ...this.draft, state: 'review' };
      else { this.discard(); return; }
    } else { this.draft = { ...this.draft, state: event.state }; }
    this.notify();
  }
  private receiveError(error: SpeechError): void {
    if (this.disposed || this.draft?.sessionId !== error.sessionId) return;
    if (error.code === 'audio_cleanup_failed') { this.cleanupFailed = true; this.nativeSessionId = error.sessionId; }
    this.draft = { ...this.draft, text: '', isFinal: false, state: 'discarded', error };
    this.notify();
  }
  private discard(): void {
    if (this.draft) this.draft = { ...this.draft, text: '', isFinal: false, state: 'discarded' };
    this.notify();
  }
  private notify(): void { for (const observer of this.observers) observer(this.getDraft()); }
}
