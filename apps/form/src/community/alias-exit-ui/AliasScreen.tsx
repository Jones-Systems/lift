import { useLayoutEffect, useMemo, useReducer, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { commandKey } from '../../api/client';
import { L, t } from '../../features/shared/tokens';
import { Gutter, Nav, Notice, PlainAction, PrimaryAction, Screen, Subtitle, Title } from '../../features/shared/ui';
import type { AliasExitContext, AliasExitMode, AliasExitPresentation, AliasExitView } from './contracts';
import { createAliasExitPresentation } from './presentation';

export function useAliasExitPresentation(context: AliasExitContext, mode: AliasExitMode) {
  const { controller, groupId, sessionGeneration, isCurrentSession, onClose } = context;
  const binding = useMemo(() => ({ controller, groupId, sessionGeneration, isCurrentSession, onClose, mode }),
    [controller, groupId, sessionGeneration, isCurrentSession, onClose, mode]);
  const [active, setActive] = useState<{ binding: typeof binding; model: AliasExitPresentation } | null>(null);
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  useLayoutEffect(() => {
    const model = createAliasExitPresentation(binding, binding.mode, commandKey);
    const subscription = model.subscribe(redraw);
    model.attach();
    setActive({ binding, model });
    return () => { subscription.remove(); model.detach(); };
  }, [binding]);
  return active?.binding === binding ? { model: active.model, view: active.model.getSnapshot() } : null;
}

export function AliasExitStatus({ model, view }: { model: AliasExitPresentation; view: AliasExitView }) {
  return <>
    {view.notice ? <Notice kind={view.notice.kind} text={view.notice.text} announce captureId="community-alias-exit-notice" /> : null}
    {!view.ended ? <>
      <PlainAction label="Refresh group details" chevron={null} disabled={!view.canRefresh} onPress={() => void model.refresh()} />
      {view.canReview ? <PlainAction label="Review current details" chevron={null} onPress={model.review} /> : null}
      {view.unresolved ? <PlainAction label="Retry original change" chevron={null} disabled={!view.canRetry} onPress={() => void model.retry()} /> : null}
    </> : null}
  </>;
}

export function AliasScreen({ context }: { context: AliasExitContext }) {
  const presentation = useAliasExitPresentation(context, 'alias');
  if (!presentation) return <Screen><Gutter><Notice kind="info" text="Opening Community…" /></Gutter></Screen>;
  const { model, view } = presentation;
  return <Screen testID="screen-community-alias" nav={view.canClose ? <Nav back="Group" onBack={model.close} /> : <Nav />}>
    <Gutter>
      <Title text="Your group alias" />
      {!view.ended ? <Subtitle text={view.groupName ?? 'Group details unavailable'} /> : null}
      <View style={styles.form}>
        {!view.ended ? <>
          <Subtitle text="Your alias" />
          <TextInput testID="community-alias-input" accessibilityLabel="Your alias" accessibilityHint="Use up to 60 characters. Refresh and review changed membership details before saving."
            accessibilityState={{ disabled: !view.canEdit, busy: view.pending }} editable={view.canEdit}
            value={view.draft} onChangeText={model.setDraft} multiline autoCorrect={false}
            selectionColor={t.color.action} style={[styles.input, !view.canEdit && styles.disabled]} />
          <PrimaryAction label="Save alias" captureId="community-alias-save" disabled={!view.canSubmit} loading={view.pending}
            onPress={() => void model.submit()} />
        </> : null}
        <AliasExitStatus model={model} view={view} />
      </View>
    </Gutter>
  </Screen>;
}

const styles = StyleSheet.create({
  form: { gap: t.space.s12, marginTop: t.space.s24 },
  input: { fontFamily: t.font.textRegular, fontSize: t.type.body.fontSize, lineHeight: t.type.body.lineHeight,
    color: t.color.ink, backgroundColor: t.color.surface, borderColor: t.color.controlBorder,
    borderWidth: t.stroke.control, borderRadius: t.radius.button, minHeight: L.textAnswer.minHeight,
    paddingVertical: L.composer.paddingY, paddingHorizontal: L.composer.paddingX },
  disabled: { backgroundColor: t.color.disabledSurface, color: t.color.secondary },
});
