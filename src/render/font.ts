/**
 * Tiny built-in 5×7 monospace bitmap font for render labels (view names, frame numbers,
 * footnotes). Pure pixel pushing — no I/O.
 *
 * Coverage: A–Z, a–z, 0–9, space, and . , : ; ! ? ( ) [ ] / # % + - =
 * Unknown characters render as a hollow 5×7 box (visually distinct from '?').
 *
 * Metrics: each glyph is {@link GLYPH_WIDTH}×{@link GLYPH_HEIGHT} font pixels; the pen
 * advances {@link GLYPH_ADVANCE} (= 5 glyph columns + 1 gap column) per character. With
 * integer `scale` every font pixel becomes a scale×scale block.
 *
 * Text is drawn WITHOUT any depth interaction: color only, the depth buffer is neither
 * read nor written (labels always sit on top of geometry drawn so far).
 */

import { fillRect, type Framebuffer, type Rgba } from './raster.js';

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
/** Horizontal pen advance per character: 5 px glyph + 1 px gap. */
export const GLYPH_ADVANCE = 6;

// One spec per glyph: 7 space-separated rows of 5 chars, 'X' = on, '.' = off.
// Shapes follow the classic HD44780-style 5x7 set.
const GLYPH_SPECS: Readonly<Record<string, string>> = {
  ' ': '..... ..... ..... ..... ..... ..... .....',
  A: '.XXX. X...X X...X XXXXX X...X X...X X...X',
  B: 'XXXX. X...X X...X XXXX. X...X X...X XXXX.',
  C: '.XXX. X...X X.... X.... X.... X...X .XXX.',
  D: 'XXXX. X...X X...X X...X X...X X...X XXXX.',
  E: 'XXXXX X.... X.... XXXX. X.... X.... XXXXX',
  F: 'XXXXX X.... X.... XXXX. X.... X.... X....',
  G: '.XXX. X...X X.... X.XXX X...X X...X .XXXX',
  H: 'X...X X...X X...X XXXXX X...X X...X X...X',
  I: '.XXX. ..X.. ..X.. ..X.. ..X.. ..X.. .XXX.',
  J: '..XXX ...X. ...X. ...X. ...X. X..X. .XX..',
  K: 'X...X X..X. X.X.. XX... X.X.. X..X. X...X',
  L: 'X.... X.... X.... X.... X.... X.... XXXXX',
  M: 'X...X XX.XX X.X.X X.X.X X...X X...X X...X',
  N: 'X...X X...X XX..X X.X.X X..XX X...X X...X',
  O: '.XXX. X...X X...X X...X X...X X...X .XXX.',
  P: 'XXXX. X...X X...X XXXX. X.... X.... X....',
  Q: '.XXX. X...X X...X X...X X.X.X X..X. .XX.X',
  R: 'XXXX. X...X X...X XXXX. X.X.. X..X. X...X',
  S: '.XXXX X.... X.... .XXX. ....X ....X XXXX.',
  T: 'XXXXX ..X.. ..X.. ..X.. ..X.. ..X.. ..X..',
  U: 'X...X X...X X...X X...X X...X X...X .XXX.',
  V: 'X...X X...X X...X X...X X...X .X.X. ..X..',
  W: 'X...X X...X X...X X.X.X X.X.X X.X.X .X.X.',
  X: 'X...X X...X .X.X. ..X.. .X.X. X...X X...X',
  Y: 'X...X X...X .X.X. ..X.. ..X.. ..X.. ..X..',
  Z: 'XXXXX ....X ...X. ..X.. .X... X.... XXXXX',
  a: '..... ..... .XXX. ....X .XXXX X...X .XXXX',
  b: 'X.... X.... X.XX. XX..X X...X X...X XXXX.',
  c: '..... ..... .XXX. X.... X.... X...X .XXX.',
  d: '....X ....X .XX.X X..XX X...X X...X .XXXX',
  e: '..... ..... .XXX. X...X XXXXX X.... .XXX.',
  f: '..XX. .X..X .X... XXX.. .X... .X... .X...',
  g: '..... .XXXX X...X X...X .XXXX ....X .XXX.',
  h: 'X.... X.... X.XX. XX..X X...X X...X X...X',
  i: '..X.. ..... .XX.. ..X.. ..X.. ..X.. .XXX.',
  j: '...X. ..... ..XX. ...X. ...X. X..X. .XX..',
  k: 'X.... X.... X..X. X.X.. XX... X.X.. X..X.',
  l: '.XX.. ..X.. ..X.. ..X.. ..X.. ..X.. .XXX.',
  m: '..... ..... XX.X. X.X.X X.X.X X.X.X X.X.X',
  n: '..... ..... X.XX. XX..X X...X X...X X...X',
  o: '..... ..... .XXX. X...X X...X X...X .XXX.',
  p: '..... ..... XXXX. X...X XXXX. X.... X....',
  q: '..... ..... .XXXX X...X .XXXX ....X ....X',
  r: '..... ..... X.XX. XX..X X.... X.... X....',
  s: '..... ..... .XXXX X.... .XXX. ....X XXXX.',
  t: '.X... .X... XXX.. .X... .X... .X..X ..XX.',
  u: '..... ..... X...X X...X X...X X..XX .XX.X',
  v: '..... ..... X...X X...X X...X .X.X. ..X..',
  w: '..... ..... X...X X...X X.X.X X.X.X .X.X.',
  x: '..... ..... X...X .X.X. ..X.. .X.X. X...X',
  y: '..... ..... X...X X...X .XXXX ....X .XXX.',
  z: '..... ..... XXXXX ...X. ..X.. .X... XXXXX',
  '0': '.XXX. X...X X..XX X.X.X XX..X X...X .XXX.',
  '1': '..X.. .XX.. ..X.. ..X.. ..X.. ..X.. .XXX.',
  '2': '.XXX. X...X ....X ...X. ..X.. .X... XXXXX',
  '3': 'XXXXX ...X. ..X.. ...X. ....X X...X .XXX.',
  '4': '...X. ..XX. .X.X. X..X. XXXXX ...X. ...X.',
  '5': 'XXXXX X.... XXXX. ....X ....X X...X .XXX.',
  '6': '..XX. .X... X.... XXXX. X...X X...X .XXX.',
  '7': 'XXXXX ....X ...X. ..X.. ..X.. ..X.. ..X..',
  '8': '.XXX. X...X X...X .XXX. X...X X...X .XXX.',
  '9': '.XXX. X...X X...X .XXXX ....X ...X. .XX..',
  '.': '..... ..... ..... ..... ..... .XX.. .XX..',
  ',': '..... ..... ..... ..... ..XX. ..X.. .X...',
  ':': '..... .XX.. .XX.. ..... .XX.. .XX.. .....',
  ';': '..... .XX.. .XX.. ..... .XX.. ..X.. .X...',
  '!': '..X.. ..X.. ..X.. ..X.. ..X.. ..... ..X..',
  '?': '.XXX. X...X ....X ...X. ..X.. ..... ..X..',
  '(': '...X. ..X.. .X... .X... .X... ..X.. ...X.',
  ')': '.X... ..X.. ...X. ...X. ...X. ..X.. .X...',
  '[': '.XXX. .X... .X... .X... .X... .X... .XXX.',
  ']': '.XXX. ...X. ...X. ...X. ...X. ...X. .XXX.',
  '/': '....X ....X ...X. ..X.. .X... X.... X....',
  '#': '.X.X. .X.X. XXXXX .X.X. XXXXX .X.X. .X.X.',
  '%': 'XX... XX..X ...X. ..X.. .X... X..XX ...XX',
  '+': '..... ..X.. ..X.. XXXXX ..X.. ..X.. .....',
  '-': '..... ..... ..... XXXXX ..... ..... .....',
  '=': '..... ..... XXXXX ..... XXXXX ..... .....',
};

