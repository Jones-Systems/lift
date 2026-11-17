import { useLayoutEffect, useState } from 'react';
import { View } from 'react-native';
import { ChoiceRow, Choices, Footnote, Gutter, Nav, Notice, PlainAction, PrimaryAction,
  Screen, Section, StatusLine, TextAnswer, Title } from '../../features/shared/ui';
import { EXPERIENCE } from '../../features/onboarding/model';
import type { ContextEditorEntry } from './contracts';
import { createContextEditorController, type ContextEditorSnapshot, type EditorField } from './model';

type Controller = ReturnType<typeof createContextEditorController>;
export type ContextEditorScreenProps = { entry: ContextEditorEntry; attachment: object };
const guidance = { name: 'Use 1–100 characters.', age: 'Use a whole number from 13–120, or choose Not shared.',
  experience: 'Choose your training experience, or leave it Not set.', goals: 'Add up to 30 goals, using 1–200 characters each.',
  schedule: 'Choose 1–7 days per week and 5–180 minutes per session.', equipment: 'Add up to 30 items, using 1–200 characters each.' };
const titles = { name: 'Name', age: 'Age', experience: 'Experience', goals: 'Goals', schedule: 'Schedule', equipment: 'Equipment' };

/** The host must remove this leaf on route/session loss; entry replacement never transfers retry custody. */
export function ContextEditorScreen({ entry, attachment }: ContextEditorScreenProps) {
  const [binding, setBinding] = useState<{
    entry: ContextEditorEntry; attachment: object; controller: Controller; snapshot: ContextEditorSnapshot;
  } | null>(null);
  useLayoutEffect(() => {
    const controller = createContextEditorController(entry, attachment);
    const publish = () => setBinding({ entry, attachment, controller, snapshot: controller.snapshot() });
    const unsubscribe = controller.subscribe(publish);
    publish();
    return () => { unsubscribe(); controller.dispose(); };
  }, [entry, attachment]);
  if (!binding || binding.entry !== entry || binding.attachment !== attachment || !entry.isCurrentEditor() ||
    binding.snapshot.status === 'retired') return null;
  return <EditorForm controller={binding.controller} snapshot={binding.snapshot} />;
}

function EditorForm({ controller, snapshot }: { controller: Controller; snapshot: ContextEditorSnapshot }) {
  const { target, draft, blocked, status } = snapshot;
  const answer = (label: string, value: string, onChangeText: (value: string) => void, numeric = false) => blocked
    ? <View accessibilityLabel={label} accessibilityState={{ disabled: true }}><Footnote text={label} /><StatusLine text={value || 'Not set'} /></View>
    : <TextAnswer label={label} value={value} keyboardType={numeric ? 'number-pad' : 'default'} onChangeText={onChangeText} />;
  const field = (key: EditorField, label: string, numeric = false) => answer(label,
    typeof draft[key] === 'string' ? draft[key] as string : '', value => controller.edit(key, value), numeric);
  const listField = target === 'goals' ? 'goals' : 'equipment';
  const items = Array.isArray(draft[listField]) ? draft[listField] as string[] : [];
  const listLabel = target === 'goals' ? 'goal' : 'equipment';
  const mayClose = status !== 'pending' && status !== 'unknown';
  return <Screen testID="screen-context-editor" nav={<Nav leading={<PlainAction label="Back to Settings"
    disabled={!mayClose} chevron={null} onPress={() => controller.close()} />} />}
    footer={<PrimaryAction label="Save" disabled={!snapshot.canSave} loading={status === 'pending'} onPress={() => void controller.save()} />}>
    <Gutter><Title text={titles[target]} /></Gutter>
    <Section>
      <Footnote text={guidance[target]} />
      {snapshot.message ? <Notice announce kind={status === 'failed' ? 'error' : status === 'unknown' ? 'warning' : 'info'}
        text={snapshot.message} action={snapshot.canRetry ? { label: 'Try again', onPress: () => void controller.retry() } : null} /> : null}
      <View pointerEvents={blocked ? 'none' : 'auto'} accessibilityState={{ disabled: blocked }}>
        {target === 'name' ? field('name', 'Name') : null}
        {target === 'age' ? <>
          {field('age', 'Age, years', true)}
          <PlainAction label="Not shared" disabled={blocked} onPress={() => controller.edit('age', null)} />
        </> : null}
        {target === 'experience' ? <Choices>
          {EXPERIENCE.map(item => <ChoiceRow key={item.value} title={item.title} disabled={blocked}
            selected={draft.trainingBackground === item.value} onPress={() => controller.edit('trainingBackground', item.value)} />)}
          <ChoiceRow title="Not set" disabled={blocked} selected={draft.trainingBackground === null}
            onPress={() => controller.edit('trainingBackground', null)} />
        </Choices> : null}
        {target === 'schedule' ? <>
          {field('trainingDaysPerWeek', 'Days per week', true)}
          {field('sessionMinutes', 'Session minutes', true)}
        </> : null}
        {target === 'goals' || target === 'equipment' ? <>
          {items.map((item, index) => <View key={index}>
            {answer(`${target === 'goals' ? 'Goal' : 'Equipment'} ${index + 1}`, item,
              value => controller.edit(listField, items.map((old, at) => at === index ? value : old)))}
            <PlainAction label={`Remove ${listLabel} ${index + 1}`} disabled={blocked}
              onPress={() => controller.edit(listField, items.filter((_, at) => at !== index))} />
          </View>)}
          <PlainAction label={`Add ${listLabel}`} disabled={blocked || items.length >= 30}
            onPress={() => controller.edit(listField, [...items, ''])} />
        </> : null}
      </View>
    </Section>
  </Screen>;
}
