import React from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import { tokens as t } from '../generatedtokens';

// Owned outline paths copied from the sealed package's assets/app.js.
export const iconPaths = {
  today: 'M5 3h12v18H5z M9 3v18 M12 7h3 M12 11h3 M12 15h3',
  plan: 'M4 6h16v15H4z M4 10h16 M8 3v5 M16 3v5 M8 14h2 M14 14h2 M8 17h2',
  workout: 'M3 9v6 M6 6v12 M6 12h12 M18 6v12 M21 9v6',
  coach: 'M3 4h18v13H9l-5 4v-4H3z M7 8h10 M7 12h7',
  progress: 'M4 3v18h17 M8 6h7v3H8z M8 12h11v3H8z',
  check: 'M5 12l4 4 10-10', plus: 'M12 5v14 M5 12h14', minus: 'M5 12h14',
  chevron: 'M6 9l6 6 6-6', up: 'M6 12l6-6 6 6 M12 6v14', close: 'M6 6l12 12 M18 6L6 18',
  undo: 'M9 14 4 9l5-5 M4 9h10a6 6 0 0 1 0 12',
  pen: 'm16 3 5 5 M4 20l1-5L17 3l4 4L9 19l-5 1 M12 21h9',
} as const;
export type IconName = keyof typeof iconPaths;
export function Icon({ name, size = t.size.iconMd, color = t.role.icon.default, stroke = t.size.iconStroke }: { name: IconName; size?: number; color?: string; stroke?: number }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" accessible={false}><Path d={iconPaths[name]} /></Svg>;
}
export function StatusGlyphs() {
  return <>
    <Svg width={18} height={12} viewBox="0 0 18 12" fill={t.role.text.primary}><Path d="M0 8h3v4H0z M5 5h3v7H5z M10 2h3v10h-3z M15 0h3v12h-3z" /></Svg>
    <Svg width={18} height={14} viewBox="0 0 18 14" fill="none" stroke={t.role.text.primary} strokeWidth={2}><Path d="M1 5q8-7 16 0 M4 8q5-4 10 0 M7 11q2-2 4 0" /></Svg>
    <Svg width={27} height={14} viewBox="0 0 27 14" fill="none" stroke={t.role.text.primary}><Rect x={1} y={1} width={22} height={12} rx={3} /><Rect x={3} y={3} width={18} height={8} rx={1} fill={t.role.text.primary} /><Path d="M25 5v4" strokeWidth={2} /></Svg>
  </>;
}
