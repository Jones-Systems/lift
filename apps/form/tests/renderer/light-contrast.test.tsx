import { describe, expect, test } from '@jest/globals';
import { contrastRatio, meetsAA, parseColor, relativeLuminance } from '../../src/features/shared/contrast';
import { light, lightTextColor, lightTextPairs, t } from '../../src/features/shared/tokens';

describe('contrast helpers', () => {
  test('match the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // #767676 is the lightest grey that passes AA on white; #777777 is the first that fails.
    expect(meetsAA('#767676', '#ffffff')).toBe(true);
    expect(meetsAA('#777777', '#ffffff')).toBe(false);
    expect(meetsAA('#777777', '#ffffff', { large: true })).toBe(true);
    expect(relativeLuminance('#fff')).toBeCloseTo(1, 5);
  });

  test('composite translucent layers before measuring', () => {
    expect(parseColor('#193d3817').a).toBeCloseTo(23 / 255, 5);
    // A 9% ink hairline over white is still near white, so ink text on it keeps nearly full contrast.
    expect(contrastRatio(t.color.ink, light.color.hairline)).toBeGreaterThan(9);
    expect(() => parseColor('rgb(1,2,3)')).toThrow(TypeError);
  });
});

describe('luminous light tokens', () => {
  test('every supported text pair meets WCAG AA for body text', () => {
    const failures = lightTextPairs
      .map((pair) => ({ ...pair, ratio: contrastRatio(lightTextColor(pair.text), pair.background) }))
      .filter((pair) => pair.ratio < t.accessibility.minimumTextContrast)
      .map((pair) => `${pair.text} on ${pair.on}: ${pair.ratio.toFixed(2)}`);
    expect(failures).toEqual([]);
  });

  test('covers each text role on every light layer, including glows and the action gradient', () => {
    const layers = new Set(lightTextPairs.map((pair) => pair.on));
    for (const layer of ['paper', 'paperDeep', 'surface', 'surfaceRaised', 'surfaceSunken', 'surfaceTint', 'glowSun', 'glowWarm', 'glowAqua']) {
      expect(layers.has(layer)).toBe(true);
    }
    expect(lightTextPairs.filter((pair) => pair.text === 'onAction')).toHaveLength(
      light.gradient.action.length + light.gradient.actionPressed.length);
  });

  test('text over translucent glass on paper keeps AA', () => {
    for (const role of ['ink', 'secondary', 'action', 'error'] as const) {
      expect(contrastRatio(lightTextColor(role), light.color.glass, light.color.paper)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('graphics-only colours are kept out of the text pairs', () => {
    // actionLight fails AA on warm glows, so it must never be offered as a text colour.
    expect(contrastRatio(light.color.actionLight, light.color.glowWarm)).toBeLessThan(4.5);
    expect(lightTextPairs.some((pair) => (pair.text as string) === 'actionLight')).toBe(false);
  });
});
