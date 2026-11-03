import { useLayoutEffect, useState } from 'react';
import { AppState, Modal, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SourceWorkoutView } from '../../features/training/source-ui/SourceWorkoutView';
import { COM01GroupList } from '../../community/group-ui/COM01GroupList';
import { COM01Members } from '../../community/group-ui/COM01Members';
import { COM01RoleState } from '../../community/group-ui/COM01RoleState';
import { theme } from '../../community/group-ui/theme';
import { readSyntheticPreviewSelection } from './entry';
import { createPreviewPresentation } from './presentation';
import type { Presentation } from './presentation';

export default function TrainingCommunityPreviewHost() {
  const selection = readSyntheticPreviewSelection();
  const selectionKey = selection.status === 'selected' ? selection.scenario
    : selection.status === 'denied' ? selection.reason : 'off';
  const [current, setCurrent] = useState<Readonly<{ key: string; view: Presentation }> | null>(null);

  useLayoutEffect(() => {
    let mounted = true, ended = false;
    let presentation: ReturnType<typeof createPreviewPresentation> | null = null;
    const update = (view: Presentation) => { if (mounted) setCurrent({ key: selectionKey, view }); };
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        ended = true;
        presentation?.leaveForeground();
        update({ kind: 'denied', reason: 'not_foreground' });
      }
    });
    // Unknown foreground is closed. Active events never reopen an ended presentation.
    if (AppState.currentState !== 'active' || ended) {
      ended = true; update({ kind: 'denied', reason: 'not_foreground' });
    } else {
      presentation = createPreviewPresentation(update);
      if (ended || AppState.currentState !== 'active') presentation.leaveForeground();
    }
    return () => {
      mounted = false; ended = true;
      presentation?.dispose();
      subscription.remove();
    };
  }, [selectionKey]);

  // Never expose retained props for another selection, including the pre-commit render.
  const view = current?.key === selectionKey ? current.view : null;
  if (!view) return <View style={styles.fill} />;
  if (view.kind === 'denied') return <Text accessibilityRole="alert" testID="synthetic-preview-denial">Preview unavailable: {view.reason}</Text>;
  if (view.kind === 'rest') return <SafeAreaView style={styles.fill}><SourceWorkoutView {...view.props} /></SafeAreaView>;
  if (view.kind === 'groups') return <SafeAreaView style={styles.fill}><COM01GroupList {...view.props} /></SafeAreaView>;
  if (view.kind === 'members') return <SafeAreaView style={styles.fill}><COM01Members {...view.props} /></SafeAreaView>;
  return <View style={styles.fill}>
    <SafeAreaView style={styles.fill} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <COM01Members {...view.underlay} />
    </SafeAreaView>
    <Modal visible transparent={false} presentationStyle="pageSheet" animationType="none"
      allowSwipeDismissal onRequestClose={view.props.onClose} onDismiss={view.props.onClose}>
      <SafeAreaView style={styles.fill} edges={['bottom', 'left', 'right']} accessibilityViewIsModal>
        <COM01RoleState {...view.props} />
      </SafeAreaView>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({ fill: { flex: 1, backgroundColor: theme.color.canvas } });
