import { describe, expect, it } from 'vitest';
import { createFramebuffer, type Framebuffer, type Rgba } from '../../src/render/raster.js';
import {
  drawText,
  GLYPH_ADVANCE,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  hasGlyph,
  textWidth,
} from '../../src/render/font.js';

const BG: Rgba = [0, 0, 0, 0];
const WHITE: Rgba = [255, 255, 255, 255];

const REQUIRED_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  'abcdefghijklmnopqrstuvwxyz' +
  '0123456789' +
  ' .,:;!?()[]/#%+-=';

function paintedPixels(fb: Framebuffer): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < fb.height; y++) {
    for (let x = 0; x < fb.width; x++) {
      const o = (y * fb.width + x) * 4;
      if (fb.rgba[o + 3] !== 0) out.push({ x, y });
    }
  }
  return out;
}

describe('glyph metrics', () => {
  it('exports the 5x7 metrics with a 6px advance', () => {
    expect(GLYPH_WIDTH).toBe(5);
    expect(GLYPH_HEIGHT).toBe(7);
    expect(GLYPH_ADVANCE).toBe(6);
  });

  it("'A' paints exactly 18 pixels at scale 1 and 72 at scale 2", () => {
    const fb1 = createFramebuffer(16, 16, BG);
    drawText(fb1, 0, 0, 'A', WHITE);
    expect(paintedPixels(fb1).length).toBe(18);

    const fb2 = createFramebuffer(16, 16, BG);
    drawText(fb2, 0, 0, 'A', WHITE, 2);
    expect(paintedPixels(fb2).length).toBe(18 * 4);
  });

  it("'A' scale 2 is the exact 2x block-upscale of 'A' scale 1", () => {
    const fb1 = createFramebuffer(8, 8, BG);
    drawText(fb1, 0, 0, 'A', WHITE);
    const fb2 = createFramebuffer(16, 16, BG);
    drawText(fb2, 0, 0, 'A', WHITE, 2);
    const small = new Set(paintedPixels(fb1).map((p) => p.y * 8 + p.x));
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const o = (y * 16 + x) * 4;
        const lit = fb2.rgba[o + 3] !== 0;
        expect(lit).toBe(small.has(Math.floor(y / 2) * 8 + Math.floor(x / 2)));
      }
    }
  });

  it('every required character has a glyph confined to its 5x7 cell', () => {
    for (const ch of REQUIRED_CHARS) {
      expect(hasGlyph(ch), `missing glyph for '${ch}'`).toBe(true);
      const fb = createFramebuffer(12, 12, BG);
      drawText(fb, 0, 0, ch, WHITE);
      const px = paintedPixels(fb);
      if (ch === ' ') {
        expect(px.length).toBe(0);
      } else {
        expect(px.length, `glyph '${ch}' paints nothing`).toBeGreaterThan(0);
      }
      for (const p of px) {
        expect(p.x, `glyph '${ch}' escapes its cell`).toBeLessThan(GLYPH_WIDTH);
        expect(p.y, `glyph '${ch}' escapes its cell`).toBeLessThan(GLYPH_HEIGHT);
      }
    }
  });

  it('unknown characters render the hollow fallback box (20 pixels)', () => {
    expect(hasGlyph('~')).toBe(false);
    const fb = createFramebuffer(12, 12, BG);
    drawText(fb, 0, 0, '~', WHITE);
    expect(paintedPixels(fb).length).toBe(20); // 5+5 top/bottom + 2*5 sides
  });
});

describe('drawText layout', () => {
  it('advances 6*scale px per character and leaves the gap column empty', () => {
    const fb = createFramebuffer(24, 12, BG);
    drawText(fb, 2, 3, 'AB', WHITE);
    const px = paintedPixels(fb);
    // 'B' row 0 is 'XXXX.': its first column starts at x = 2 + 6.
    expect(px.some((p) => p.x === 8 && p.y === 3)).toBe(true);
    // Gap column x = 7 (between the two cells) is never painted.
    expect(px.some((p) => p.x === 7)).toBe(false);
    // Whole string spans textWidth('AB') = 11 px: nothing at or beyond x = 2 + 11.
    expect(px.every((p) => p.x < 2 + textWidth('AB'))).toBe(true);
  });

  it('clips at all framebuffer edges without throwing', () => {
    const fb = createFramebuffer(10, 10, BG);
    drawText(fb, -3, -3, 'A', WHITE); // off top-left
    drawText(fb, 8, 6, 'A', WHITE); // off bottom-right
    for (const p of paintedPixels(fb)) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(10);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThan(10);
    }
    const off = createFramebuffer(10, 10, BG);
    drawText(off, 100, 100, 'AB', WHITE);
    expect(paintedPixels(off).length).toBe(0);
  });

  it('ignores the depth buffer entirely: draws over nearest depth and never writes it', () => {
    const fb = createFramebuffer(16, 16, BG);
    fb.depth.fill(Number.NEGATIVE_INFINITY); // nearer than anything could ever be
    drawText(fb, 1, 1, 'A', WHITE);
    expect(paintedPixels(fb).length).toBe(18);
    for (const d of fb.depth) expect(d).toBe(Number.NEGATIVE_INFINITY);
  });

  it('is deterministic: two identical draws are byte-equal', () => {
    const draw = (): Framebuffer => {
      const fb = createFramebuffer(64, 16, [5, 6, 7, 255]);
      drawText(fb, 1, 2, 'Frame 12/30 (e)', [255, 220, 0, 255]);
      return fb;
    };
    const a = draw();
    const b = draw();
    expect(Buffer.from(a.rgba.buffer).equals(Buffer.from(b.rgba.buffer))).toBe(true);
  });

  it('rejects non-integer or non-positive scale', () => {
    const fb = createFramebuffer(8, 8, BG);
    expect(() => drawText(fb, 0, 0, 'A', WHITE, 0)).toThrow(/positive integer/);
    expect(() => drawText(fb, 0, 0, 'A', WHITE, 1.5)).toThrow(/positive integer/);
  });
});

describe('textWidth', () => {
  it('is (6n - 1) * scale for n chars, 0 for empty', () => {
    expect(textWidth('')).toBe(0);
    expect(textWidth('A')).toBe(5);
    expect(textWidth('AB')).toBe(11);
    expect(textWidth('abc')).toBe(17);
    expect(textWidth('AB', 2)).toBe(22);
    expect(textWidth('AB', 3)).toBe(33);
    expect(textWidth('0123456789')).toBe(59);
  });

  it('matches the painted horizontal span of drawText', () => {
    const text = 'Hi! #42';
    const fb = createFramebuffer(64, 16, BG);
    drawText(fb, 0, 0, text, WHITE);
    const px = paintedPixels(fb);
    const maxX = Math.max(...px.map((p) => p.x));
    // The last glyph may not use its rightmost column, but may never exceed the width.
    expect(maxX).toBeLessThan(textWidth(text));
    expect(textWidth(text)).toBe(6 * text.length - 1);
  });

  it('rejects invalid scale', () => {
    expect(() => textWidth('A', -1)).toThrow(/positive integer/);
  });
});
