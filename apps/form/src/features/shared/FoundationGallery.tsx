// Gallery page for the shared foundation (web: ?gallery=1&foundation=1). Exercises toasts, inline errors and
// status, motion primitives, icons, light layers and the movement illustration with synthetic copy only.
import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PlainAction, PrimaryAction, Txt } from '../../variants/a/primitives';
import { FoundationProvider } from './foundation';
import { Icon, semanticIcon } from './icons';
import { MovementIllustration } from './illustration';
import { BusyIndicator, InlineStatus, StatusBadge } from './inline';
import { LightBackdrop, LightSurface } from './light';
import { Highlight, Shake } from './motionFeedback';
import { AnimatedNumber, CompletionMoment, Entrance, PressFeedback, ProgressBar, ProgressRing } from './motionPrimitives';
import { useReduceMotion } from './motionProvider';
import { useToast } from './toast';
import { t } from './tokens';
import { TextAnswer } from './ui';

type MotionChoice = 'system' | 'reduced' | 'full';
const MOTION_CHOICES: readonly MotionChoice[] = ['system', 'reduced', 'full'];
const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function FoundationGallery() {
  const [motion, setMotion] = useState<MotionChoice>('system');
  return (
    <FoundationProvider reduceMotion={motion === 'system' ? undefined : motion === 'reduced'}>
      <Page motion={motion} onMotion={setMotion} />
    </FoundationProvider>
  );
}

function Page({ motion, onMotion }: { motion: MotionChoice; onMotion: (next: MotionChoice) => void }) {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  return (
    <View style={s.fill}>
      <LightBackdrop />
      <ScrollView contentContainerStyle={[s.content, { paddingTop: insets.top + t.space.s24, paddingBottom: insets.bottom + t.space.s48 }]}>
        <Entrance index={0}><Txt role="pageTitle" accessibilityRole="header">Foundation</Txt></Entrance>
        <Entrance index={1}>
          <Txt tone="secondary">Shared motion, feedback, light and icons. Reduce Motion is {reduce ? 'on' : 'off'}.</Txt>
          <View style={s.row}>
            {MOTION_CHOICES.map((choice) => (
              <PlainAction key={choice} label={choice === 'system' ? 'System motion' : choice === 'reduced' ? 'Reduced' : 'Full'}
                captureId={`demo-motion-${choice}`} chevron={null} tone={motion === choice ? 'ink' : 'action'} onPress={() => onMotion(choice)} />
            ))}
          </View>
        </Entrance>
        <Entrance index={2}><ToastDemo /></Entrance>
        <Entrance index={3}><InlineDemo /></Entrance>
        <Entrance index={4}><MotionDemo /></Entrance>
        <Entrance index={5}><IconDemo /></Entrance>
      </ScrollView>
    </View>
  );
}

function Card({ title, children, testID }: { title: string; children: ReactNode; testID?: string }) {
  return (
    <LightSurface testID={testID} style={s.card}>
      <Txt role="sectionTitle" accessibilityRole="header">{title}</Txt>
      {children}
    </LightSurface>
  );
}

function ToastDemo() {
  const toast = useToast();
  return (
    <Card title="Toasts" testID="demo-toasts">
      <Txt tone="secondary">Quick confirmations and recoverable failures. Up to three stack; swipe or close to dismiss.</Txt>
      <View style={s.stack}>
        <PlainAction label="Saved" captureId="demo-toast-success" onPress={() =>
          toast.show({ tone: 'success', title: 'Workout saved', body: '3 movements · 24 minutes', key: 'saved', testID: 'toast-saved' })} />
        <PlainAction label="Offline" captureId="demo-toast-offline" onPress={() =>
          toast.show({ tone: 'warning', title: 'You’re offline', body: 'Changes stay on this phone and sync when you reconnect.',
            icon: semanticIcon.offline, key: 'offline', testID: 'toast-offline' })} />
        <PlainAction label="Failed save with Retry" captureId="demo-toast-error" onPress={() =>
          toast.show({ tone: 'error', title: 'Couldn’t save the set', body: 'Your entry is kept. Try again when you’re ready.', key: 'set',
            testID: 'toast-error', action: { label: 'Retry', icon: semanticIcon.retry,
              onPress: () => toast.show({ tone: 'success', title: 'Set saved', key: 'set', testID: 'toast-retried' }) } })} />
        <PlainAction label="Removed with Undo" captureId="demo-toast-undo" onPress={() =>
          toast.show({ tone: 'info', title: 'Set removed', key: 'removed', testID: 'toast-undo',
            action: { label: 'Undo', icon: semanticIcon.undo, onPress: () => toast.show({ tone: 'success', title: 'Set restored', key: 'removed' }) } })} />
      </View>
    </Card>
  );
}

