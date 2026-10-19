// Club Circuit components CMP-01..CMP-19 (package screens/b-components.js + b-components.css),
// rebuilt with native primitives. Pages and the showcase use these same components.
import React, { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, TextInput, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { icons, type IconName } from './generatedicons';
import { activeWidth, dividerColor, t, Txt, tones, useEnv, type TextTone, type TypeRole } from './theme';
import { useCapture } from './capture';
import type { DayInfo, StatusText, Tone, Week } from './model';

const C = t.color;
const L = t.layout;
const easeOut = Easing.bezier(...t.motion.easing.out);
const linear = Easing.bezier(...t.motion.easing.linear);
const hidden = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };

/** View that registers its a11y id for capture and focus. */
export function Box({ id, children, ...rest }: ViewProps & { id?: string; children?: ReactNode }) {
  const capture = useCapture(id);
  return <View ref={capture.ref} onLayout={capture.onLayout} testID={id} {...rest}>{children}</View>;
}

export function Icon({ name, size = L.icon.control, color = C.text.primary }: { name: IconName; size?: number; color?: string }) {
  const icon = icons[name];
  return (
    <Svg width={size} height={size} viewBox={icon.viewBox} fill="none" pointerEvents="none" {...hidden}>
      <Path d={icon.d} stroke={color} strokeWidth={t.stroke.icon} strokeLinecap={icon.strokeLinecap} strokeLinejoin={icon.strokeLinejoin} fill="none" />
    </Svg>
  );
}

export const stationNumber = (n: number) => (n < 10 ? '0' + n : String(n));

// ---------- CMP-01 page frame pieces ----------
export type HeaderLine = { text: string; id?: string; type?: TypeRole };
export function Header({ title, id, trailing, lines = [] }: { title: string; id?: string; trailing?: ReactNode; lines?: HeaderLine[] }) {
  return (
    <View style={s.header}>
      <View style={s.headerRow}>
        <Txt type="pageTitle" captureId={id} accessibilityRole="header" style={s.grow}>{title}</Txt>
        {trailing}
      </View>
      {lines.map((line) => (
        <Txt key={line.text} type={line.type ?? 'support'} tone={line.type ? 'primary' : 'secondary'} captureId={line.id}>{line.text}</Txt>
      ))}
    </View>
  );
}

export const TABS = [
  { id: 'today', label: 'Today' }, { id: 'plan', label: 'Plan' }, { id: 'workout', label: 'Workout' },
  { id: 'coach', label: 'Coach' }, { id: 'progress', label: 'Progress' },
] as const;
export type TabId = (typeof TABS)[number]['id'];

export function TabBar({ current, onSelect, bottomInset, id = 'b.tabbar', tabIds = true }: {
  current: TabId; onSelect?: (tab: TabId) => void; bottomInset: number; id?: string; tabIds?: boolean;
}) {
  const env = useEnv();
  return (
    <Box id={tabIds ? id : undefined} accessibilityRole="tablist" accessibilityLabel="Form sections"
      style={[s.tabbar, { paddingBottom: bottomInset, borderTopColor: dividerColor(env) }]}>
      {TABS.map((tab) => <Tab key={tab.id} tab={tab} selected={tab.id === current} onSelect={onSelect} id={tabIds ? `b.tab.${tab.id}` : undefined} />)}
    </Box>
  );
}
function Tab({ tab, selected, onSelect, id }: { tab: (typeof TABS)[number]; selected: boolean; onSelect?: (tab: TabId) => void; id?: string }) {
  const capture = useCapture(id);
  const color = selected ? C.text.primary : C.text.secondary;
  return (
    <Pressable ref={capture.ref} onLayout={capture.onLayout} testID={id} accessibilityRole="tab" accessibilityLabel={tab.label}
      accessibilityState={{ selected }} onPress={() => onSelect?.(tab.id)} style={s.tab}>
      <Icon name={tab.id} size={L.tabBar.iconSize} color={color} />
      <Txt type="tab" tone={selected ? 'primary' : 'secondary'} {...hidden}>{tab.label}</Txt>
      <View style={[s.tabMark, { backgroundColor: selected ? C.text.primary : C.overlay.transparent }]} />
    </Pressable>
  );
}

export function Dock({ children }: { children?: ReactNode }) {
  const env = useEnv();
  if (!children) return null;
  return <View style={[s.dock, { borderTopColor: dividerColor(env) }]}>{children}</View>;
}

// ---------- CMP-02 section heading ----------
export function Heading({ title, desc, action, id }: { title: string; desc?: string; action?: ReactNode; id?: string }) {
  return (
    <Box id={id} style={s.heading}>
      <View style={s.headingRow}>
        <Txt type="sectionTitle" accessibilityRole="header" style={s.shrink}>{title}</Txt>
        {action}
      </View>
      {desc ? <Txt type="support" tone="secondary">{desc}</Txt> : null}
    </Box>
  );
}

// ---------- Status label: words always, optional icon ----------
const LABEL_TONE: Record<Tone, TextTone> = { plain: 'secondary', current: 'primary', recorded: 'recorded', attention: 'attention', error: 'error' };
const LABEL_SURFACE: Record<Tone, string> = {
  plain: C.overlay.transparent, current: C.surface.paper, recorded: C.status.recordedSurface,
  attention: C.status.attentionSurface, error: C.status.errorSurface,
};
export function StatusLabel({ tone = 'plain', text, icon, id }: StatusText & { id?: string }) {
  const env = useEnv();
  const current = tone === 'current';
  return (
    <Box id={id} style={[s.label, {
      backgroundColor: LABEL_SURFACE[tone],
      borderColor: current ? C.border.active : C.overlay.transparent,
      borderWidth: current ? activeWidth(env) : t.stroke.control,
    }, tone === 'plain' && s.labelPlain]}>
      {icon ? <Icon name={icon} size={L.statusLabel.iconSize} color={tones[LABEL_TONE[tone]]} /> : null}
      <Txt type="support" tone={LABEL_TONE[tone]}>{text}</Txt>
    </Box>
  );
}

