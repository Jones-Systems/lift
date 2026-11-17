// form-onboarding v1 components OB-01…OB-12 on Open Mat primitives. Values come from tokens only.
import { useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, TextInput, View,
  type KeyboardTypeOptions, type StyleProp, type TextInputProps, type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OpenMatArt } from '../../variants/a/art';
import { MetaLine, Notice, PlainAction, PrimaryAction, Txt } from '../../variants/a/primitives';
import { typeStyles, useEssentialOutline, useTextScale } from '../../variants/a/theme';
import { Icon, type IconName } from './icons';
import { L, t } from './tokens';

export { MetaLine, Notice, PlainAction, PrimaryAction, Txt };

export function selectionHaptic() {
  if (Platform.OS === 'ios') void Haptics.selectionAsync().catch(() => undefined);
}

/* ---------------- screen scaffold: nav, scrolling page, bottom accessory ---------------- */

/** `nav` undefined reserves the nav row; null means the screen draws its own nav inside its content. */
export function Screen({ nav, children, footer, testID }: { nav?: ReactNode; children: ReactNode; footer?: ReactNode; testID?: string }) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView testID={testID} style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={s.fill} contentContainerStyle={[s.page, { paddingTop: insets.top + L.frame.navGap }]}
        keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="never">
        {nav === undefined ? <View style={s.navSpacer} /> : nav}
        {children}
        <View style={s.scrollPad} />
      </ScrollView>
      {footer ? <View style={[s.footer, { paddingBottom: insets.bottom + L.footer.paddingBottom }]}>{footer}</View> : null}
    </KeyboardAvoidingView>
  );
}

/** OB-05 BackNav: chevron + previous title; with a trailing action, large text collapses Back to a 44 pt chevron. */
export function Nav({ back, onBack, trailing, leading }: { back?: string; onBack?: () => void; trailing?: ReactNode; leading?: ReactNode }) {
  const { large } = useTextScale();
  const collapse = large && !!trailing;
  return (
    <View style={[s.nav, collapse && s.navCollapsed]}>
      {back ? (
        <Pressable testID="a-back" accessibilityRole="button" accessibilityLabel={`Back to ${back}`} onPress={onBack}
          style={({ pressed }) => [s.back, collapse && s.backCollapsed, pressed && s.pressed]}>
          <Icon name="chevron-left" size={L.icon.standard} color={t.color.action} />
          {collapse ? null : <Txt role="body" tone="action">{back}</Txt>}
        </Pressable>
      ) : leading ?? <View />}
      {trailing ?? null}
    </View>
  );
}

export function Wordmark() {
  return <Txt role="sectionTitle" testID="a-wordmark">form</Txt>;
}

export function Gutter({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.gutter, style]}>{children}</View>;
}

export function Title({ text, display, testID }: { text: string; display?: boolean; testID?: string }) {
  return <Txt role={display ? 'display' : 'pageTitle'} accessibilityRole="header" testID={testID ?? 'a-question'} style={s.title}>{text}</Txt>;
}

export function Subtitle({ text }: { text: string }) {
  return <Txt role="body" tone="secondary" style={s.subtitle}>{text}</Txt>;
}

export function StepMeta({ n }: { n: number }) {
  return <Txt role="meta" tone="secondary" testID="a-step" style={s.stepMeta}>{`Question ${n} of 8`}</Txt>;
}

export function Eyebrow({ text }: { text: string }) {
  return <Txt role="meta" tone="secondary" style={s.stepMeta}>{text}</Txt>;
}

export function Section({ children, tight, style }: { children: ReactNode; tight?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.gutter, tight ? s.sectionTight : s.section, style]}>{children}</View>;
}

export function Art({ style }: { style?: StyleProp<ViewStyle> }) {
  return <OpenMatArt variant="today" testID="a-open-mat-art" style={[s.art, style]} />;
}

/* ---------------- OB-07 StepFooter ---------------- */

export function StepFooter({ label, onPress, disabled, loading, testID = 'a-continue', secondary, onSecondary }: {
  label: string; onPress: () => void; disabled?: boolean; loading?: boolean; testID?: string;
  secondary?: string; onSecondary?: () => void;
}) {
  return (
    <View testID="a-footer" style={s.footerStack}>
      <PrimaryAction label={label} captureId={testID} onPress={onPress} disabled={disabled} loading={loading} />
      {secondary ? <PlainAction label={secondary} captureId="a-footer-secondary" onPress={onSecondary} chevron={null} placement="centered" /> : null}
    </View>
  );
}