function InlineDemo() {
  const [name, setName] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [nameError, setNameError] = useState<string | null>(null);
  const [failed, setFailed] = useState(true);
  const save = () => {
    setAttempts((count) => count + 1);
    setNameError(name.trim() ? null : 'Add a name so you can find this plan later.');
  };
  return (
    <Card title="Inline errors and status" testID="demo-inline">
      <Shake trigger={nameError ? attempts : null}>
        <TextAnswer label="Plan name" value={name} onChangeText={(next) => { setName(next); if (nameError && next.trim()) setNameError(null); }}
          placeholder="Morning strength" errorMessage={nameError} testID="demo-plan-name" />
      </Shake>
      <PrimaryAction label="Save name" captureId="demo-inline-save" onPress={save} />
      {failed ? (
        <InlineStatus tone="error" message="Couldn’t load recent sessions." testID="demo-inline-status"
          onRetry={async () => { await settle(900); setFailed(false); }} />
      ) : (
        <InlineStatus tone="success" message="Recent sessions loaded." testID="demo-inline-status" />
      )}
      <InlineStatus tone="busy" message="Saving your changes…" />
      <InlineStatus tone="warning" message="Offline. Changes will sync later." />
      <View style={s.row}>
        <BusyIndicator label="Loading plan" />
        <StatusBadge tone="success" accessibilityLabel="Saved" />
        <StatusBadge tone="warning" accessibilityLabel="Pending sync" />
        <StatusBadge tone="error" accessibilityLabel="Not saved" />
      </View>
    </Card>
  );
}

function MotionDemo() {
  const [sets, setSets] = useState(2);
  const [done, setDone] = useState(false);
  const [breath, setBreath] = useState<number | null>(null);
  const total = 5;
  return (
    <Card title="Motion" testID="demo-motion">
      <View style={s.row}>
        <ProgressRing progress={sets / total} accessibilityLabel={`${sets} of ${total} sets`}>
          <AnimatedNumber value={sets} role="sectionTitle" />
        </ProgressRing>
        <View style={s.flex}>
          <Highlight trigger={sets} tone="success" style={s.highlight}>
            <Txt role="bodyStrong">{sets} of {total} sets</Txt>
          </Highlight>
          <ProgressBar progress={sets / total} accessibilityLabel="Workout progress" />
        </View>
      </View>
      <View style={s.row}>
        <PressFeedback kind="button" haptic="light" accessibilityLabel="Log a set" testID="demo-log-set" style={s.press}
          onPress={() => setSets((count) => Math.min(total, count + 1))}>
          <Icon name="plus" size="inline" color={t.color.action} />
          <Txt role="bodyStrong" tone="action">Log a set</Txt>
        </PressFeedback>
        <PlainAction label="Reset" captureId="demo-reset" chevron={null} onPress={() => { setSets(0); setDone(false); }} />
      </View>
      <PlainAction label={done ? 'Hide completion' : 'Show completion'} captureId="demo-complete" onPress={() => setDone((value) => !value)} />
      <CompletionMoment visible={done} title="Workout complete" detail="Nice, steady work today." testID="demo-completion" />
      <View style={s.row}>
        <MovementIllustration movement="goblet-squat" size="small" breathKey={breath} />
        <PlainAction label="Breathe" captureId="demo-breathe" onPress={() => setBreath(Date.now())} />
      </View>
    </Card>
  );
}

const ICON_SAMPLES = ['retry', 'undo', 'offline', 'syncFailed', 'success', 'warning', 'error', 'timer', 'edit', 'remove', 'history', 'feedback'] as const;

function IconDemo() {
  return (
    <Card title="Icons" testID="demo-icons">
      <View style={s.grid}>
        {ICON_SAMPLES.map((key) => (
          <View key={key} style={s.icon}>
            <Icon name={semanticIcon[key]} size="nav" />
            <Txt role="meta" tone="secondary">{key}</Txt>
          </View>
        ))}
      </View>
    </Card>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1, gap: t.space.s8 },
  content: { paddingHorizontal: t.space.s20, gap: t.space.s20 },
  card: { gap: t.space.s16 },
  stack: { gap: t.space.s4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: t.space.s12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.s12 },
  icon: { width: 88, alignItems: 'center', gap: t.space.s4 },
  highlight: { borderRadius: t.radius.small, paddingHorizontal: t.space.s8, paddingVertical: t.space.s4 },
  press: {
    minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: t.space.s8, paddingHorizontal: t.space.s16,
    borderRadius: t.radius.small, backgroundColor: t.color.selection,
  },
});