// ---------- CMP-03 station rail ----------
export function Rail({ num, text, current, board, mark, id }: { num?: number; text?: string; current?: boolean; board?: boolean; mark?: boolean; id?: string }) {
  return (
    <View style={board ? s.railBoard : s.rail} {...hidden}>
      {num == null ? null : (
        <Box id={id} style={[s.railNum, { borderColor: current ? C.border.active : C.overlay.transparent }]}>
          <Txt type="station">{text ?? stationNumber(num)}</Txt>
        </Box>
      )}
      {mark ? <View style={s.railMark} /> : null}
    </View>
  );
}

// ---------- CMP-04 session board ----------
export type BoardProps = {
  kind?: 'loading' | 'error' | 'default'; id?: string; num?: number; stationId?: string; label?: string; minutes?: number;
  title?: string; titleType?: TypeRole; counts?: string[]; status?: StatusText; statusId?: string; note?: string; action?: ReactNode;
};
export function SessionBoard(o: BoardProps) {
  let body: ReactNode;
  if (o.kind === 'loading') {
    body = (
      <View style={s.boardBody} accessibilityState={{ busy: true }}>
        <Txt type="support" tone="secondary">Loading your plan</Txt>
        <View style={[s.skeleton, s.skeletonTitle]} {...hidden} />
        <View style={[s.skeleton, s.skeletonLine]} {...hidden} />
        <View style={s.boardAction}>{o.action}</View>
      </View>
    );
  } else {
    body = (
      <View style={s.boardBody}>
        <View style={s.boardTop}>
          <Txt type="support" tone="secondary">{o.label}</Txt>
          {o.minutes ? <Txt type="sectionTitle" accessibilityLabel={`${o.minutes} minutes`}>{o.minutes} min</Txt> : null}
        </View>
        <Txt type={o.titleType ?? 'display'} accessibilityRole={o.kind === 'error' ? 'alert' : 'header'}>{o.title}</Txt>
        {o.counts?.length ? <Counts items={o.counts} /> : null}
        {o.status ? <Box id={o.statusId} style={s.alignStart}><StatusLabel {...o.status} /></Box> : null}
        {o.note ? <Txt type="body">{o.note}</Txt> : null}
        {o.action ? <View style={s.boardAction}>{o.action}</View> : null}
      </View>
    );
  }
  return (
    <Box id={o.id} style={s.board}>
      <Rail num={o.num} board mark id={o.stationId} />
      {body}
    </Box>
  );
}
export function Counts({ items, id, middle }: { items: ReactNode[]; id?: string; middle?: boolean }) {
  const env = useEnv();
  return (
    <Box id={id} style={[s.counts, middle && s.countsMiddle, env.stacked && s.countsStacked]}>
      {items.map((item, i) => (typeof item === 'string' ? <Txt key={i} type="support">{item}</Txt> : <React.Fragment key={i}>{item}</React.Fragment>))}
    </Box>
  );
}

// ---------- CMP-05 training row ----------
export type TrainingRowProps = {
  num?: number; current?: boolean; title: string; prescription?: string; status?: StatusText | null; trailing?: string;
  compact?: boolean; id?: string; ariaLabel?: string; onField?: boolean; onPress?: () => void;
};
export function TrainingRow(o: TrainingRowProps) {
  const env = useEnv();
  const capture = useCapture(o.id);
  const style = [s.row, o.compact && s.rowCompact, env.stacked && s.wrap, {
    borderBottomColor: o.onField ? C.border.control : dividerColor(env),
  }];
  const content = (
    <>
      <Rail num={o.num} current={o.current} />
      <View style={s.rowMain} {...hidden}>
        <Txt type="rowTitle">{o.title}</Txt>
        {o.prescription ? <Txt type="support" tone="secondary">{o.prescription}</Txt> : null}
        {o.status ? <View style={s.alignStart}><StatusLabel {...o.status} /></View> : null}
      </View>
      {o.trailing ? (
        <View style={[s.rowTrail, o.compact && s.rowTrailCompact, env.stacked && s.rowTrailStacked]} {...hidden}>
          <Txt type="support" tone="secondary">{o.trailing}</Txt>
        </View>
      ) : null}
    </>
  );
  if (o.onPress) {
    return (
      <Pressable ref={capture.ref} onLayout={capture.onLayout} testID={o.id} accessibilityRole="button" accessibilityLabel={o.ariaLabel ?? o.title}
        onPress={o.onPress} style={({ pressed }) => [style, pressed && s.pressed]}>{content}</Pressable>
    );
  }
  return (
    <View ref={capture.ref} onLayout={capture.onLayout} testID={o.id} accessible accessibilityLabel={o.ariaLabel ?? o.title} style={style}>{content}</View>
  );
}

// ---------- CMP-08 week schedule row ----------
export function WeekRow({ info, id, selected, selectable, onPress }: { info: DayInfo; id?: string; selected?: boolean; selectable?: boolean; onPress?: () => void }) {
  const env = useEnv();
  const capture = useCapture(id);
  const rest = info.kind === 'rest';
  const spoken = `${info.longDate}, ${rest ? 'rest day' : `${info.title}${info.fact ? ', ' + info.fact : ''}, ${info.status.text}`}${selected ? ', selected' : ''}`;
  const style = [s.row, s.rowWeek, rest && s.rowCompact, env.stacked && s.wrap, { borderBottomColor: dividerColor(env) },
    selected && s.rowSelected, selected && env.stacked && s.rowSelectedStacked];
  const content = rest ? (
    <>
      {selected ? <View style={s.selectionRule} /> : null}
      <View style={s.gutter} {...hidden}><Txt type="station" tone="secondary">{info.dateLabel}</Txt></View>
      <View style={s.rowMain} {...hidden}><Txt type="body" tone="secondary">{info.day} · Rest day</Txt></View>
    </>
  ) : (
    <>
      {selected ? <View style={s.selectionRule} /> : null}
      <View style={s.gutter} {...hidden}>
        {env.stacked ? null : <Txt type="support" tone="secondary">{info.day}</Txt>}
        <Txt type="station">{info.dateLabel}</Txt>
      </View>
      <View style={s.rowMain} {...hidden}>
        {env.stacked ? <Txt type="support" tone="secondary">{info.longDay}</Txt> : null}
        <Txt type="rowTitle">{info.title}</Txt>
        {info.fact ? <Txt type="support" tone="secondary">{info.fact}</Txt> : null}
      </View>
      <View style={[s.rowTrail, env.stacked && s.rowTrailStacked]} {...hidden}>
        <StatusLabel {...info.status} />
        {onPress ? <Icon name="chevron-right" size={L.icon.inline} color={C.text.secondary} /> : null}
      </View>
    </>
  );
  if (onPress) {
    return (
      <Pressable ref={capture.ref} onLayout={capture.onLayout} testID={id} accessibilityRole="button" accessibilityLabel={spoken}
        accessibilityState={selectable ? { selected: !!selected } : undefined} onPress={onPress}
        style={({ pressed }) => [style, pressed && !selected && s.pressed]}>{content}</Pressable>
    );
  }
  return <View ref={capture.ref} onLayout={capture.onLayout} testID={id} accessible accessibilityLabel={spoken} style={style}>{content}</View>;
}