/* ---------------- OB-01 OutlineAction ---------------- */

export function OutlineAction({ label, onPress, disabled, loading, testID, icon }: {
  label: string; onPress?: () => void; disabled?: boolean; loading?: boolean; testID?: string; icon?: IconName;
}) {
  const outline = useEssentialOutline();
  const inactive = !!disabled || !!loading;
  const glyph: IconName | undefined = loading ? 'loader-circle' : icon;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ disabled: inactive, busy: !!loading }}
      disabled={inactive} onPress={onPress}
      style={({ pressed }) => [s.outline, outline, disabled && s.outlineDisabled, pressed && s.pressed]}>
      {glyph ? <Icon name={glyph} size={L.icon.standard} color={disabled ? t.color.secondary : t.color.ink} /> : null}
      <Txt role="button" tone={disabled ? 'secondary' : 'ink'}>{label}</Txt>
    </Pressable>
  );
}

/* ---------------- OB-02 TextAnswer ---------------- */

export type TextAnswerProps = {
  label?: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  onMic?: () => void;
  error?: boolean;
  testID?: string;
  micTestID?: string;
  secure?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoComplete?: TextInputProps['autoComplete'];
  textContentType?: TextInputProps['textContentType'];
  autoCapitalize?: TextInputProps['autoCapitalize'];
  trailing?: ReactNode;
  multiline?: boolean;
  maxLength?: number;
  onSubmitEditing?: () => void;
};

