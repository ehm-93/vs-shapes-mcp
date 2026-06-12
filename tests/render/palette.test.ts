/**
 * palette.ts: extract a model's color palette from its resolved texture PNGs — exact-RGB
 * counting above the alpha cutout, coverage ranking, maxColors truncation, per-texture
 * breakdown, and missing-texture exclusion.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';

import { extractPalette } from '../../src/render/palette.js';
import { VsNum, type ShapeJson } from '../../src/vs/types.js';

/** Deep-wraps every number into a VsNum, mimicking the lossless parser's output. */
function wrapNums(value: unknown): unknown {
  if (typeof value === 'number') return new VsNum(value);
  if (Array.isArray(value)) return value.map(wrapNums);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = wrapNums(v);
    return out;
  }
  return value;
}
const makeDoc = (json: unknown): ShapeJson => wrapNums(json) as ShapeJson;

const tempDir = mkdtempSync(path.join(tmpdir(), 'vs-shapes-palette-'));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

type Px = [number, number, number, number];

/** Write a 1-row PNG from an explicit pixel list; returns the file basename (sans .png). */
function writePng(name: string, pixels: Px[]): string {
  const png = new PNG({ width: pixels.length, height: 1 });
  pixels.forEach((p, x) => png.data.set(p, x * 4));
  writeFileSync(path.join(tempDir, `${name}.png`), PNG.sync.write(png));
  return name;
}

const RED: Px = [255, 0, 0, 255];
const BLUE: Px = [0, 0, 255, 255];
const GREEN_FAINT: Px = [0, 255, 0, 5]; // alpha < 13 → below the cutout

