// Token bridge for the form-onboarding v1 package.
// Open Mat values come from the existing generated module (identical source values to v1 tokens.json).
// formLayout transcribes the Form-owned v1 layout additions exactly from design/form-onboarding/v1/tokens.json
// (layout.choice … layout.switch) and the settings-training v2 additions. v2 tokens.json is a superset of v1 with every
// v1 value unchanged. Replace this file with `tokens.py ts` output of the v2 package when generation is granted.
import { tokens as openMat } from '../../variants/a/tokens';

export const formLayout = {
  choice: { minHeight: 56, paddingX: 20, paddingY: 14, gap: 12, indicator: 24 },
  chipChoice: { gap: 8 },
  textAnswer: { minHeight: 56, micTarget: 44 },
  footer: { paddingTop: 12, paddingBottom: 8, gap: 4 },
  segmented: { height: 44, padding: 4, segmentMinWidth: 88 },
  voice: { indicator: 64, meterHeight: 40, meterBar: 4, meterGap: 4, transcriptMinHeight: 120 },
  cue: { minHeight: 64, handleTarget: 44, swapTarget: 44 },
  otp: { minHeight: 64, letterSpacing: 8 },
  outcome: { sourceGap: 24 },
  account: { avatar: 44 },
  switch: { width: 51, height: 31, knob: 27 },
  // settings-training v2 additions (continuation/mobile/design/settings-training/tokens.json layout.settings …
  // layout.statusLine), transcribed exactly. GENERATION HELD: no CPU grant yet; replace with tokens.py output.
  settings: { groupGap: 32, footnoteGap: 8 },
  setLog: { minHeight: 56, paddingY: 12, statusTarget: 44 },
  targetTable: { rowMinHeight: 44, columnGap: 16, setColumn: 44 },
  statusLine: { minHeight: 44, iconGap: 12 },
} as const;

export const t = openMat;
export const L = { ...openMat.layout, ...formLayout };

const INK_RGB = '25, 61, 56';

/**
 * Luminous Open Mat light treatment, additive to `t` (screens opt in): a warm paper canvas, layered white
 * surfaces, soft ink-tinted elevation, warm glows and a top sheen. Text colours stay the Open Mat roles;
 * `lightTextPairs` lists every text/background pairing the light layers support, each WCAG AA
 * (checked by tests/renderer/light-contrast.test.tsx). `actionLight` and the glows are never text colours.
 */
