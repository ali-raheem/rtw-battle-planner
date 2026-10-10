// Heraldic divisions and ordinaries as metal-coloured polygons in a unit square (y down).
// Shared by the canvas banners and the HUD's SVG shields.

const SHAPES = {
  plain: [],
  'per pale': [[[0.5, 0], [1, 0], [1, 1], [0.5, 1]]],
  'per fess': [[[0, 0.5], [1, 0.5], [1, 1], [0, 1]]],
  'per bend': [[[0, 0], [1, 1], [0, 1]]],
  quarterly: [[[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]], [[0.5, 0.5], [1, 0.5], [1, 1], [0.5, 1]]],
  chief: [[[0, 0], [1, 0], [1, 0.33], [0, 0.33]]],
  pale: [[[0.36, 0], [0.64, 0], [0.64, 1], [0.36, 1]]],
  fess: [[[0, 0.36], [1, 0.36], [1, 0.64], [0, 0.64]]],
  cross: [[[0.4, 0], [0.6, 0], [0.6, 1], [0.4, 1]], [[0, 0.4], [1, 0.4], [1, 0.6], [0, 0.6]]],
  saltire: [
    [[0, 0], [0.16, 0], [1, 0.84], [1, 1], [0.84, 1], [0, 0.16]],
    [[1, 0], [1, 0.16], [0.16, 1], [0, 1], [0, 0.84], [0.84, 0]],
  ],
  chevron: [[[0, 0.7], [0.5, 0.25], [1, 0.7], [1, 0.95], [0.5, 0.5], [0, 0.95]]],
  bend: [[[0, 0], [0.2, 0], [1, 0.8], [1, 1], [0.8, 1], [0, 0.2]]],
};

export const PATTERNS = Object.keys(SHAPES);

export function heraldryShapes(pattern) {
  return SHAPES[pattern] ?? [];
}