describe('extractPalette', () => {
  it('ranks exact colors by coverage, skipping sub-cutout pixels', () => {
    const tex = writePng('basic', [RED, RED, BLUE, GREEN_FAINT]);
    const doc = makeDoc({ textures: { skin: tex }, elements: [] });

    const r = extractPalette(doc, { texturesRoot: tempDir });
    expect(r.mode).toBe('representative'); // default
    expect(r.resolvedTextures).toEqual(['skin']);
    expect(r.missingTextures).toEqual([]);
    expect(r.opaquePixels).toBe(3); // faint green excluded
    expect(r.distinctColors).toBe(2);
    expect(r.coverage).toBe(1);
    // Well-separated colors survive quantization exactly (median-cut keeps pure clusters).
    expect(r.colors).toEqual([
      { hex: '#ff0000', rgb: [255, 0, 0], count: 2, fraction: 0.6667 },
      { hex: '#0000ff', rgb: [0, 0, 255], count: 1, fraction: 0.3333 },
    ]);
    expect(r.perTexture).toBeUndefined();
  });

  it('exact mode returns precise 8-bit colors ranked by coverage', () => {
    const tex = writePng('exact', [RED, RED, BLUE, GREEN_FAINT]);
    const doc = makeDoc({ textures: { skin: tex }, elements: [] });

    const r = extractPalette(doc, { texturesRoot: tempDir, exact: true });
    expect(r.mode).toBe('exact');
    expect(r.colors).toEqual([
      { hex: '#ff0000', rgb: [255, 0, 0], count: 2, fraction: 0.6667 },
      { hex: '#0000ff', rgb: [0, 0, 255], count: 1, fraction: 0.3333 },
    ]);
  });

  it('representative mode clusters a noisy texture into ≤ maxColors covering ~everything', () => {
    // 12 near-identical dark grays (a stand-in for vanilla dithering), one per texel.
    const grays: Px[] = Array.from({ length: 12 }, (_, i) => [40 + i, 41 + i, 42 + i, 255]);
    const tex = writePng('noisy', grays);
    const doc = makeDoc({ textures: { skin: tex }, elements: [] });

    const r = extractPalette(doc, { texturesRoot: tempDir, maxColors: 3 });
    expect(r.distinctColors).toBe(12); // the texture really is noisy
    expect(r.colors.length).toBeLessThanOrEqual(3); // but the palette is compact
    expect(r.coverage).toBe(1); // every texel assigned to a representative
    expect(r.colors.reduce((s, c) => s + c.count, 0)).toBe(12);
    // Exact mode on the same input fragments: 3 of 12 distinct colors → 25% coverage.
    expect(extractPalette(doc, { texturesRoot: tempDir, maxColors: 3, exact: true }).coverage).toBe(
      0.25,
    );
  });

  it('maxColors keeps the top colors and coverage reflects the kept subset', () => {
    const tex = writePng('trunc', [RED, RED, BLUE]);
    const doc = makeDoc({ textures: { skin: tex }, elements: [] });

    const r = extractPalette(doc, { texturesRoot: tempDir, maxColors: 1 });
    expect(r.colors).toHaveLength(1);
    expect(r.colors[0]!.hex).toBe('#ff0000');
    expect(r.distinctColors).toBe(2); // full distinct count still reported
    expect(r.coverage).toBe(0.6667); // 2 of 3 texels covered by the single kept color
  });

  it('alphaThreshold lets translucent pixels into the count', () => {
    const tex = writePng('alpha', [RED, GREEN_FAINT]);
    const doc = makeDoc({ textures: { skin: tex }, elements: [] });

    const r = extractPalette(doc, { texturesRoot: tempDir, alphaThreshold: 0 });
    expect(r.opaquePixels).toBe(2);
    expect(r.distinctColors).toBe(2);
    expect(r.colors.map((c) => c.hex).sort()).toEqual(['#00ff00', '#ff0000']);
  });

  it('combines colors across textures and returns a per-texture breakdown on request', () => {
    const a = writePng('texA', [RED, RED]);
    const b = writePng('texB', [RED, BLUE]);
    const doc = makeDoc({ textures: { a, b }, elements: [] });

    const r = extractPalette(doc, { texturesRoot: tempDir, perTexture: true });
    expect(r.resolvedTextures).toEqual(['a', 'b']);
    expect(r.opaquePixels).toBe(4);
    // red 3 texels (2 from A, 1 from B), blue 1 texel.
    expect(r.colors).toEqual([
      { hex: '#ff0000', rgb: [255, 0, 0], count: 3, fraction: 0.75 },
      { hex: '#0000ff', rgb: [0, 0, 255], count: 1, fraction: 0.25 },
    ]);
    expect(r.perTexture).toHaveLength(2);
    const entryA = r.perTexture!.find((t) => t.key === 'a')!;
    expect(entryA).toMatchObject({
      assetPath: a,
      width: 2,
      height: 1,
      opaquePixels: 2,
      distinctColors: 1,
    });
    expect(entryA.colors).toEqual([
      { hex: '#ff0000', rgb: [255, 0, 0], count: 2, fraction: 1 },
    ]);
  });

  it('excludes unresolved textures and reports them as missing', () => {
    const doc = makeDoc({
      textures: { skin: writePng('present', [RED]), ghost: 'no/such/ghost-xyz' },
      elements: [],
    });
    const r = extractPalette(doc, { texturesRoot: tempDir });
    expect(r.resolvedTextures).toEqual(['skin']);
    expect(r.missingTextures).toEqual(['ghost']);
    expect(r.colors).toEqual([{ hex: '#ff0000', rgb: [255, 0, 0], count: 1, fraction: 1 }]);
  });

  it('handles a model with no resolvable textures', () => {
    const doc = makeDoc({ textures: { ghost: 'no/such/ghost-xyz' }, elements: [] });
    const r = extractPalette(doc, { texturesRoot: tempDir });
    expect(r.resolvedTextures).toEqual([]);
    expect(r.colors).toEqual([]);
    expect(r.distinctColors).toBe(0);
    expect(r.opaquePixels).toBe(0);
    expect(r.coverage).toBe(0);
  });

  it('rejects an out-of-range maxColors', () => {
    const doc = makeDoc({ textures: {}, elements: [] });
    expect(() => extractPalette(doc, { maxColors: 0 })).toThrow(/maxColors/);
    expect(() => extractPalette(doc, { maxColors: 300 })).toThrow(/maxColors/);
  });
});
