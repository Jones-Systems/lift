// One Lucide icon API for Form screens. Open Mat icons render through the generated module; the five v1
// additions below are transcribed unchanged from design/form-onboarding/v1/assets/icons/*.svg (Lucide 1.34.0,
// ISC, see that directory's LUCIDE-LICENSE.txt); the extended set in lucideIcons.ts is copied unmodified
// from lucide-react 1.33.0. Every icon shares one style: 24 viewBox, token stroke, round caps and joins.
import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';
import { Icon as OpenMatIcon } from '../../variants/a/art';
import { icons as openMatIcons, type IconName as OpenMatIconName } from '../../variants/a/assets/generatedicons';
import { lucideIcons, type LucideIconName, type LucideNode } from './lucideIcons';
import { t } from './tokens';

const added = {
  mic: [
    { tag: 'path', d: 'M12 19v3' },
    { tag: 'path', d: 'M19 10v2a7 7 0 0 1-14 0v-2' },
    { tag: 'rect', x: 9, y: 2, width: 6, height: 13, rx: 3 },
  ],
  'mic-off': [
    { tag: 'path', d: 'M12 19v3' },
    { tag: 'path', d: 'M15 9.34V5a3 3 0 0 0-5.68-1.33' },
    { tag: 'path', d: 'M16.95 16.95A7 7 0 0 1 5 12v-2' },
    { tag: 'path', d: 'M18.89 13.23A7 7 0 0 0 19 12v-2' },
    { tag: 'path', d: 'm2 2 20 20' },
    { tag: 'path', d: 'M9 9v3a3 3 0 0 0 5.12 2.12' },
  ],
  lock: [
    { tag: 'rect', x: 3, y: 11, width: 18, height: 11, rx: 2 },
    { tag: 'path', d: 'M7 11V7a5 5 0 0 1 10 0v4' },
  ],
  'grip-vertical': [
    { tag: 'circle', cx: 9, cy: 12, r: 1 }, { tag: 'circle', cx: 9, cy: 5, r: 1 }, { tag: 'circle', cx: 9, cy: 19, r: 1 },
    { tag: 'circle', cx: 15, cy: 12, r: 1 }, { tag: 'circle', cx: 15, cy: 5, r: 1 }, { tag: 'circle', cx: 15, cy: 19, r: 1 },
  ],
  'rotate-ccw': [
    { tag: 'path', d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' },
    { tag: 'path', d: 'M3 3v5h5' },
  ],
} as const satisfies Record<string, readonly LucideNode[]>;

export type IconName = OpenMatIconName | keyof typeof added | LucideIconName;

/** Icon sizes in points (Open Mat layout.icon plus two larger steps). Prefer a name over a number. */
export const iconSize = {
  status: t.layout.icon.status,
  inline: t.layout.icon.inline,
  notice: t.layout.icon.notice,
  nav: t.layout.icon.nav,
  standard: t.layout.icon.standard,
  large: 32,
  hero: 48,
} as const;

export type IconSize = keyof typeof iconSize;

/**
 * Semantic icon choices so every screen uses the same glyph for the same meaning: `undo-2` only for Undo,
 * `rotate-cw` for Retry, `wifi-off` for offline, and so on.
 */
export const semanticIcon = {
  retry: 'rotate-cw',
  refresh: 'refresh-cw',
  undo: 'undo-2',
  redo: 'redo-2',
  offline: 'wifi-off',
  online: 'wifi',
  syncFailed: 'cloud-off',
  info: 'info',
  success: 'circle-check',
  warning: 'triangle-alert',
  error: 'circle-alert',
  blocked: 'octagon-alert',
  dismiss: 'x',
  busy: 'loader-circle',
  edit: 'pencil',
  remove: 'trash-2',
  settings: 'settings',
  account: 'user-round',
  history: 'rotate-ccw-clock',
  timer: 'timer',
  play: 'play',
  pause: 'pause',
  bugReport: 'bug',
  feedback: 'message-square-warning',
  help: 'circle-question-mark',
} as const satisfies Record<string, IconName>;

function isOpenMat(name: IconName): name is OpenMatIconName {
  return name in openMatIcons;
}

function nodesFor(name: IconName): readonly LucideNode[] | null {
  if (name in added) return added[name as keyof typeof added];
  if (name in lucideIcons) return lucideIcons[name as LucideIconName];
  return null;
}

/** True when `name` is drawable by `Icon` (useful for data-driven names). */
export function hasIcon(name: string): name is IconName {
  return name in openMatIcons || name in added || name in lucideIcons;
}

/** Every icon name the shared API can draw. */
export const iconNames: readonly IconName[] = [
  ...(Object.keys(openMatIcons) as OpenMatIconName[]),
  ...(Object.keys(added) as (keyof typeof added)[]),
  ...(Object.keys(lucideIcons) as LucideIconName[]),
];

function renderNode(node: LucideNode, key: number, color: string) {
  switch (node.tag) {
    case 'path': return <Path key={key} d={node.d} />;
    case 'rect': return <Rect key={key} x={node.x} y={node.y} width={node.width} height={node.height} rx={node.rx} ry={node.ry} />;
    case 'circle': return <Circle key={key} cx={node.cx} cy={node.cy} r={node.r} fill={node.fill ? color : undefined} />;
    case 'line': return <Line key={key} x1={node.x1} y1={node.y1} x2={node.x2} y2={node.y2} />;
    case 'polyline': return <Polyline key={key} points={node.points} />;
  }
}

export type IconProps = {
  name: IconName;
  /** Points or an `iconSize` name. Defaults to `standard` (24). */
  size?: number | IconSize;
  /** Defaults to `t.color.ink`. */
  color?: string;
  /**
   * Decorative by default (hidden from assistive tech; labels live on the controls). Give a label only
   * when the icon alone carries meaning, such as a status glyph with no adjacent text.
   */
  accessibilityLabel?: string;
  testID?: string;
};

/** Lucide outline icon at the shared 2 pt stroke. */
export function Icon({ name, size = 'standard', color = t.color.ink, accessibilityLabel, testID }: IconProps) {
  const points = typeof size === 'number' ? size : iconSize[size];
  const a11y = accessibilityLabel
    ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel }
    : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
  if (isOpenMat(name) && !accessibilityLabel && !testID) return <OpenMatIcon name={name} size={points} color={color} />;
  const nodes = isOpenMat(name) ? (openMatIcons[name].elements as unknown as readonly LucideNode[]) : nodesFor(name);
  return (
    <Svg testID={testID} width={points} height={points} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={t.stroke.icon}
      strokeLinecap="round" strokeLinejoin="round" {...a11y}>
      {(nodes ?? []).map((node, i) => renderNode(node, i, color))}
    </Svg>
  );
}
