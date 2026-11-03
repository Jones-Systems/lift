// WCAG 2.x contrast helpers for token checks. Colours are #rgb, #rrggbb or #rrggbbaa; a translucent
// foreground or background is composited over `base` (default white) before measuring.

type Rgba = { r: number; g: number; b: number; a: number };

export function parseColor(color: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim())?.[1];
  if (!hex) throw new TypeError(`Unsupported colour: ${color}`);
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const channel = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return { r: channel(0), g: channel(2), b: channel(4), a: full.length === 8 ? channel(6) / 255 : 1 };
}

function over(top: Rgba, under: Rgba): Rgba {
  const mix = (a: number, b: number) => a * top.a + b * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

function luminance({ r, g, b }: Rgba): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Relative luminance (0–1) of an opaque colour, or of a translucent one composited over `base`. */
export function relativeLuminance(color: string, base = '#ffffff'): number {
  return luminance(over(parseColor(color), parseColor(base)));
}

/** Contrast ratio (1–21) of `text` on `background`; translucent layers composite over `base`. */
export function contrastRatio(text: string, background: string, base = '#ffffff'): number {
  const bg = over(parseColor(background), parseColor(base));
  const fg = over(parseColor(text), bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA: 4.5:1 for body text, 3:1 for large text (≥24 px, or ≥18.66 px bold) and essential graphics. */
export function meetsAA(text: string, background: string, opts: { large?: boolean; base?: string } = {}): boolean {
  return contrastRatio(text, background, opts.base) >= (opts.large ? 3 : 4.5);
}