export function TextAnswer(props: TextAnswerProps) {
  const [focused, setFocused] = useState(false);
  const outline = useEssentialOutline();
  const { label, value, onChangeText, placeholder, onMic, error, testID, micTestID = 'a-mic' } = props;
  return (
    <View>
      {label ? <Txt role="meta" tone="secondary">{label}</Txt> : null}
      <View testID={testID} style={[s.answer, outline, !onMic && s.answerNoMic, focused && s.answerFocused, error && s.answerError, label ? s.answerLabelled : null]}>
        <TextInput
          testID={testID ? `${testID}-input` : undefined}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={t.color.secondary}
          accessibilityLabel={label ?? placeholder}
          secureTextEntry={props.secure}
          keyboardType={props.keyboardType}
          autoComplete={props.autoComplete}
          textContentType={props.textContentType}
          autoCapitalize={props.autoCapitalize}
          autoCorrect={!props.secure}
          multiline={props.multiline}
          maxLength={props.maxLength}
          onSubmitEditing={props.onSubmitEditing}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          selectionColor={t.color.action}
          style={[typeStyles.body, s.answerInput]}
        />
        {props.trailing ?? null}
        {onMic ? (
          <Pressable testID={micTestID} accessibilityRole="button" accessibilityLabel="Answer with your voice" onPress={onMic}
            style={({ pressed }) => [s.mic, pressed && s.micPressed]}>
            <Icon name="mic" size={L.icon.standard} color={t.color.ink} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/* ---------------- OB-03 ChoiceRow ---------------- */

export function ChoiceRow({ title, detail, selected, onPress, multi, testID, disabled, state }: {
  title: string; detail?: string | null; selected: boolean; onPress: () => void; multi?: boolean; testID?: string;
  disabled?: boolean; state?: 'pending' | 'unknown';
}) {
  const outline = useEssentialOutline();
  const pending = state === 'pending';
  const inactive = !!disabled || pending;
  return (
    <Pressable testID={testID} accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: selected, disabled: inactive, busy: pending }} disabled={inactive}
      onPress={() => { if (inactive) return; selectionHaptic(); onPress(); }}
      style={({ pressed }) => [s.choice, outline, selected && s.choiceSelected, pressed && !selected && s.pressed]}>
      <View style={s.choiceText}>
        <Txt role="bodyStrong">{title}</Txt>
        {detail ? <Txt role="meta" tone="secondary">{detail}</Txt> : null}
        {state === 'unknown' ? <Txt role="caption" tone="warning">Not confirmed</Txt> : null}
      </View>
      <View style={[s.indicator, selected && s.indicatorSelected, pending && s.indicatorPending]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {pending ? <Icon name="loader-circle" size={L.icon.standard} color={t.color.ink} />
          : selected ? <Icon name="check" size={L.icon.inline} color={t.color.surface} /> : null}
      </View>
    </Pressable>
  );
}

export function Choices({ children, multi }: { children: ReactNode; multi?: boolean }) {
  return <View accessibilityRole={multi ? undefined : 'radiogroup'} style={s.choices}>{children}</View>;
}

/* ---------------- OB-04 ChipChoice ---------------- */

export function ChipChoice({ label, selected, onPress, testID }: { label: string; selected: boolean; onPress: () => void; testID?: string }) {
  const outline = useEssentialOutline();
  return (
    <Pressable testID={testID} accessibilityRole="checkbox" accessibilityState={{ checked: selected }}
      onPress={() => { selectionHaptic(); onPress(); }}
      style={({ pressed }) => [s.chip, outline, selected && s.chipSelected, pressed && s.pressed]}>
      {selected ? <Icon name="check" size={L.icon.inline} color={t.color.ink} /> : null}
      <Txt role="bodyStrong">{label}</Txt>
    </Pressable>
  );
}

export function ChipSet({ children }: { children: ReactNode }) {
  return <View style={s.chipSet}>{children}</View>;
}

/* ---------------- unit toggle ---------------- */

export function Segmented<T extends string>({ items, selected, onSelect, testID }: {
  items: readonly { value: T; label: string }[]; selected: T; onSelect: (value: T) => void; testID?: string;
}) {
  return (
    <View testID={testID} accessibilityRole="radiogroup" style={s.segmented}>
      {items.map((item) => {
        const on = item.value === selected;
        return (
          <Pressable key={item.value} testID={testID ? `${testID}-${item.value}` : undefined}
            accessibilityRole="radio" accessibilityState={{ checked: on }}
            onPress={() => { selectionHaptic(); onSelect(item.value); }} style={[s.segment, on && s.segmentSelected]}>
            <Txt role="bodyStrong">{item.label}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ---------------- OB-11 NumericStepper ---------------- */

export function StepperField({ label, value, onStep, testID, focused, error, full }: {
  label: string; value: string; onStep: (delta: -1 | 1) => void; testID?: string; focused?: boolean; error?: boolean; full?: boolean;
}) {
  const outline = useEssentialOutline();
  const { large } = useTextScale();
  return (
    <View testID={testID} accessibilityLabel={`${label}, ${value}`}
      style={[s.field, outline, !large && !full && s.fieldFill, full && s.fieldFull, focused && s.fieldFocused, error && s.fieldError]}>
      <Txt role="meta" tone="secondary">{label}</Txt>
      <View style={s.fieldRow}>
        <StepButton icon="minus" label={`Decrease ${label}`} onPress={() => onStep(-1)} />
        <Txt role="value" style={s.fieldValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Txt>
        <StepButton icon="plus" label={`Increase ${label}`} onPress={() => onStep(1)} />
      </View>
    </View>
  );
}

function StepButton({ icon, label, onPress }: { icon: 'minus' | 'plus'; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [s.step, pressed && s.stepPressed]}>
      <Icon name={icon} size={L.icon.standard} color={t.color.ink} />
    </Pressable>
  );
}

export function Fields({ children }: { children: ReactNode }) {
  const { large } = useTextScale();
  return <View style={[s.fields, large && s.fieldsLarge]}>{children}</View>;
}

/* ---------------- switch row (native UISwitch) ---------------- */

export function ToggleRow({ label, detail, value, onValueChange, testID }: {
  label: string; detail?: string; value: boolean; onValueChange: (value: boolean) => void; testID?: string;
}) {
  return (
    <View testID={testID} style={s.toggleRow}>
      <View style={s.choiceText}>
        <Txt role="bodyStrong">{label}</Txt>
        {detail ? <Txt role="meta" tone="secondary">{detail}</Txt> : null}
      </View>
      <Switch accessibilityLabel={label} value={value} onValueChange={onValueChange} trackColor={{ true: t.color.action, false: t.color.line }} />
    </View>
  );
}

/* ---------------- OB-10 AccountRow ---------------- */

export function AccountRow({ label, value, detail, onPress, danger, testID, last }: {
  label: string; value?: string | null; detail?: string | null; onPress?: () => void; danger?: boolean; testID?: string; last?: boolean;
}) {
  const body = (
    <>
      <View style={s.rowText}>
        <Txt role="bodyStrong" tone={danger ? 'error' : 'ink'}>{label}</Txt>
        {detail ? <Txt role="meta" tone="secondary">{detail}</Txt> : null}
      </View>
      {value ? <Txt role="meta" tone="secondary" style={s.rowValue}>{value}</Txt> : null}
      {onPress ? <Icon name="chevron-right" size={L.icon.inline} color={t.color.secondary} /> : null}
    </>
  );
  if (!onPress) return <View testID={testID} style={[s.arow, last && s.arowLast]}>{body}</View>;
  return (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.arow, last && s.arowLast, pressed && s.pressed]}>
      {body}
    </Pressable>
  );
}

export function RowGroup({ heading, children }: { heading?: string; children: ReactNode }) {
  return (
    <Section tight>
      {heading ? <Txt role="meta" tone="secondary">{heading}</Txt> : null}
      <View>{children}</View>
    </Section>
  );
}

/* ---------------- OB-06 evidence source block ---------------- */

export function SourceNote({ text, onSources }: { text: string; onSources: () => void }) {
  return (
    <View testID="a-source" style={s.source}>
      <Txt role="meta" tone="secondary">{text}</Txt>
      <PlainAction label="See sources" captureId="a-sources" onPress={onSources} />
    </View>
  );
}

export function Panel({ children, testID, style }: { children: ReactNode; testID?: string; style?: StyleProp<ViewStyle> }) {
  return <View testID={testID} style={[s.panel, style]}>{children}</View>;
}

/* ---------------- system sheet ---------------- */

export function Sheet({ visible, title, onClose, children, actions, closeTestID, testID, large }: {
  visible: boolean; title: string; onClose: () => void; children: ReactNode; actions?: ReactNode;
  closeTestID?: string; testID?: string; large?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle={large ? 'pageSheet' : 'formSheet'} onRequestClose={onClose}>
      <ScrollView testID={testID} style={s.sheet} contentContainerStyle={[s.sheetContent, { paddingBottom: insets.bottom + L.sheet.paddingBottom }]}
        accessibilityViewIsModal keyboardShouldPersistTaps="handled">
        <View style={s.handle} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        <View style={s.sheetHead}>
          <Txt role="sectionTitle" accessibilityRole="header" style={s.sheetTitle}>{title}</Txt>
          <Pressable testID={closeTestID} accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={s.close}>
            <Icon name="x" size={L.icon.standard} color={t.color.ink} />
          </Pressable>
        </View>
        <View style={s.sheetSection}>{children}</View>
        {actions ? <View style={s.sheetActions}>{actions}</View> : null}
      </ScrollView>
    </Modal>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.row, style]}>{children}</View>;
}

export function Stack({ children, gap, style }: { children: ReactNode; gap?: keyof typeof t.space; style?: StyleProp<ViewStyle> }) {
  return <View style={[gap ? { gap: t.space[gap] } : null, style]}>{children}</View>;
}

/* ---------------- settings-training v2 ST-04 StatusLine and group footnote ---------------- */

/** Non-actionable unavailable-feature row: leading info glyph, secondary text, no chevron, no button trait. */
export function StatusLine({ text, testID, last }: { text: string; testID?: string; last?: boolean }) {
  return (
    <View testID={testID} accessible accessibilityRole="text" accessibilityLabel={text} style={[s.statusLine, last && s.statusLineLast]}>
      <View style={s.statusIcon}><Icon name="info" size={L.icon.notice} color={t.color.secondary} /></View>
      <Txt role="body" tone="secondary" style={s.statusText}>{text}</Txt>
    </View>
  );
}

export function Footnote({ text, testID }: { text: string; testID?: string }) {
  return <Txt role="meta" tone="secondary" testID={testID} style={s.footnote}>{text}</Txt>;
}

export function Spinner() {
  return <Icon name="loader-circle" size={L.icon.standard} color={t.color.secondary} />;
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: t.color.canvas },
  page: { flexGrow: 1 },
  navSpacer: { minHeight: L.frame.navHeight },
  scrollPad: { height: L.frame.scrollBottomGap + L.button.minHeight + L.footer.paddingTop + L.footer.paddingBottom },
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: t.color.canvas,
    paddingTop: L.footer.paddingTop, paddingHorizontal: L.frame.gutter,
  },
  footerStack: { gap: L.footer.gap },
  nav: {
    minHeight: L.frame.navHeight, paddingHorizontal: L.frame.gutter, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: t.space.s12, flexWrap: 'wrap',
  },
  navCollapsed: { gap: t.space.s16, flexWrap: 'nowrap' },
  back: {
    flexDirection: 'row', alignItems: 'center', gap: t.space.s4, minHeight: L.frame.minimumTarget,
    paddingRight: L.plainAction.paddingX, marginLeft: -t.space.s4, borderRadius: t.radius.small,
  },
  backCollapsed: { minWidth: L.frame.minimumTarget, justifyContent: 'center', paddingRight: t.space.s0, marginLeft: -(L.frame.minimumTarget - L.icon.standard) / 2 },
  pressed: { backgroundColor: t.color.selection },
  gutter: { paddingHorizontal: L.frame.gutter },
  title: { marginTop: L.header.titleGap },
  subtitle: { marginTop: L.header.subtitleGap },
  stepMeta: { marginTop: L.header.titleGap, marginBottom: -L.header.titleGap + t.space.s4 },
  section: { marginTop: t.space.s32, gap: t.space.s12 },
  sectionTight: { marginTop: t.space.s24, gap: t.space.s8 },
  art: { alignSelf: 'center' },
  outline: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: L.button.iconGap,
    minHeight: L.button.minHeight, paddingVertical: L.button.paddingY, paddingHorizontal: L.button.paddingX,
    borderRadius: t.radius.button, borderCurve: 'continuous', backgroundColor: t.color.surface,
    borderWidth: t.stroke.control, borderColor: t.color.controlBorder, alignSelf: 'stretch',
  },
  outlineDisabled: { backgroundColor: t.color.disabledSurface, borderColor: t.color.line },
  answer: {
    minHeight: L.textAnswer.minHeight, borderRadius: t.radius.button, borderCurve: 'continuous',
    borderWidth: t.stroke.control, borderColor: t.color.controlBorder, backgroundColor: t.color.surface,
    paddingVertical: L.composer.paddingY, paddingLeft: L.composer.paddingX, paddingRight: t.space.s8,
    flexDirection: 'row', alignItems: 'center', gap: t.space.s8,
  },
  answerLabelled: { marginTop: t.space.s8 },
  answerNoMic: { paddingRight: L.composer.paddingX },
  answerFocused: {
    borderWidth: t.stroke.focus, borderColor: t.color.ink,
    paddingVertical: L.composer.paddingY - t.stroke.control, paddingLeft: L.composer.paddingX - t.stroke.control,
  },
  answerError: {
    borderWidth: t.stroke.focus, borderColor: t.color.error,
    paddingVertical: L.composer.paddingY - t.stroke.control, paddingLeft: L.composer.paddingX - t.stroke.control,
  },
  answerInput: { flex: 1, minWidth: 0, color: t.color.ink, paddingVertical: t.space.s0 },
  mic: {
    width: L.textAnswer.micTarget, height: L.textAnswer.micTarget, borderRadius: t.radius.capsule,
    backgroundColor: t.color.selection, alignItems: 'center', justifyContent: 'center',
  },
  micPressed: { backgroundColor: t.color.line },
  choices: { gap: L.choice.gap },
  choice: {
    minHeight: L.choice.minHeight, borderRadius: t.radius.message, borderCurve: 'continuous',
    borderWidth: t.stroke.control, borderColor: t.color.controlBorder, backgroundColor: t.color.surface,
    paddingVertical: L.choice.paddingY, paddingHorizontal: L.choice.paddingX,
    flexDirection: 'row', alignItems: 'center', gap: t.space.s12,
  },
  choiceSelected: {
    borderWidth: t.stroke.selection, borderColor: t.color.ink, backgroundColor: t.color.selection,
    paddingVertical: L.choice.paddingY - t.stroke.control, paddingHorizontal: L.choice.paddingX - t.stroke.control,
  },
  choiceText: { flex: 1, gap: t.space.s2 },
  indicator: {
    width: L.choice.indicator, height: L.choice.indicator, borderRadius: t.radius.capsule,
    borderWidth: t.stroke.focus, borderColor: t.color.controlBorder, alignItems: 'center', justifyContent: 'center',
  },
  indicatorSelected: { borderColor: t.color.ink, backgroundColor: t.color.ink },
  indicatorPending: { borderColor: t.color.transparent },
  chipSet: { flexDirection: 'row', flexWrap: 'wrap', gap: L.chipChoice.gap },
  chip: {
    minHeight: L.prompt.minHeight, borderRadius: t.radius.message, borderCurve: 'continuous',
    borderWidth: t.stroke.control, borderColor: t.color.controlBorder, backgroundColor: t.color.surface,
    paddingVertical: L.prompt.paddingY, paddingHorizontal: L.prompt.paddingX,
    flexDirection: 'row', alignItems: 'center', gap: t.space.s8,
  },
  chipSelected: {
    borderWidth: t.stroke.selection, borderColor: t.color.ink, backgroundColor: t.color.selection,
    paddingVertical: t.space.s12, paddingHorizontal: t.space.s16,
  },
  segmented: {
    height: L.segmented.height, borderRadius: t.radius.capsule, backgroundColor: t.color.selection,
    padding: L.segmented.padding, flexDirection: 'row', alignSelf: 'flex-start',
  },
  segment: { minWidth: L.segmented.segmentMinWidth, borderRadius: t.radius.capsule, alignItems: 'center', justifyContent: 'center', paddingHorizontal: t.space.s16 },
  segmentSelected: { backgroundColor: t.color.surface, borderWidth: t.stroke.selection, borderColor: t.color.ink },
  fields: { flexDirection: 'row', gap: L.field.pairGap },
  fieldsLarge: { flexDirection: 'column' },
  field: {
    minHeight: L.field.minHeight, borderWidth: t.stroke.control, borderColor: t.color.controlBorder,
    borderRadius: t.radius.field, borderCurve: 'continuous', padding: L.field.padding,
    backgroundColor: t.color.surface, gap: L.field.labelGap,
  },
  fieldFill: { flex: 1, minWidth: 0 },
  fieldFull: { alignSelf: 'stretch' },
  fieldFocused: { borderWidth: t.stroke.focus, borderColor: t.color.ink, padding: t.space.s12 },
  fieldError: { borderWidth: t.stroke.focus, borderColor: t.color.error, padding: t.space.s12 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: L.field.innerGap },
  fieldValue: { flex: 1, minWidth: L.field.valueMinWidth, textAlign: 'center' },
  step: {
    width: L.field.controlTarget, height: L.field.controlTarget, borderRadius: t.radius.capsule,
    backgroundColor: t.color.selection, alignItems: 'center', justifyContent: 'center',
  },
  stepPressed: { backgroundColor: t.color.line },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: t.space.s12, minHeight: L.choice.minHeight },
  arow: {
    flexDirection: 'row', alignItems: 'center', gap: t.space.s12, minHeight: L.choice.minHeight,
    paddingVertical: t.space.s8, borderBottomWidth: t.stroke.divider, borderBottomColor: t.color.line,
  },
  arowLast: { borderBottomWidth: 0 },
  rowText: { flex: 1, minWidth: 0, gap: t.space.s2 },
  rowValue: { textAlign: 'right' },
  source: {
    marginTop: L.outcome.sourceGap, paddingTop: t.space.s16, borderTopWidth: t.stroke.divider,
    borderTopColor: t.color.line, gap: t.space.s4,
  },
  panel: {
    backgroundColor: t.color.atmosphere, borderRadius: t.radius.selectedPlan, borderCurve: 'continuous',
    paddingTop: L.planPanel.paddingTop, paddingHorizontal: L.planPanel.paddingX, paddingBottom: L.planPanel.paddingBottom,
    gap: t.space.s8,
  },
  sheet: { flex: 1, backgroundColor: t.color.surface },
  sheetContent: { paddingTop: L.sheet.paddingTop, paddingHorizontal: L.sheet.paddingX },
  handle: {
    width: L.sheet.handleWidth, height: L.sheet.handleHeight, borderRadius: t.radius.capsule,
    backgroundColor: t.color.line, alignSelf: 'center',
  },
  sheetHead: { marginTop: L.sheet.handleGap, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: t.space.s12 },
  sheetTitle: { flex: 1, paddingTop: t.space.s8 },
  close: {
    width: L.sheet.closeTarget, height: L.sheet.closeTarget, borderRadius: t.radius.capsule,
    backgroundColor: t.color.selection, alignItems: 'center', justifyContent: 'center',
  },
  sheetSection: { marginTop: L.sheet.sectionGap, gap: t.space.s12 },
  sheetActions: { marginTop: L.sheet.sectionGap, gap: L.sheet.actionGap },
  row: { flexDirection: 'row', alignItems: 'center' },
  statusLine: {
    flexDirection: 'row', alignItems: 'flex-start', gap: L.statusLine.iconGap, minHeight: L.statusLine.minHeight,
    paddingVertical: t.space.s12, paddingHorizontal: t.space.s0,
    borderBottomWidth: t.stroke.divider, borderBottomColor: t.color.line,
  },
  statusLineLast: { borderBottomWidth: 0 },
  statusIcon: { marginTop: t.space.s2, flexShrink: 0 },
  statusText: { flex: 1, minWidth: 0 },
  footnote: { marginTop: L.settings.footnoteGap },
});