export const light = {
  color: {
    paper: '#fcfbf7',
    paperDeep: '#f5f2ea',
    surface: '#ffffff',
    surfaceRaised: '#fffefb',
    surfaceSunken: '#f4f2ec',
    surfaceTint: '#f2f8f5',
    glass: '#fffefac7',
    glassStrong: '#fffefaeb',
    glassBorder: '#ffffffe6',
    hairline: '#193d3817',
    sheen: '#fffffff2',
    glowWarm: '#ffe7b3',
    glowSun: '#fff3d6',
    glowAqua: '#d3f1f2',
    actionLight: '#0f7a65',
    actionDeep: '#08594a',
    inkSoft: '#2c4f49',
    focus: openMat.color.ink,
  },
  /** Gradient stops for react-native-svg: [offset 0–1, colour, opacity]. */
  gradient: {
    /** Page light: a warm sun at the top centre and a soft aqua mat-light at the bottom right, over paper. */
    pageSun: { cx: 0.5, cy: -0.08, rx: 1.2, ry: 0.6, stops: [[0, '#fff6e2', 1], [0.62, '#fff6e2', 0]] },
    pageAqua: { cx: 1, cy: 1, rx: 0.9, ry: 0.5, stops: [[0, '#d3f1f2', 0.55], [0.7, '#d3f1f2', 0]] },
    sunrise: { cx: 0.5, cy: 1, rx: 0.6, ry: 0.7, stops: [[0, '#ffe7b3', 0.9], [0.7, '#ffe7b3', 0]] },
    /** Vertical fills (top → bottom). */
    surface: [[0, '#ffffff', 1], [1, '#fffdf8', 1]],
    surfaceTint: [[0, '#f6fbf8', 1], [1, '#eef6f2', 1]],
    atmosphere: [[0, '#e6f6f6', 1], [1, '#d9f0f1', 1]],
    action: [[0, '#11806a', 1], [0.52, '#0b6957', 1], [1, '#095d4d', 1]],
    actionPressed: [[0, '#0a614f', 1], [1, '#084f42', 1]],
    sheen: [[0, '#ffffff', 0.55], [0.48, '#ffffff', 0]],
  },
  /** Layered soft shadows tinted with ink (`boxShadow`, supported on iOS, Android and web). */
  elevation: {
    e0: `0 0 0 1px rgba(${INK_RGB}, 0.09)`,
    e1: `0 0 0 1px rgba(${INK_RGB}, 0.05), 0 1px 2px rgba(${INK_RGB}, 0.06), 0 4px 12px rgba(${INK_RGB}, 0.05)`,
    e2: `0 0 0 1px rgba(${INK_RGB}, 0.05), 0 2px 4px rgba(${INK_RGB}, 0.05), 0 10px 28px rgba(${INK_RGB}, 0.09)`,
    e3: `0 0 0 1px rgba(${INK_RGB}, 0.06), 0 6px 12px rgba(${INK_RGB}, 0.06), 0 22px 48px rgba(${INK_RGB}, 0.14)`,
    sheet: `0 -1px 0 rgba(255, 255, 255, 0.9), 0 -12px 40px rgba(${INK_RGB}, 0.16)`,
    sheenInset: 'inset 0 1px 0 rgba(255, 255, 255, 0.95), inset 0 0 0 1px rgba(255, 255, 255, 0.5)',
  },
  glow: {
    action: '0 1px 1px rgba(8, 79, 66, 0.25), 0 6px 18px rgba(11, 105, 87, 0.28), 0 0 0 1px rgba(8, 79, 66, 0.18)',
    actionPressed: '0 1px 1px rgba(8, 79, 66, 0.25), 0 10px 28px rgba(11, 105, 87, 0.34), 0 0 0 1px rgba(8, 79, 66, 0.2)',
    warm: '0 10px 40px rgba(246, 201, 107, 0.35)',
    success: '0 0 0 4px rgba(45, 97, 71, 0.14), 0 8px 24px rgba(45, 97, 71, 0.18)',
    error: '0 0 0 4px rgba(165, 46, 50, 0.12)',
    focus: `0 0 0 3px #fcfbf7, 0 0 0 5px ${openMat.color.ink}`,
  },
  radius: { card: 28, toast: 22, tabBar: 32 },
} as const;

type TextRole = 'ink' | 'secondary' | 'action' | 'error' | 'warning' | 'success' | 'onAction';

/**
 * Supported text colour / background pairs for the light layers (all WCAG AA, 4.5:1 for body text).
 * `onAction` text sits on every stop of the action gradient.
 */
export const lightTextPairs: readonly { text: TextRole; on: string; background: string }[] = [
  ...(['ink', 'secondary', 'action', 'error', 'warning', 'success'] as const).flatMap((text) =>
    ([
      ['paper', light.color.paper], ['paperDeep', light.color.paperDeep],
      ['surface', light.color.surface], ['surfaceRaised', light.color.surfaceRaised], ['surfaceSunken', light.color.surfaceSunken],
      ['surfaceTint', light.color.surfaceTint], ['glowSun', light.color.glowSun], ['glowWarm', light.color.glowWarm],
      ['glowAqua', light.color.glowAqua], ['selection', openMat.color.selection], ['atmosphere', openMat.color.atmosphere],
      ['successSurface', openMat.color.successSurface], ['warningSurface', openMat.color.warningSurface],
      ['errorSurface', openMat.color.errorSurface],
    ] as const).map(([on, background]) => ({ text, on, background }))),
  ...light.gradient.action.map(([, background]) => ({ text: 'onAction' as const, on: `action ${background}`, background })),
  ...light.gradient.actionPressed.map(([, background]) => ({ text: 'onAction' as const, on: `actionPressed ${background}`, background })),
];

/** Resolves a `lightTextPairs` text role to its colour. */
export function lightTextColor(role: TextRole): string {
  return role === 'onAction' ? openMat.color.onAction : openMat.color[role];
}