// ---------- CMP-06 primary button ----------
export function PrimaryButton({ label, onPress, id, disabled, reason, icon }: {
  label: string; onPress?: () => void; id?: string; disabled?: boolean; reason?: string | null; icon?: IconName;
}) {
  const capture = useCapture(id);
  return (
    <>
      <Pressable ref={capture.ref} onLayout={capture.onLayout} testID={id} accessibilityRole="button" accessibilityLabel={label}
        accessibilityState={{ disabled: !!disabled }} accessibilityHint={disabled && reason ? reason : undefined} disabled={disabled} onPress={onPress}
        style={({ pressed }) => [s.primary, { backgroundColor: disabled ? C.surface.disabled : pressed ? C.action.pressed : C.action.primary }]}>
        {icon ? <Icon name={icon} size={L.button.iconSize} color={disabled ? C.text.secondary : C.text.inverse} /> : null}
        <Txt type="control" tone={disabled ? 'secondary' : 'inverse'} style={s.centerText}>{label}</Txt>
      </Pressable>
      {reason ? <Txt type="support" tone="secondary">{reason}</Txt> : null}
    </>
  );
}

// ---------- CMP-07 secondary actions ----------
export function TextAction({ label, onPress, id, icon, ariaLabel, align = 'flex-start' }: {
  label: string; onPress?: () => void; id?: string; icon?: IconName; ariaLabel?: string; align?: ViewStyle['alignSelf'];
}) {
  const capture = useCapture(id);
  return (
    <Pressable ref={capture.ref} onLayout={capture.onLayout} testID={id} accessibilityRole="button" accessibilityLabel={ariaLabel ?? label} onPress={onPress}
      style={({ pressed }) => [s.link, { alignSelf: align }, pressed && s.pressed]}>
      {icon ? <Icon name={icon} size={L.icon.inline} /> : null}
      <Txt type="control" style={s.underline}>{label}</Txt>
    </Pressable>
  );
}
export function OutlineAction({ label, onPress, id, icon, full }: { label: string; onPress?: () => void; id?: string; icon?: IconName; full?: boolean }) {
  const env = useEnv();
  const capture = useCapture(id);
  return (
    <Pressable ref={capture.ref} onLayout={capture.onLayout} testID={id} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [s.outline, { borderWidth: activeWidth(env) }, full && s.fullWidth, pressed && s.pressed]}>
      {icon ? <Icon name={icon} size={L.icon.inline} /> : null}
      <Txt type="control" style={s.centerText}>{label}</Txt>
    </Pressable>
  );
}
export function IconButton({ icon, label, onPress, id, boxed, disabled, style }: {
  icon: IconName; label: string; onPress?: () => void; id?: string; boxed?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const capture = useCapture(id);
  return (
    <Pressable ref={capture.ref} onLayout={capture.onLayout} testID={id} accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [s.iconButton, boxed && s.iconButtonBoxed, pressed && s.pressed, disabled && s.iconButtonDisabled, style]}>
      <Icon name={icon} size={L.icon.control} color={disabled ? C.text.secondary : C.text.primary} />
    </Pressable>
  );
}

// ---------- CMP-09 segmented choice (selects data: radio semantics) ----------
export function Segment<V extends string>({ label, id, items, selected, onSelect }: {
  label: string; id?: string; items: { value: V; label: string; id?: string }[]; selected: V; onSelect?: (value: V) => void;
}) {
  const env = useEnv();
  return (
    <Box id={id} accessibilityRole="radiogroup" accessibilityLabel={label} style={[s.segment, { borderColor: dividerColor(env) }]}>
      {items.map((item) => {
        const on = item.value === selected;
        return (
          <SegmentItem key={item.value} id={item.id} label={item.label} on={on} onPress={() => onSelect?.(item.value)} />
        );
      })}
    </Box>
  );
}
function SegmentItem({ id, label, on, onPress }: { id?: string; label: string; on: boolean; onPress: () => void }) {
  const capture = useCapture(id);
  return (
    <Pressable ref={capture.ref} onLayout={capture.onLayout} testID={id} accessibilityRole="radio" accessibilityLabel={label}
      accessibilityState={{ checked: on }} onPress={onPress}
      style={[s.segmentItem, on && s.segmentItemOn]}>
      <Txt type="control" style={s.centerText}>{label}</Txt>
    </Pressable>
  );
}

