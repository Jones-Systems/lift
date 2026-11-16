import { lazy, Suspense } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useFormFonts } from './src/fonts';
import { GalleryShell } from './src/GalleryShell';
import { FormRuntime } from './src/FormRuntime';
import { SettingsSlot } from './src/settings';
import { TrainingSlot } from './src/features/training';
import { readSyntheticPreviewSelection } from './src/integration/syntheticPreview/entry';

const TrainingCommunityPreviewHost = lazy(() => import('./src/integration/syntheticPreview/TrainingCommunityPreviewHost'));

function FontReadyContent({ gallery }: { gallery: boolean }) {
  const selection = readSyntheticPreviewSelection();
  if (selection.status === 'denied') return <Text accessibilityRole="alert" testID="synthetic-preview-denial">Preview unavailable: {selection.reason}</Text>;
  if (selection.status === 'selected') return <Suspense fallback={<View style={styles.fill} />}>
    <TrainingCommunityPreviewHost key={selection.scenario} />
  </Suspense>;
  return gallery ? <GalleryShell /> : <FormRuntime
    renderSettings={ctx => <SettingsSlot {...ctx} />}
    renderHome={ctx => <TrainingSlot {...ctx} />}
  />;
}

export default function App() {
  const fontsReady = useFormFonts();
  const query = Platform.OS === 'web' && typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : null;
  const gallery = query?.get('gallery') === '1';
  const capture = query?.get('capture') === '3';
  const large = query?.get('device') === 'iphone-17-pro-max';
  const frame = (
    <SafeAreaProvider testID="form2-root-frame" style={[styles.fill,
      Platform.OS === 'web' && styles.webPhone,
      capture && {
        flex: 0,
        width: large ? 440 : 402,
        maxWidth: large ? 440 : 402,
        height: large ? 956 : 874,
        maxHeight: large ? 956 : 874,
        transform: [{ scale: 3 }],
        transformOrigin: 'left top',
        overflow: 'hidden',
      }]}>
      {fontsReady ? <FontReadyContent gallery={gallery} /> : <View style={styles.fill} />}
    </SafeAreaProvider>
  );
  if (Platform.OS !== 'web' || capture) return <GestureHandlerRootView style={styles.fill}>{frame}</GestureHandlerRootView>;
  return (
    <GestureHandlerRootView style={styles.webStage}>{frame}</GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#FFFFFF' },
  webStage: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  webPhone: { width: '100%', maxWidth: 402, maxHeight: 874 },
});
