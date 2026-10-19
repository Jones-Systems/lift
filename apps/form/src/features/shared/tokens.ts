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