// ---------- CMP-10 numeric entry ----------
export type EntryProps = {
  label: string; hint: string; value: string; unit: string; id: string; decLabel: string; incLabel: string;
  canDec: boolean; canInc: boolean; error?: string | null; keyboard: 'number-pad' | 'decimal-pad'; step: number;
  onChange?: (value: string) => void; onStep?: (delta: number) => void; onSubmit?: () => void;
};
export function NumericEntry(o: EntryProps) {
  const env = useEnv();
  const [focused, setFocused] = useState(false);
  const capture = useCapture(o.id);
  const ring = o.error ? C.status.error : focused ? C.border.active : null;
  return (
    <>
      <View style={[s.entryRow, env.stacked && s.entryRowStacked]}>
        <View style={s.entryLabel}>
          <Txt type="rowTitle" nativeID={`${o.id}.label`}>{o.label}</Txt>
          <Txt type="support" tone="secondary">{o.hint}</Txt>
        </View>
        <View style={[s.entryControls, env.stacked && s.fullWidth]}>
          <IconButton icon="minus" label={o.decLabel} id={`${o.id}.decrease`} boxed disabled={!o.canDec} onPress={() => o.onStep?.(-o.step)} />
          <View style={[s.entryCell, env.stacked && s.entryCellStacked]}>
            <TextInput
              ref={capture.ref} onLayout={capture.onLayout} testID={o.id}
              accessibilityLabel={`${o.label}, ${o.unit}`} accessibilityHint={o.error ? `${o.hint}. ${o.error}` : o.hint}
              accessibilityLabelledBy={`${o.id}.label`}
              value={o.value} onChangeText={o.onChange} keyboardType={o.keyboard} inputMode={o.keyboard === 'number-pad' ? 'numeric' : 'decimal'}
              autoComplete="off" autoCorrect={false} returnKeyType="done" onSubmitEditing={o.onSubmit}
              onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
              allowFontScaling={!env.webLarge}
              style={[s.entryInput, { fontFamily: env.webLarge ? t.dynamicType.accessibilityLarge.number.fontFamily : t.type.number.fontFamily,
                fontSize: env.webLarge ? t.dynamicType.accessibilityLarge.number.fontSize : t.type.number.fontSize,
                lineHeight: env.webLarge ? t.dynamicType.accessibilityLarge.number.lineHeight : t.type.number.lineHeight,
                letterSpacing: t.type.number.letterSpacing, color: C.text.primary }]}
            />
            <Txt type="support" tone="secondary" {...hidden}>{o.unit}</Txt>
            {ring ? <View pointerEvents="none" style={[s.entryRing, { borderColor: ring }]} /> : null}
          </View>
          <IconButton icon="plus" label={o.incLabel} id={`${o.id}.increase`} boxed disabled={!o.canInc} onPress={() => o.onStep?.(o.step)} />
        </View>
      </View>
      {o.error ? (
        <Box id="b.workout.value-error" style={s.entryError} accessibilityRole="alert">
          <Icon name="alert" size={L.icon.inline} color={C.status.error} />
          <Txt type="support" tone="error" style={s.shrink}>{o.error}</Txt>
        </Box>
      ) : null}
    </>
  );
}

// ---------- CMP-11 set record row ----------
export function SetRow({ ordinal, title, valuesType = 'rowTitle', valuesTone = 'primary', status, current, id, ariaLabel }: {
  ordinal: number; title: string; valuesType?: TypeRole; valuesTone?: TextTone; status: StatusText; current?: boolean; id?: string; ariaLabel?: string;
}) {
  const env = useEnv();
  return (
    <Box id={id} accessible accessibilityLabel={ariaLabel} style={[s.set, { borderBottomColor: dividerColor(env) }, current && s.setCurrent, env.stacked && s.wrap]}>
      <Txt type="sectionTitle" style={s.setOrdinal} {...hidden}>{ordinal}</Txt>
      <View style={s.setMain} {...hidden}><Txt type={valuesType} tone={valuesTone}>{title}</Txt></View>
      <View style={[s.setStatus, env.stacked && s.setStatusStacked]} {...hidden}><StatusLabel {...status} /></View>
    </Box>
  );
}

