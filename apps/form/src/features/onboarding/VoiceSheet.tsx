// OB-08 VoiceSheet: permission / listening / review / denied / unavailable. On-device Apple recognition only;
// there is no server or Grok fallback. Only reviewed text leaves this sheet.
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { SpeechAvailability, SpeechDraft } from '../../native/speech.types';
import type { SpeechPort } from '../contract';
import { COPY, speechUnavailableCopy } from '../shared/copy';
import { Icon } from '../shared/icons';
import { L, t } from '../shared/tokens';
import { Notice, PlainAction, PrimaryAction, Sheet, Txt } from '../shared/ui';
import { typeStyles } from '../../variants/a/theme';

const LOCALE = 'en-US';
const LOCALE_NAME = 'English (US)';

type State =
  | { kind: 'checking' }
  | { kind: 'permission' }
  | { kind: 'listening'; draft: SpeechDraft | null }
  | { kind: 'review'; draft: SpeechDraft; text: string }
  | { kind: 'denied' }
  | { kind: 'unavailable' }
  | { kind: 'missed' };

type Capture = { generation: number; sessionId: string | null; drafts: Map<string, SpeechDraft> };

function classify(a: SpeechAvailability): State {
  if (a.available) return { kind: 'listening', draft: null };
  const p = a.permissions;
  if (a.reason === 'permission_denied' || p?.microphone === 'denied' || p?.speech === 'denied'
    || p?.microphone === 'restricted' || p?.speech === 'restricted') return { kind: 'denied' };
  if (a.reason === 'permission_required' || a.reason === 'permission_unknown'
    || p?.microphone === 'undetermined' || p?.speech === 'undetermined') return { kind: 'permission' };
  return { kind: 'unavailable' };
}

