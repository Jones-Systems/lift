// Icons for the v1 package. Open Mat icons render through the generated module; the five v1 additions
// below are transcribed unchanged from design/form-onboarding/v1/assets/icons/*.svg (Lucide 1.34.0, ISC,
// see that directory's LUCIDE-LICENSE.txt). Replace with generated output when generation is granted.
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { Icon as OpenMatIcon } from '../../variants/a/art';
import { icons as openMatIcons, type IconName as OpenMatIconName } from '../../variants/a/assets/generatedicons';
import { t } from './tokens';

type Node =
  | { tag: 'path'; d: string }
  | { tag: 'rect'; x: number; y: number; width: number; height: number; rx: number }
  | { tag: 'circle'; cx: number; cy: number; r: number };

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
} as const satisfies Record<string, readonly Node[]>;

export type IconName = OpenMatIconName | keyof typeof added;

function isOpenMat(name: IconName): name is OpenMatIconName {
  return name in openMatIcons;
}

/** Decorative icon (2 pt round Lucide outline); labels live on the controls. */
export function Icon({ name, size, color }: { name: IconName; size: number; color: string }) {
  if (isOpenMat(name)) return <OpenMatIcon name={name} size={size} color={color} />;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={t.stroke.icon}
      strokeLinecap="round" strokeLinejoin="round" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {(added[name] as readonly Node[]).map((node, i) => {
        if (node.tag === 'path') return <Path key={i} d={node.d} />;
        if (node.tag === 'rect') return <Rect key={i} x={node.x} y={node.y} width={node.width} height={node.height} rx={node.rx} />;
        return <Circle key={i} cx={node.cx} cy={node.cy} r={node.r} />;
      })}
    </Svg>
  );
}
