// Open Mat primitives: text roles, CMP-A02 PageHeader, CMP-A04 PrimaryAction,
// CMP-A05 PlainAction, CMP-A12 Notice, CMP-A15 PromptChoice and the metadata line.
// Every visual value comes from the generated tokens (./tokens.ts via ./theme).
import { useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View, type StyleProp, type TextProps, type TextStyle, type ViewStyle } from 'react-native';
import Reanimated, { interpolateColor, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Icon } from './art';
import type { IconName } from './assets/generatedicons';
import { useCapture } from './capture';
import { L, maxMultiplier, t, typeStyles, useEssentialOutline, useTextScale, type ColorRole, type TypeRole } from './theme';

/* ---------------- text ---------------- */

export type TxtProps = Omit<TextProps, 'role'> & { role?: TypeRole; tone?: ColorRole; captureId?: string };

/** One Text per type token: exact family alias, absolute line height, tracking; scales with Dynamic Type. */
export function Txt({ role = 'body', tone = 'ink', captureId, style, ...rest }: TxtProps) {
  const ref = useCapture(captureId);
  return (
    <Text ref={ref} testID={captureId} maxFontSizeMultiplier={maxMultiplier(role)} {...rest}
      style={[typeStyles[role], tones[tone], style]} />
  );
}

const tones = StyleSheet.create(
  Object.fromEntries((Object.keys(t.color) as (keyof typeof t.color)[])
    .filter((key) => typeof t.color[key] === 'string')
    .map((key) => [key, { color: t.color[key] as string }])) as Record<ColorRole, TextStyle>,
);

/* ---------------- spacing helpers (token margins only) ---------------- */

type SpaceKey = keyof typeof t.space;
const marginTops = StyleSheet.create(
  Object.fromEntries((Object.keys(t.space) as SpaceKey[]).map((key) => [key, { marginTop: t.space[key] }])) as Record<SpaceKey, ViewStyle>,
);
/** marginTop from the space scale, e.g. mt('s20'). */
export const mt = (key: SpaceKey) => marginTops[key];

export function Gutter({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.gutter, style]}>{children}</View>;
}

/* ---------------- CMP-A02 PageHeader ---------------- */

/** Nav row (44 high, 8 below the safe area via the page padding) with an optional trailing element. */
export function NavRow({ title, titleRole = 'bodyStrong', trailing }: { title: string; titleRole?: TypeRole; trailing?: ReactNode }) {
  const { large } = useTextScale();
  return (
    <View style={[s.nav, large && s.navLarge]}>
      <Txt role={titleRole}>{title}</Txt>
      {trailing ?? null}
    </View>
  );
}

/** Page title (pageTitle or display role) 16 below the nav; the screen's accessibility header. */
export function PageTitle({ text, captureId, role = 'pageTitle', style }: { text: string; captureId?: string; role?: TypeRole; style?: StyleProp<TextStyle> }) {
  return <Txt role={role} accessibilityRole="header" captureId={captureId} style={[s.pageTitle, style]}>{text}</Txt>;
}

/* ---------------- CMP-A04 PrimaryAction ---------------- */

export type PrimaryProps = {
  label: string;
  captureId?: string;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon?: IconName;
  /** Showcase-only forced states; never used on product routes. */
  forced?: 'pressed' | 'focused';
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

/** Filled action-green button, min 56, radius 28. Pressed is instant; it returns over motion.press. */
export function PrimaryAction({ label, captureId, onPress, disabled, loading, icon, forced, accessibilityLabel, style }: PrimaryProps) {
  const ref = useCapture(captureId);
  const pressed = useSharedValue<number>(forced === 'pressed' ? 1 : 0);
  const [focused, setFocused] = useState(forced === 'focused');
  const inactive = !!disabled || !!loading;
  const outline = useEssentialOutline();
  const fill = useAnimatedStyle(() => {
    if (inactive) return {};
    const color = interpolateColor(pressed.value, [0, 1], [t.color.action, t.color.actionPressed]);
    return { backgroundColor: color, borderColor: color };
  });
  const iconName: IconName | undefined = loading ? 'loader-circle' : icon;
  const fg = inactive ? t.color.secondary : t.color.onAction;
  return (
    <Pressable
      ref={ref}
      testID={captureId}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: inactive, busy: !!loading }}
      disabled={inactive}
      onPress={inactive ? undefined : onPress}
      onPressIn={() => { if (!forced) pressed.value = 1; }}
      onPressOut={() => { if (!forced) pressed.value = withTiming(0, { duration: t.motion.press }); }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(forced === 'focused')}
      style={[s.primaryHost, style]}
    >
      <Reanimated.View style={[s.primary, inactive && s.primaryDisabled, inactive && outline, fill]}>
        {iconName ? <Icon name={iconName} size={L.icon.standard} color={fg} /> : null}
        <Txt role="button" style={[s.primaryLabel, { color: fg }]}>{label}</Txt>
      </Reanimated.View>
      {focused ? <View pointerEvents="none" style={s.focusRing} /> : null}
    </Pressable>
  );
}

