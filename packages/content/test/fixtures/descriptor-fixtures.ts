/**
 * Valid descriptor JSON in exactly the shape the sixteen shipped files will use.
 * TEST-ONLY: `packages/content/src` never imports this, exactly as §2.6 requires
 * of sim's fixtures.
 *
 * The return type is `Record<string, unknown>` on purpose: a mutation test has to
 * be able to write a wrong-typed value into any field, which a `CharacterDescriptor`
 * return type would forbid at compile time. Every call returns a fresh object,
 * including fresh palette arrays, so one case's mutation cannot leak into the next.
 */
export function makeCharacterDescriptorJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'ash-vega',
    name: 'Ash Vega',
    bodyHeight: 0.95,
    bodyRadius: 0.28,
    headRadius: 0.22,
    palette: {
      primary: [0.85, 0.16, 0.24],
      secondary: [0.1, 0.11, 0.16],
      accent: [1, 0.78, 0.2],
    },
    silhouette: 'compact',
    ...overrides,
  }
}

export function makeKartDescriptorJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'ember-dart',
    name: 'Ember Dart',
    chassisLength: 2,
    chassisWidth: 1.2,
    chassisHeight: 0.55,
    wheelRadius: 0.32,
    wheelWidth: 0.18,
    palette: {
      body: [0.9, 0.35, 0.1],
      trim: [0.15, 0.15, 0.18],
      wheel: [0.05, 0.05, 0.06],
    },
    ...overrides,
  }
}