// ---------- CMP-12 cue disclosure ----------
export function Disclosure({ summary, content, open, onToggle, id, contentId }: {
  summary: string; content: string; open: boolean; onToggle?: () => void; id?: string; contentId?: string;
}) {
  const env = useEnv();
  const capture = useCapture(id);
  const turn = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    turn.value = env.reduceMotion ? (open ? 1 : 0) : withTiming(open ? 1 : 0, { duration: t.motion.duration.state, easing: easeOut });
  }, [open, env.reduceMotion, turn]);
  // Package interaction cue-toggle: chevron rotates 180° when expanded.
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 180}deg` }] }));
  const border = dividerColor(env);
  return (
    <View style={[s.disclosure, { borderTopColor: border, borderBottomColor: border }]}>
      <Pressable ref={capture.ref} onLayout={capture.onLayout} testID={id} accessibilityRole="button" accessibilityLabel={summary}
        accessibilityState={{ expanded: open }} onPress={onToggle} style={({ pressed }) => [s.disclosureSummary, pressed && s.pressed]}>
        <Txt type="bodyStrong" style={s.shrink}>{summary}</Txt>
        <Animated.View style={chevron}><Icon name="chevron-down" size={L.disclosure.iconSize} /></Animated.View>
      </Pressable>
      {open ? <Box id={contentId} style={s.disclosureContent}><Txt type="body">{content}</Txt></Box> : null}
    </View>
  );
}

// ---------- CMP-13 change proposal ----------
export type Fact = { text: string; type?: TypeRole; aria?: string };
export function Proposal({ id, title, facts, rows, note, notice, action }: {
  id?: string; title: string; facts: Fact[]; rows: TrainingRowProps[]; note?: string; notice?: ReactNode; action?: ReactNode;
}) {
  return (
    <Box id={id} style={s.proposal} accessibilityLabel={title}>
      <Txt type="sectionTitle" accessibilityRole="header">{title}</Txt>
      <View style={s.proposalFacts}>
        {facts.map((f) => <Txt key={f.text} type={f.type ?? 'support'} accessibilityLabel={f.aria}>{f.text}</Txt>)}
      </View>
      <View style={s.proposalRows}>{rows.map((r) => <TrainingRow key={r.id ?? r.title} {...r} compact onField />)}</View>
      {note ? <Txt type="support" tone="secondary">{note}</Txt> : null}
      {notice}
      {action}
    </Box>
  );
}
export function Compare({ id, before, after, rows }: { id?: string; before: string; after: string; rows: { label: string; from: string; to: string }[] }) {
  const env = useEnv();
  const border = { borderBottomColor: dividerColor(env) };
  const rowStyle = [s.compareRow, border, env.stacked && s.compareRowStacked];
  const value = [s.compareValue, env.stacked && s.compareValueStacked];
  return (
    <Box id={id} style={[s.compare, { borderTopColor: dividerColor(env) }]}>
      <View style={rowStyle} {...hidden}>
        <View style={s.compareLabel} />
        <Txt type="support" tone="secondary" style={value}>{before}</Txt>
        <Txt type="support" tone="secondary" style={value}>{after}</Txt>
      </View>
      {rows.map((r) => (
        <View key={r.label} style={rowStyle} accessible accessibilityLabel={`${r.label}: ${before.toLowerCase()} ${r.from}, ${after.toLowerCase()} ${r.to}`}>
          <Txt type="body" style={s.compareLabel}>{r.label}</Txt>
          <Txt type="body" tone="secondary" style={value}>{r.from}</Txt>
          <Txt type="bodyStrong" style={value}>{r.to}</Txt>
        </View>
      ))}
    </Box>
  );
}

// ---------- CMP-14 conversation turn ----------
export function ConversationTurn({ speaker, text, id, pending }: { speaker: 'you' | 'coach'; text: string; id?: string; pending?: boolean }) {
  const you = speaker === 'you';
  return (
    <Box id={id} style={[s.turn, you && s.turnYou]} accessibilityState={pending ? { busy: true } : undefined}>
      <Txt type="support" tone="secondary">{you ? 'You' : 'Form coach'}</Txt>
      <Txt type="body" tone={pending ? 'secondary' : 'primary'}>{text}</Txt>
    </Box>
  );
}

// ---------- CMP-15 composer ----------
export function Composer({ value, onChange, onSend, inputId = 'b.coach.message-input', sendId = 'b.coach.send-message' }: {
  value: string; onChange?: (value: string) => void; onSend?: () => void; inputId?: string; sendId?: string;
}) {
  const env = useEnv();
  const [focused, setFocused] = useState(false);
  const capture = useCapture(inputId);
  const empty = !value.trim();
  return (
    <View style={s.composer}>
      <Txt type="support" tone="secondary" nativeID={`${inputId}.label`}>Ask about this workout</Txt>
      <View style={s.composerRow}>
        <View style={s.composerFieldWrap}>
          <TextInput
            ref={capture.ref} onLayout={capture.onLayout} testID={inputId} multiline value={value} onChangeText={onChange}
            placeholder="I have 20 minutes today" placeholderTextColor={C.text.secondary}
            accessibilityLabel="Ask about this workout" accessibilityLabelledBy={`${inputId}.label`}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} allowFontScaling={!env.webLarge}
            style={[s.composerField, {
              fontFamily: (env.webLarge ? t.dynamicType.accessibilityLarge.body : t.type.body).fontFamily,
              fontSize: (env.webLarge ? t.dynamicType.accessibilityLarge.body : t.type.body).fontSize,
              lineHeight: (env.webLarge ? t.dynamicType.accessibilityLarge.body : t.type.body).lineHeight,
              color: C.text.primary,
            }]}
          />
          {focused ? <View pointerEvents="none" style={[s.entryRing, { borderColor: C.border.active }]} /> : null}
        </View>
        <IconButton icon="send" label="Send message" id={sendId} boxed disabled={empty} onPress={onSend} />
      </View>
    </View>
  );
}

// ---------- CMP-16 recorded-work chart ----------
export function Chart({ weeks, metric, selected, max, unit, onSelect, id = 'b.progress.chart', rowIds = true }: {
  weeks: Week[]; metric: 'sets' | 'sessions'; selected: string; max: number; unit: string; onSelect?: (week: string) => void; id?: string; rowIds?: boolean;
}) {
  const env = useEnv();
  return (
    <Box id={id} accessibilityLabel={`${metric === 'sets' ? 'Sets' : 'Sessions'} recorded in the last four weeks`} style={s.chart}>
      {weeks.map((w) => (
        <ChartRow key={w.weekStart} week={w} value={w[metric]} max={max} unit={unit} selected={w.weekStart === selected}
          id={rowIds ? `b.progress.week.${w.weekStart}` : undefined} onPress={() => onSelect?.(w.weekStart)} />
      ))}
      {env.stacked ? (
        <View style={s.chartScaleStacked} {...hidden}>
          <View style={s.chartScaleTrack}><Txt type="caption" tone="secondary">0</Txt><Txt type="caption" tone="secondary">{max} {unit}</Txt></View>
        </View>
      ) : (
        <View style={s.chartScale} {...hidden}>
          <View style={s.chartLabel} />
          <View style={s.chartScaleTrack}><Txt type="caption" tone="secondary">0</Txt><Txt type="caption" tone="secondary">{max} {unit}</Txt></View>
          <View style={s.chartValue} />
        </View>
      )}
    </Box>
  );
}
function ChartRow({ week, value, max, unit, selected, id, onPress }: {
  week: Week; value: number; max: number; unit: string; selected: boolean; id?: string; onPress: () => void;
}) {
  const env = useEnv();
  const capture = useCapture(id);
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const width = useSharedValue(pct);
  useEffect(() => {
    width.value = env.reduceMotion ? pct : withTiming(pct, { duration: t.motion.duration.state, easing: easeOut });
  }, [pct, env.reduceMotion, width]);
  const bar = useAnimatedStyle(() => ({ width: `${width.value}%` as `${number}%` }));
  const label = <Txt type="bodyStrong" style={env.stacked ? s.grow : s.chartLabel}>{week.label}</Txt>;
  const valueText = <Txt type="bodyStrong" style={[s.chartValueText, !env.stacked && s.chartValue]}>{value}</Txt>;
  const track = (
    <View style={[s.chartTrack, env.stacked && s.chartTrackStacked]}>
      {value > 0 ? <Animated.View style={[s.chartBar, bar]} /> : null}
    </View>
  );
  return (
    <Pressable ref={capture.ref} onLayout={capture.onLayout} testID={id} accessibilityRole="button"
      accessibilityLabel={`Week of ${week.label}, ${value} ${unit}${selected ? ', selected' : ''}`} accessibilityState={{ selected }}
      onPress={onPress} style={[s.chartRow, env.stacked && s.chartRowStacked, selected && s.rowSelected]}>
      {selected ? <View style={s.selectionRule} /> : null}
      {env.stacked ? <><View style={s.chartStackHead} {...hidden}>{label}{valueText}</View><View style={s.fullWidth} {...hidden}>{track}</View></>
        : <View style={s.chartInline} {...hidden}>{label}{track}{valueText}</View>}
    </Pressable>
  );
}

// ---------- CMP-17 inline notice ----------
const NOTICE: Record<'recorded' | 'attention' | 'error' | 'info', { icon: IconName; surface: string; color: string }> = {
  recorded: { icon: 'check', surface: C.status.recordedSurface, color: C.status.recorded },
  attention: { icon: 'alert', surface: C.status.attentionSurface, color: C.status.attention },
  error: { icon: 'alert', surface: C.status.errorSurface, color: C.status.error },
  info: { icon: 'info', surface: C.surface.field, color: C.text.primary },
};
export function Notice({ tone = 'info', title, body, action, id }: { tone?: keyof typeof NOTICE; title?: string; body?: string; action?: ReactNode; id?: string }) {
  const n = NOTICE[tone];
  const fade = useFadeIn();
  return (
    <Animated.View style={fade}>
      <Box id={id} style={[s.notice, { backgroundColor: n.surface }]} accessibilityRole={tone === 'error' ? 'alert' : 'summary'}
        accessibilityLiveRegion="polite">
        <Icon name={n.icon} size={L.notice.iconSize} color={n.color} />
        <View style={s.noticeBody}>
          {title ? <Txt type="bodyStrong">{title}</Txt> : null}
          {body ? <Txt type="support">{body}</Txt> : null}
          {action ? <View style={s.noticeAction}>{action}</View> : null}
        </View>
      </Box>
    </Animated.View>
  );
}

/** motion.duration.state color/opacity change for a status that just appeared; immediate with Reduce Motion. */
export function useFadeIn() {
  const env = useEnv();
  const opacity = useSharedValue(env.reduceMotion ? t.motion.opacity.visible : t.motion.opacity.hidden);
  useEffect(() => {
    opacity.value = env.reduceMotion ? t.motion.opacity.visible : withTiming(t.motion.opacity.visible, { duration: t.motion.duration.state, easing: easeOut });
  }, [env.reduceMotion, opacity]);
  return useAnimatedStyle(() => ({ opacity: opacity.value }));
}

// ---------- CMP-19 session summary ----------
export function Summary({ title, count, countLabel, note, filing }: { title: string; count: number; countLabel: string; note?: string; filing?: boolean }) {
  const env = useEnv();
  const animate = !!filing;
  const opacity = useSharedValue(animate ? t.motion.opacity.hidden : t.motion.opacity.visible);
  const travel = useSharedValue(animate && !env.reduceMotion ? -t.motion.travel.filing : t.motion.travel.reduced);
  useEffect(() => {
    if (!animate) return;
    if (env.reduceMotion) {
      // R22: Reduce Motion keeps a 120 ms linear crossfade with no travel.
      opacity.value = withTiming(t.motion.opacity.visible, { duration: t.motion.duration.reduced, easing: linear });
    } else {
      opacity.value = withTiming(t.motion.opacity.visible, { duration: t.motion.duration.filing, easing: easeOut });
      travel.value = withTiming(t.motion.travel.reduced, { duration: t.motion.duration.filing, easing: easeOut });
    }
  }, [animate, env.reduceMotion, opacity, travel]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateY: travel.value }] }));
  return (
    <Animated.View style={style}>
      <Box id="b.workout.summary" style={s.summary} accessibilityLabel={title}>
        <Txt type="sectionTitle" accessibilityRole="header">{title}</Txt>
        <Box id="b.workout.summary.set-count" style={s.total}>
          <Txt type="metric">{count}</Txt>
          <Txt type="bodyStrong">{countLabel}</Txt>
        </Box>
        {note ? <Txt type="support" tone="secondary">{note}</Txt> : null}
      </Box>
    </Animated.View>
  );
}

/** Selected-week total (Progress) shares the summary's metric + label anatomy. */
export function Total({ value, label, id, unitId }: { value: number; label: string; id?: string; unitId?: string }) {
  return (
    <Box id={id} style={s.total} accessible accessibilityLabel={`${value} ${label}`}>
      <Txt type="metric">{value}</Txt>
      <Txt type="bodyStrong" captureId={unitId}>{label}</Txt>
    </Box>
  );
}

// ---------- page rhythm ----------
export function Section({ children, gap = 'sm', first, id }: { children: ReactNode; gap?: 'xs' | 'sm' | 'md' | 'base'; first?: boolean; id?: string }) {
  return <Box id={id} style={[first ? s.sectionFirst : s.section, { gap: t.space[gap] }]}>{children}</Box>;
}

export function Skeleton({ kind }: { kind: 'title' | 'line' }) {
  return <View style={[s.skeleton, kind === 'title' ? s.skeletonTitle : s.skeletonLine]} {...hidden} />;
}

const s = StyleSheet.create({
  grow: { flexGrow: 1, flexShrink: 1 },
  shrink: { flexShrink: 1 },
  wrap: { flexWrap: 'wrap' },
  alignStart: { alignSelf: 'flex-start' },
  fullWidth: { width: '100%' },
  centerText: { textAlign: 'center' },
  underline: { textDecorationLine: 'underline', textDecorationColor: C.text.primary },
  pressed: { backgroundColor: C.surface.subtle },

  header: { minHeight: L.header.minHeight, paddingTop: L.screen.contentTopGap, paddingBottom: L.header.bottomGap, gap: L.header.titleGap },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: t.space.md },

  tabbar: {
    flexDirection: 'row', paddingTop: L.tabBar.topPadding, paddingHorizontal: L.tabBar.horizontalPadding,
    backgroundColor: C.surface.paper, borderTopWidth: t.stroke.divider,
  },
  tab: { flexGrow: 1, flexShrink: 1, flexBasis: 0, height: L.tabBar.contentHeight, alignItems: 'center', justifyContent: 'flex-start', gap: L.tabBar.iconLabelGap },
  tabMark: { width: L.tabBar.selectionWidth, height: L.tabBar.selectionHeight, marginTop: L.tabBar.selectionGap, borderRadius: t.radius.none },

  dock: {
    minHeight: L.dock.minHeight, paddingVertical: L.dock.verticalPadding, paddingHorizontal: L.dock.horizontalPadding,
    gap: L.dock.gap, backgroundColor: C.surface.canvas, borderTopWidth: t.stroke.divider,
  },

  heading: { gap: t.space.xs },
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: t.space.md },

  label: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: L.statusLabel.iconGap,
    paddingVertical: L.statusLabel.paddingVertical, paddingHorizontal: L.statusLabel.paddingHorizontal,
    borderRadius: t.radius.status, borderCurve: 'continuous',
  },
  labelPlain: { paddingHorizontal: t.space.none },

  rail: { width: L.rail.width, alignItems: 'flex-start' },
  railBoard: {
    width: L.rail.width, alignSelf: 'stretch', alignItems: 'stretch', paddingTop: L.board.paddingTop,
    backgroundColor: C.surface.rail, borderLeftWidth: L.rail.leadingRule, borderLeftColor: C.border.active,
  },
  railNum: {
    minWidth: L.rail.numberMinSize, minHeight: L.rail.numberMinSize, alignItems: 'center', justifyContent: 'center',
    borderWidth: t.stroke.active, borderRadius: t.radius.status, borderCurve: 'continuous',
  },
  railMark: { marginTop: t.space.sm, width: L.sportingMark.longArm, height: L.sportingMark.stroke, backgroundColor: C.border.active },

  board: { flexDirection: 'row', backgroundColor: C.surface.field, borderRadius: t.radius.content, borderCurve: 'continuous', overflow: 'hidden' },
  boardBody: {
    flexGrow: 1, flexShrink: 1, paddingTop: L.board.paddingTop, paddingRight: L.board.paddingHorizontal,
    paddingBottom: L.board.paddingBottom, paddingLeft: L.rail.gap, gap: L.board.contentGap,
  },
  boardTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: t.space.md },
  boardAction: { marginTop: t.space.sm },
  counts: { flexDirection: 'row', flexWrap: 'wrap', columnGap: t.space.md, rowGap: t.space.xs },
  countsMiddle: { alignItems: 'center' },
  countsStacked: { flexDirection: 'column', alignItems: 'flex-start' },
  skeleton: { backgroundColor: C.surface.rail, borderRadius: t.radius.status, alignSelf: 'flex-start' },
  skeletonTitle: { width: L.loading.titleWidth, height: L.loading.titleHeight },
  skeletonLine: { width: L.loading.lineWidth, height: L.loading.lineHeight },

  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: L.rail.gap, minHeight: L.trainingRow.minHeight,
    paddingVertical: L.trainingRow.paddingVertical, borderBottomWidth: t.stroke.divider, width: '100%',
  },
  rowWeek: { minHeight: L.weekRow.minHeight, paddingVertical: L.weekRow.paddingVertical },
  rowCompact: { minHeight: L.icon.hit, paddingVertical: t.space.xs, alignItems: 'center' },
  rowMain: { flexGrow: 1, flexShrink: 1, gap: L.trainingRow.titleGap },
  rowTrail: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: t.space.xs, minHeight: L.icon.hit },
  rowTrailCompact: { minHeight: t.space.none },
  rowTrailStacked: { flexGrow: 1, flexShrink: 1, flexBasis: '100%', paddingLeft: L.rail.width, marginLeft: L.rail.gap, alignSelf: 'flex-start' },
  rowSelected: { backgroundColor: C.surface.subtle },
  rowSelectedStacked: { paddingLeft: t.space.sm },
  selectionRule: { position: 'absolute', top: 0, bottom: 0, left: 0, width: L.weekRow.selectionRule, backgroundColor: C.border.active },
  gutter: { width: L.rail.width, alignItems: 'center' },

  primary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: L.button.iconGap, width: '100%',
    minHeight: L.button.minHeight, paddingVertical: L.button.paddingVertical, paddingHorizontal: L.button.paddingHorizontal,
    borderRadius: t.radius.control, borderCurve: 'continuous',
  },
  link: { flexDirection: 'row', alignItems: 'center', gap: t.space.xs, minHeight: L.secondaryAction.minHeight, padding: t.space.none },
  outline: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.space.sm, minHeight: L.secondaryAction.minHeight,
    paddingVertical: L.secondaryAction.paddingVertical, paddingHorizontal: L.secondaryAction.paddingHorizontal,
    borderColor: C.border.active, borderRadius: t.radius.control, borderCurve: 'continuous', backgroundColor: C.surface.paper,
  },
  iconButton: { width: L.icon.hit, height: L.icon.hit, alignItems: 'center', justifyContent: 'center', borderRadius: t.radius.control, borderCurve: 'continuous' },
  iconButtonBoxed: { backgroundColor: C.surface.paper, borderWidth: t.stroke.control, borderColor: C.border.control },
  iconButtonDisabled: { backgroundColor: C.surface.disabled, borderColor: C.surface.disabled },

  segment: {
    flexDirection: 'row', padding: L.segment.inset, borderRadius: t.radius.control, borderCurve: 'continuous',
    backgroundColor: C.surface.subtle, borderWidth: t.stroke.control,
  },
  segmentItem: {
    flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: L.segment.minHeight, paddingVertical: L.segment.paddingVertical,
    paddingHorizontal: L.segment.paddingHorizontal, alignItems: 'center', justifyContent: 'center',
    borderRadius: L.segment.innerRadius, borderCurve: 'continuous', borderWidth: t.stroke.control, borderColor: C.overlay.transparent,
  },
  segmentItemOn: { backgroundColor: C.surface.paper, borderColor: C.border.control },

  entryRow: { flexDirection: 'row', alignItems: 'center', gap: L.entry.labelColumnGap },
  entryRowStacked: { flexDirection: 'column', alignItems: 'stretch' },
  entryLabel: { flexGrow: 1, flexShrink: 1, gap: L.numericField.hintGap },
  entryControls: { flexDirection: 'row', alignItems: 'center', gap: L.numericField.stepperGap },
  entryCell: {
    width: L.entry.valueCellWidth, minHeight: L.numericField.minHeight, paddingVertical: L.numericField.paddingVertical,
    paddingHorizontal: L.numericField.paddingHorizontal, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center',
    gap: L.numericField.unitGap, backgroundColor: C.surface.paper, borderWidth: t.stroke.control, borderColor: C.border.control,
    borderRadius: t.radius.control, borderCurve: 'continuous',
  },
  entryCellStacked: { flexGrow: 1, flexShrink: 1, width: 'auto' },
  entryInput: { flexGrow: 1, flexShrink: 1, minWidth: 0, padding: t.space.none, margin: t.space.none, textAlign: 'right' },
  entryRing: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderWidth: t.stroke.focus, borderRadius: t.radius.control, borderCurve: 'continuous' },
  entryError: { flexDirection: 'row', alignItems: 'flex-start', gap: t.space.sm },

  set: {
    flexDirection: 'row', alignItems: 'center', gap: L.setRow.columnGap, minHeight: L.setRow.minHeight,
    paddingVertical: L.setRow.paddingVertical, borderBottomWidth: t.stroke.divider,
  },
  setCurrent: { backgroundColor: C.surface.subtle },
  setOrdinal: { width: L.setRow.ordinalWidth, textAlign: 'center' },
  setMain: { flexGrow: 1, flexShrink: 1, gap: t.space.xs },
  setStatus: { flexDirection: 'row', alignItems: 'center', gap: L.setRow.statusGap },
  setStatusStacked: { flexGrow: 1, flexShrink: 1, flexBasis: '100%', paddingLeft: L.setRow.ordinalWidth, marginLeft: L.setRow.columnGap },

  disclosure: { borderTopWidth: t.stroke.divider, borderBottomWidth: t.stroke.divider },
  disclosureSummary: {
    width: '100%', minHeight: L.disclosure.minHeight, paddingVertical: L.disclosure.paddingVertical,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.md,
  },
  disclosureContent: { paddingBottom: L.disclosure.paddingVertical },

  proposal: {
    backgroundColor: C.surface.field, borderRadius: t.radius.content, borderCurve: 'continuous',
    paddingTop: L.proposal.paddingTop, paddingHorizontal: L.proposal.paddingHorizontal, paddingBottom: L.proposal.paddingBottom,
    gap: L.proposal.rowGap,
  },
  proposalFacts: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: t.space.md, rowGap: t.space.xs },
  proposalRows: { borderTopWidth: t.stroke.divider, borderTopColor: C.border.control },

  compare: { borderTopWidth: t.stroke.divider },
  compareRow: {
    flexDirection: 'row', alignItems: 'baseline', gap: t.space.md, minHeight: L.icon.hit,
    paddingVertical: t.space.sm, borderBottomWidth: t.stroke.divider,
  },
  compareRowStacked: { flexDirection: 'column', alignItems: 'flex-start' },
  compareLabel: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  compareValue: { width: L.entry.valueCellWidth, textAlign: 'right' },
  compareValueStacked: { width: 'auto', textAlign: 'left' },

  turn: { gap: L.conversation.speakerGap },
  turnYou: { paddingLeft: L.conversation.userInset, borderLeftWidth: L.conversation.userRule, borderLeftColor: C.border.active },

  composer: { gap: t.space.xs },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: L.composer.controlGap },
  composerFieldWrap: { flexGrow: 1, flexShrink: 1 },
  composerField: {
    minHeight: L.composer.minHeight, maxHeight: L.composer.maxHeight, paddingVertical: L.composer.paddingVertical,
    paddingHorizontal: L.composer.paddingHorizontal, backgroundColor: C.surface.paper, borderWidth: t.stroke.control,
    borderColor: C.border.control, borderRadius: t.radius.control, borderCurve: 'continuous', textAlignVertical: 'top',
  },

  chart: { minHeight: L.chart.minHeight, gap: t.space.xs },
  chartRow: { minHeight: L.chart.rowMinHeight, width: '100%', paddingLeft: t.space.sm, justifyContent: 'center' },
  chartRowStacked: { paddingVertical: t.space.sm, gap: L.chart.accessibilityRowGap },
  chartInline: { flexDirection: 'row', alignItems: 'center', gap: L.chart.columnGap },
  chartStackHead: { flexDirection: 'row', alignItems: 'center', gap: L.chart.columnGap },
  chartLabel: { width: L.chart.labelWidth },
  chartValue: { width: L.chart.valueWidth },
  chartValueText: { textAlign: 'right' },
  chartTrack: {
    flexGrow: 1, flexShrink: 1, minWidth: 0, height: L.chart.barHeight, flexDirection: 'row', backgroundColor: C.chart.track,
    borderLeftWidth: L.chart.baselineWidth, borderLeftColor: C.chart.axis,
    borderTopRightRadius: t.radius.chart, borderBottomRightRadius: t.radius.chart,
  },
  chartTrackStacked: { width: '100%' },
  chartBar: { height: '100%', backgroundColor: C.chart.bar, borderTopRightRadius: t.radius.chart, borderBottomRightRadius: t.radius.chart },
  chartScale: { flexDirection: 'row', gap: L.chart.columnGap, paddingLeft: t.space.sm, marginTop: L.chart.tickGap },
  chartScaleStacked: { flexDirection: 'row', paddingLeft: t.space.sm, marginTop: L.chart.tickGap },
  chartScaleTrack: { flexGrow: 1, flexShrink: 1, flexDirection: 'row', justifyContent: 'space-between' },

  notice: {
    flexDirection: 'row', alignItems: 'flex-start', gap: L.notice.gap, padding: L.notice.padding,
    borderRadius: t.radius.content, borderCurve: 'continuous',
  },
  noticeBody: { flexGrow: 1, flexShrink: 1, gap: t.space.xs },
  noticeAction: { alignSelf: 'flex-start', minHeight: L.notice.actionMinHeight },

  summary: { backgroundColor: C.surface.field, borderRadius: t.radius.content, borderCurve: 'continuous', padding: L.summary.padding, gap: L.summary.totalGap },
  total: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: t.space.sm },

  section: { marginTop: L.screen.sectionGap },
  sectionFirst: { marginTop: t.space.md },
});
export const componentStyles = s;