/* ---------------- CMP-A05 PlainAction ---------------- */

export type PlainProps = {
  label: string;
  captureId?: string;
  onPress?: () => void;
  /** Trailing chevron (default chevron-right); null for none. */
  chevron?: IconName | null;
  lead?: IconName;
  placement?: 'leading' | 'trailing' | 'centered';
  tone?: 'action' | 'ink';
  disabled?: boolean;
  expanded?: boolean;
  forcedPressed?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

/** Action-green text action, min 44, optional 16 pt chevron; pressed fills selection. */
export function PlainAction({ label, captureId, onPress, chevron = 'chevron-right', lead, placement = 'leading', tone = 'action', disabled, expanded, forcedPressed, accessibilityLabel, style }: PlainProps) {
  const ref = useCapture(captureId);
  const color = disabled ? t.color.secondary : tone === 'ink' ? t.color.ink : t.color.action;
  return (
    <Pressable
      ref={ref}
      testID={captureId}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled, expanded }}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        s.plain,
        placement === 'trailing' && s.plainTrailing,
        placement === 'centered' && s.plainCentered,
        (pressed || forcedPressed) && !disabled && s.plainPressed,
        style,
      ]}
    >
      {lead ? <Icon name={lead} size={L.icon.inline} color={color} /> : null}
      <Txt role="bodyStrong" style={{ color }}>{label}</Txt>
      {chevron ? <Icon name={chevron} size={L.icon.inline} color={color} /> : null}
    </Pressable>
  );
}

/* ---------------- metadata line ---------------- */

/** Spaced metadata items (16 column gap); stacks at large text. */
export function MetaLine({ items, captureId, style }: { items: readonly string[]; captureId?: string; style?: StyleProp<ViewStyle> }) {
  const { large } = useTextScale();
  const ref = useCapture(captureId);
  return (
    <View ref={ref} testID={captureId} style={[s.meta, large && s.metaLarge, style]}>
      {items.map((item) => <Txt key={item} role="meta" tone="secondary">{item}</Txt>)}
    </View>
  );
}

/* ---------------- CMP-A12 Notice ---------------- */

export type NoticeKind = 'success' | 'warning' | 'error' | 'info';
const NOTICE: Record<NoticeKind, { icon: IconName; bg: string; fg: string }> = {
  success: { icon: 'circle-check', bg: t.color.successSurface, fg: t.color.success },
  warning: { icon: 'triangle-alert', bg: t.color.warningSurface, fg: t.color.warning },
  error: { icon: 'circle-alert', bg: t.color.errorSurface, fg: t.color.error },
  info: { icon: 'info', bg: t.color.selection, fg: t.color.ink },
};

export type NoticeAction = { label: string; captureId?: string; onPress?: () => void; icon?: IconName };