const FALLBACK_SPEC = 'XXXXX X...X X...X X...X X...X X...X XXXXX'; // hollow box

/** Compiles a row-string spec into 7 row bitmasks (bit `col` = column `col` lit). */
function compileGlyph(ch: string, spec: string): Uint8Array {
  const rows = spec.split(' ');
  if (rows.length !== GLYPH_HEIGHT) {
    throw new Error(
      `font: glyph '${ch}' has ${rows.length} rows, expected ${GLYPH_HEIGHT}; fix GLYPH_SPECS`,
    );
  }
  const out = new Uint8Array(GLYPH_HEIGHT);
  for (let r = 0; r < GLYPH_HEIGHT; r++) {
    const row = rows[r]!;
    if (row.length !== GLYPH_WIDTH) {
      throw new Error(
        `font: glyph '${ch}' row ${r} is ${row.length} wide, expected ${GLYPH_WIDTH}; fix GLYPH_SPECS`,
      );
    }
    let bits = 0;
    for (let c = 0; c < GLYPH_WIDTH; c++) {
      const px = row.charAt(c);
      if (px === 'X') bits |= 1 << c;
      else if (px !== '.') {
        throw new Error(`font: glyph '${ch}' row ${r} has invalid char '${px}'; use 'X' or '.'`);
      }
    }
    out[r] = bits;
  }
  return out;
}

const GLYPHS: ReadonlyMap<string, Uint8Array> = new Map(
  Object.entries(GLYPH_SPECS).map(([ch, spec]) => [ch, compileGlyph(ch, spec)]),
);
const FALLBACK_GLYPH = compileGlyph('�', FALLBACK_SPEC);

/** True when `ch` (a single character) has a real glyph (not the fallback box). */
export function hasGlyph(ch: string): boolean {
  return GLYPHS.has(ch);
}

function assertScale(fn: string, scale: number): void {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error(`${fn}: scale must be a positive integer (1, 2, 3, ...), got ${scale}`);
  }
}

/**
 * Draws `text` with its top-left at (x, y) (rounded to integers), clipped to the
 * framebuffer. Color only — no depth test, no depth write. Characters outside the
 * supported set render as a hollow box. Characters are split by code point, so astral
 * characters occupy one cell (matching {@link textWidth}).
 */
export function drawText(
  fb: Framebuffer,
  x: number,
  y: number,
  text: string,
  rgba: Rgba,
  scale = 1,
): void {
  assertScale('drawText', scale);
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const glyph = GLYPHS.get(chars[i]!) ?? FALLBACK_GLYPH;
    const gx = x0 + i * GLYPH_ADVANCE * scale;
    if (gx >= fb.width || gx + GLYPH_WIDTH * scale <= 0) continue;
    for (let row = 0; row < GLYPH_HEIGHT; row++) {
      const bits = glyph[row]!;
      if (bits === 0) continue;
      const py = y0 + row * scale;
      for (let col = 0; col < GLYPH_WIDTH; col++) {
        if ((bits & (1 << col)) !== 0) {
          fillRect(fb, gx + col * scale, py, scale, scale, rgba); // color-only, clips
        }
      }
    }
  }
}

/**
 * Pixel width of `text` as drawn by {@link drawText}: (6·n − 1)·scale for n > 0
 * characters (no trailing gap column), 0 for empty text.
 */
export function textWidth(text: string, scale = 1): number {
  assertScale('textWidth', scale);
  const n = Array.from(text).length;
  return n === 0 ? 0 : (n * GLYPH_ADVANCE - (GLYPH_ADVANCE - GLYPH_WIDTH)) * scale;
}