export function VoiceSheet({ visible, speech, onUse, onClose, onOpenSettings, maxLength = 12000 }: {
  visible: boolean;
  speech: SpeechPort;
  onUse: (text: string) => void;
  onClose: () => void;
  onOpenSettings?: () => void;
  maxLength?: number;
}) {
  const [state, setState] = useState<State>({ kind: 'checking' });
  const reviewLimit = Math.min(maxLength, 12000);
  const generation = useRef(0);
  const capture = useRef<Capture | null>(null);
  const isCurrent = (attempt: Capture) => generation.current === attempt.generation && capture.current === attempt;
  const nextCapture = (): Capture => {
    const attempt = { generation: generation.current, sessionId: null, drafts: new Map<string, SpeechDraft>() };
    capture.current = attempt;
    return attempt;
  };
  const showDraft = (draft: SpeechDraft) => {
    if (draft.error) { setState({ kind: 'missed' }); return; }
    if (draft.state === 'review') setState({ kind: 'review', draft, text: draft.text });
    else if (draft.state === 'starting' || draft.state === 'recording' || draft.state === 'stopping') setState({ kind: 'listening', draft });
  };
  const begin = async (attempt: Capture) => {
    try {
      const next = classify(await speech.availability(LOCALE));
      if (!isCurrent(attempt)) return;
      setState(next);
      if (next.kind === 'listening') {
        const sessionId = await speech.start(LOCALE);
        if (!isCurrent(attempt)) return;
        attempt.sessionId = sessionId;
        const draft = attempt.drafts.get(sessionId);
        attempt.drafts.clear();
        if (draft) showDraft(draft);
      }
    } catch {
      if (isCurrent(attempt)) { capture.current = null; setState({ kind: 'unavailable' }); }
    }
  };

  useEffect(() => {
    if (!visible) return;
    const presentation = ++generation.current;
    const attempt = nextCapture();
    setState({ kind: 'checking' });
    const sub = speech.subscribe((draft) => {
      const active = capture.current;
      if (generation.current !== presentation || !active || !draft) return;
      // The adapter emits synchronously before start resolves; only its returned session may be shown.
      if (active.sessionId === null) active.drafts.set(draft.sessionId, draft);
      else if (draft.sessionId === active.sessionId) showDraft(draft);
    });
    void begin(attempt);
    return () => { ++generation.current; capture.current = null; sub.remove(); void speech.cancel().catch(() => undefined); };
    // Each presentation owns its subscription and capture attempts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, speech]);

  const dismiss = () => { ++generation.current; capture.current = null; void speech.cancel().catch(() => undefined); onClose(); };
  const allow = async () => {
    if (!capture.current) return;
    const attempt = nextCapture();
    try { await speech.requestPermissions(); } catch { /* re-check below */ }
    if (isCurrent(attempt)) await begin(attempt);
  };
  const retry = async () => {
    if (!capture.current) return;
    const attempt = nextCapture();
    try { await speech.cancel(); } catch { /* availability is checked again below */ }
    if (isCurrent(attempt)) await begin(attempt);
  };
  const stop = async () => {
    const attempt = capture.current;
    if (!attempt?.sessionId) return;
    try { await speech.stop(); }
    catch { if (isCurrent(attempt)) setState({ kind: 'missed' }); }
  };
  const use = () => {
    if (state.kind !== 'review' || !state.text.trim() || state.text.length > reviewLimit
      || capture.current?.sessionId !== state.draft.sessionId) return;
    try {
      const reviewed = speech.acceptReview({ sessionId: state.draft.sessionId, text: state.text, reviewed: true });
      ++generation.current; capture.current = null;
      onUse(reviewed.text);
    } catch { setState({ kind: 'missed' }); }
  };

  const titles: Record<State['kind'], string> = {
    checking: 'Answer with your voice', permission: 'Answer with your voice', listening: 'Listening',
    review: 'Check what we heard', denied: 'Microphone is off', unavailable: 'Voice isn’t available', missed: 'Listening',
  };

  return (
    <Sheet visible={visible} title={titles[state.kind]} onClose={dismiss} closeTestID="a-voice-close" testID="a-voice-sheet"
      actions={<Actions state={state} onAllow={() => void allow()} onDone={() => void stop()} onCancel={dismiss}
        maxLength={reviewLimit} onUse={use} onRetry={() => void retry()} onTypeInstead={dismiss} onOpenSettings={onOpenSettings} />}>
      {state.kind === 'permission' || state.kind === 'checking' ? (
        <>
          <Txt role="body">When available, Apple’s on-device speech recognition creates text for you to review.</Txt>
          <Txt role="meta" tone="secondary">Form does not create an audio file or upload audio in this flow. iPhone and iOS persistence remain unverified. Your device will ask for microphone and speech permissions.</Txt>
        </>
      ) : null}
      {state.kind === 'listening' ? (
        <>
          {/* No audio-level API exists on the adapter, so the static "Listening" presentation is used (DGR-012). */}
          <View testID="a-voice-live" style={s.live}>
            <View style={s.disc} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Icon name="mic" size={L.icon.standard} color={t.color.onAction} />
            </View>
            <Txt role="bodyStrong" style={s.flex}>Listening</Txt>
          </View>
          <Txt role="body" testID="a-voice-partial" accessibilityLiveRegion="polite" style={s.liveText}>{state.draft?.text ?? ''}</Txt>
        </>
      ) : null}
      {state.kind === 'review' ? (
        <>
          <TextInput testID="a-voice-transcript" value={state.text} multiline autoFocus accessibilityLabel="Transcript"
            onChangeText={(text) => setState({ ...state, text })} selectionColor={t.color.action}
            style={[typeStyles.body, s.transcript]} />
          <Txt role="meta" tone="secondary">Edit anything we got wrong.</Txt>
          {state.text.length > reviewLimit ? (
            <Notice kind="error" text={`Shorten this answer to ${reviewLimit} characters before using it.`} captureId="a-voice-error" announce />
          ) : null}
        </>
      ) : null}
      {state.kind === 'denied' || state.kind === 'unavailable' ? (
        <View style={s.live}>
          <View style={[s.disc, s.discOff]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Icon name="mic-off" size={L.icon.standard} color={t.color.secondary} />
          </View>
          <Txt role="body" style={s.flex}>{state.kind === 'denied' ? COPY.speechDenied : speechUnavailableCopy(LOCALE_NAME)}</Txt>
        </View>
      ) : null}
      {state.kind === 'missed' ? <Notice kind="error" text={COPY.speechMissed} captureId="a-voice-error" announce /> : null}
    </Sheet>
  );
}

function Actions({ state, onAllow, onDone, onCancel, onUse, onRetry, onTypeInstead, onOpenSettings, maxLength }: {
  state: State; onAllow: () => void; onDone: () => void; onCancel: () => void; onUse: () => void;
  onRetry: () => void; onTypeInstead: () => void; onOpenSettings?: () => void;
  maxLength: number;
}) {
  switch (state.kind) {
    case 'checking':
    case 'permission':
      return (
        <>
          <PrimaryAction label="Allow microphone" captureId="a-voice-allow" onPress={onAllow} loading={state.kind === 'checking'} />
          <PlainAction label="Type instead" captureId="a-voice-type" chevron={null} placement="centered" onPress={onTypeInstead} />
        </>
      );
    case 'listening':
      return (
        <>
          <PrimaryAction label="Done" icon="check" captureId="a-voice-done" onPress={onDone} disabled={state.draft?.state !== 'recording'} />
          <PlainAction label="Cancel" captureId="a-voice-cancel" chevron={null} placement="centered" onPress={onCancel} />
        </>
      );
    case 'review':
      return (
        <>
          <PrimaryAction label="Use this" captureId="a-voice-use" onPress={onUse} disabled={!state.text.trim() || state.text.length > maxLength} />
          <PlainAction label="Try again" captureId="a-voice-retry" chevron={null} placement="centered" lead="undo-2" onPress={onRetry} />
        </>
      );
    case 'missed':
      return (
        <>
          <PrimaryAction label="Try again" captureId="a-voice-retry" onPress={onRetry} />
          <PlainAction label="Type instead" captureId="a-voice-type" chevron={null} placement="centered" onPress={onTypeInstead} />
        </>
      );
    case 'denied':
      return (
        <>
          {onOpenSettings ? <PrimaryAction label="Open Settings" captureId="a-voice-settings" onPress={onOpenSettings} /> : null}
          <PlainAction label="Type instead" captureId="a-voice-type" chevron={null} placement="centered" onPress={onTypeInstead} />
        </>
      );
    default:
      return <PrimaryAction label="Type instead" captureId="a-voice-type" onPress={onTypeInstead} />;
  }
}

const s = StyleSheet.create({
  live: { flexDirection: 'row', alignItems: 'center', gap: t.space.s16 },
  flex: { flex: 1 },
  disc: {
    width: L.voice.indicator, height: L.voice.indicator, borderRadius: t.radius.capsule,
    backgroundColor: t.color.action, alignItems: 'center', justifyContent: 'center',
  },
  discOff: { backgroundColor: t.color.disabledSurface },
  liveText: { minHeight: L.voice.transcriptMinHeight },
  transcript: {
    minHeight: L.voice.transcriptMinHeight, borderRadius: t.radius.field, borderWidth: t.stroke.focus,
    borderColor: t.color.ink, backgroundColor: t.color.surface, padding: L.field.padding, color: t.color.ink, textAlignVertical: 'top',
  },
});