/** Icon + words carry the meaning; an action-bearing notice never auto-dismisses. Announced once. */
export function Notice({ kind, text, action, captureId = 'a-notice', announce = false, style }: {
  kind: NoticeKind; text: string; action?: NoticeAction | null; captureId?: string | null; announce?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const spec = NOTICE[kind];
  const id = captureId ?? undefined;
  const ref = useCapture(id);
  useEffect(() => {
    if (announce) AccessibilityInfo.announceForAccessibility(text);
  }, [announce, text]);
  return (
    <View ref={ref} testID={id} accessibilityLiveRegion="polite" style={[s.notice, { backgroundColor: spec.bg }, style]}>
      <View style={s.noticeIcon}><Icon name={spec.icon} size={L.icon.notice} color={spec.fg} /></View>
      <View style={s.noticeBody}>
        <Txt role="body" style={{ color: spec.fg }}>{text}</Txt>
        {action ? (
          <PlainAction label={action.label} captureId={action.captureId} onPress={action.onPress} lead={action.icon ?? 'undo-2'}
            chevron={null} tone="ink" style={s.noticeAction} />
        ) : null}
      </View>
    </View>
  );
}

/* ---------------- CMP-A15 PromptChoice ---------------- */

export function PromptChoice({ label, captureId, onPress, selected, forcedPressed }: {
  label: string; captureId?: string; onPress?: () => void; selected?: boolean; forcedPressed?: boolean;
}) {
  const ref = useCapture(captureId);
  const outline = useEssentialOutline();
  return (
    <Pressable ref={ref} testID={captureId} accessibilityRole="button" accessibilityState={{ selected: !!selected }} onPress={onPress}
      style={({ pressed }) => [s.prompt, outline, (pressed || forcedPressed) && s.promptPressed, selected && s.promptSelected]}>
      <Txt role="bodyStrong">{label}</Txt>
    </Pressable>
  );
}

/* ---------------- styles ---------------- */

const ring = L.button.focusOffset + L.button.focusWidth;

const s = StyleSheet.create({
  gutter: { paddingHorizontal: L.frame.gutter },
  nav: {
    minHeight: L.frame.navHeight, paddingHorizontal: L.frame.gutter, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: t.space.s12, flexWrap: 'wrap',
  },
  navLarge: { paddingVertical: t.space.s4 },
  pageTitle: { marginTop: L.header.titleGap },
  primaryHost: { alignSelf: 'stretch' },
  primary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: L.button.iconGap,
    minHeight: L.button.minHeight, paddingVertical: L.button.paddingY, paddingHorizontal: L.button.paddingX,
    borderRadius: t.radius.button, borderCurve: 'continuous', borderWidth: t.stroke.control,
    backgroundColor: t.color.action, borderColor: t.color.action,
  },
  primaryDisabled: { backgroundColor: t.color.disabledSurface, borderColor: t.color.controlBorder },
  primaryLabel: { textAlign: 'center', flexShrink: 1 },
  focusRing: {
    position: 'absolute', top: -ring, right: -ring, bottom: -ring, left: -ring,
    borderWidth: L.button.focusWidth, borderColor: t.color.ink, borderRadius: t.radius.button + ring, borderCurve: 'continuous',
  },
  plain: {
    flexDirection: 'row', alignItems: 'center', gap: L.plainAction.iconGap, minHeight: L.plainAction.minHeight,
    paddingTop: L.plainAction.paddingY, paddingBottom: L.plainAction.paddingY, paddingRight: L.plainAction.paddingX,
    paddingLeft: t.space.s0, alignSelf: 'flex-start', borderRadius: t.radius.small, borderCurve: 'continuous',
  },
  plainTrailing: { alignSelf: 'auto', paddingLeft: L.plainAction.paddingX, paddingRight: t.space.s0 },
  plainCentered: { alignSelf: 'center', paddingLeft: L.plainAction.paddingX },
  plainPressed: { backgroundColor: t.color.selection },
  meta: { flexDirection: 'row', flexWrap: 'wrap', columnGap: t.space.s16 },
  metaLarge: { flexDirection: 'column' },
  notice: {
    borderRadius: t.radius.notice, borderCurve: 'continuous', padding: L.notice.padding,
    flexDirection: 'row', gap: L.notice.iconGap, alignItems: 'flex-start',
  },
  noticeIcon: { marginTop: t.space.s2 },
  noticeBody: { flex: 1, gap: L.notice.textGap },
  noticeAction: { minHeight: L.notice.actionMinHeight },
  prompt: {
    minHeight: L.prompt.minHeight, borderRadius: t.radius.message, borderCurve: 'continuous', borderWidth: t.stroke.control,
    borderColor: t.color.controlBorder, paddingVertical: L.prompt.paddingY, paddingHorizontal: L.prompt.paddingX,
    justifyContent: 'center', alignSelf: 'flex-start',
  },
  promptPressed: { backgroundColor: t.color.selection },
  promptSelected: {
    borderWidth: t.stroke.selection, borderColor: t.color.ink, backgroundColor: t.color.selection,
    paddingVertical: t.space.s12, paddingHorizontal: t.space.s16,
  },
});
