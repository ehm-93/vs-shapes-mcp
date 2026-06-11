/**
 * views.ts: composed view grids + filmstrips on the SOFTWARE backend (the determinism
 * reference; GPU parity lives in gpu.test.ts). Corpus-dependent cases (the fox) skip
 * cleanly with a console note when no game install is present; the bogus-texture and
 * hitbox cases run anywhere on a synthetic shape.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { HITBOX_RGBA, faceBrightness, renderFilmstrip, renderViews } from '../../src/render/views.js';
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

const gameDir =
  process.env['VINTAGE_STORY'] ?? path.join(process.env['APPDATA'] ?? '', 'Vintagestory');
const foxPath = path.join(
  gameDir, 'assets', 'survival', 'shapes', 'entity', 'animal', 'mammal', 'fox', 'fox-male.json',
);
const haveFox = existsSync(foxPath);
if (!haveFox) {
  console.error(
    `tests/render/views.test.ts: Vintage Story install not found at ${gameDir} — skipping fox corpus tests`,
  );
}
const fox: ShapeJson = haveFox
  ? makeDoc(JSON.parse(readFileSync(foxPath, 'utf8')))
  : ({ elements: [] } as unknown as ShapeJson);

/** All-bogus-texture cube standing on y=0, anchor block [0,1]; renders without a corpus. */
const allFaces = (tex: string) =>
  Object.fromEntries(
    ['north', 'east', 'south', 'west', 'up', 'down'].map((f) => [
      f,
      { texture: tex, uv: [0, 0, 8, 8] },
    ]),
  );
const cubeDoc = makeDoc({
  textureWidth: 16,
  textureHeight: 16,
  textures: { bogus: 'does/not/exist/anywhere' },
  elements: [{ name: 'cube', from: [4, 0, 4], to: [12, 8, 12], faces: allFaces('#bogus') }],
});

function nonBackgroundFraction(png: PNG, bg: readonly number[]): number {
  let non = 0;
  const total = png.width * png.height;
  for (let o = 0; o < png.data.length; o += 4) {
    if (
      png.data[o] !== bg[0] ||
      png.data[o + 1] !== bg[1] ||
      png.data[o + 2] !== bg[2]
    ) {
      non++;
    }
  }
  return non / total;
}

/** Background sampled from a corner pixel (tile border is at the very edge, so use +4). */
function bgOf(png: PNG): number[] {
  const o = (4 * png.width + 4) * 4;
  return [png.data[o]!, png.data[o + 1]!, png.data[o + 2]!];
}

function countExactColor(png: PNG, rgba: readonly number[]): number {
  let n = 0;
  for (let o = 0; o < png.data.length; o += 4) {
    if (
      png.data[o] === rgba[0] &&
      png.data[o + 1] === rgba[1] &&
      png.data[o + 2] === rgba[2]
    ) {
      n++;
    }
  }
  return n;
}

describe.skipIf(!haveFox)('renderViews — fox (corpus)', () => {
  it('default 4-view grid decodes, has the right dims, >5% non-background, byte-stable', async () => {
    const first = await renderViews(fox, { renderer: 'software' });
    const second = await renderViews(fox, { renderer: 'software' });

    expect(first.png.equals(second.png)).toBe(true); // PNG encode + render byte-stable

    const png = PNG.sync.read(first.png);
    expect(png.width).toBe(2 * 320); // 4 views → 2×2 grid of 320px tiles
    expect(png.height).toBe(2 * 320);
    expect(nonBackgroundFraction(png, bgOf(png))).toBeGreaterThan(0.05);

    expect(first.missingTextures).toEqual([]); // fox skin resolves from game assets
    expect(first.caption).toContain('views n,e,sw,top');
    expect(first.caption).toContain('backend software');

    // Committed eyeball artifact.
    const snapDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__snapshots__');
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(path.join(snapDir, 'fox-views.png'), first.png);
  });

  it('fewer than 4 views compose as a single row', async () => {
    const { png } = await renderViews(fox, { views: ['w', 'top'], size: 96, renderer: 'software' });
    const decoded = PNG.sync.read(png);
    expect(decoded.width).toBe(2 * 96);
    expect(decoded.height).toBe(96);
  });

  it('animated view labels carry the frame and posed geometry differs from static', async () => {
    const posed = await renderViews(fox, {
      views: ['e'], anim: 'walk', frame: 12, size: 160, renderer: 'software',
    });
    const still = await renderViews(fox, { views: ['e'], size: 160, renderer: 'software' });
    expect(posed.caption).toContain(`anim 'walk' frame 12`);
    expect(posed.png.equals(still.png)).toBe(false);
  });

  it('filmstrip has 8 tiles, frames evenly spaced incl. fractional, and neighbors differ', async () => {
    const result = await renderFilmstrip(fox, { anim: 'walk', renderer: 'software' });
    const png = PNG.sync.read(result.png);
    expect(png.width).toBe(8 * 240);
    expect(png.height).toBe(240);
    // walk has 40 frames → samples at 0, 5, 10, ..., 35.
    expect(result.caption).toContain('0, 5, 10, 15, 20, 25, 30, 35 of 40');

    // Compare the lower half (legs) of adjacent tiles — must differ during a walk cycle.
    for (let tile = 0; tile < 7; tile++) {
      let differing = 0;
      for (let y = 120; y < 240; y++) {
        for (let x = 0; x < 240; x++) {
          const oA = (y * png.width + tile * 240 + x) * 4;
          const oB = (y * png.width + (tile + 1) * 240 + x) * 4;
          if (
            png.data[oA] !== png.data[oB] ||
            png.data[oA + 1] !== png.data[oB + 1] ||
            png.data[oA + 2] !== png.data[oB + 2]
          ) {
            differing++;
          }
        }
      }
      expect(differing, `tiles ${tile} and ${tile + 1} should differ`).toBeGreaterThan(50);
    }
  });

  it('fractional filmstrip frames are sampled and labeled (40 frames / 16 tiles)', async () => {
    const result = await renderFilmstrip(fox, {
      anim: 'walk', frames: 16, size: 64, renderer: 'software',
    });
    expect(result.caption).toContain('2.5'); // 40/16 = 2.5 — fractional frame rendered
    expect(PNG.sync.read(result.png).width).toBe(16 * 64);
  });

  it('names a missing animation with the available codes', async () => {
    await expect(renderFilmstrip(fox, { anim: 'moonwalk', renderer: 'software' })).rejects.toThrow(
      /'moonwalk'.*available animation codes:.*walk/,
    );
  });
});

describe('renderViews — synthetic shapes (no corpus needed)', () => {
  it('bogus-texture doc renders with flat fallback colors and reports the missing key', async () => {
    const result = await renderViews(cubeDoc, { renderer: 'software' });
    expect(result.missingTextures).toEqual(['bogus']);
    expect(result.caption).toContain('missing textures: bogus');
    const png = PNG.sync.read(result.png);
    expect(png.width).toBe(640);
    expect(png.height).toBe(640);
    expect(nonBackgroundFraction(png, bgOf(png))).toBeGreaterThan(0.05);
  });

  it('hitbox overlay adds pixels of its color', async () => {
    const withBox = await renderViews(cubeDoc, {
      overlayHitbox: { x: 1.2, y: 1 }, renderer: 'software',
    });
    const withoutBox = await renderViews(cubeDoc, { renderer: 'software' });
    const boxPx = countExactColor(PNG.sync.read(withBox.png), HITBOX_RGBA);
    const basePx = countExactColor(PNG.sync.read(withoutBox.png), HITBOX_RGBA);
    expect(basePx).toBe(0);
    expect(boxPx).toBeGreaterThan(100);
    expect(withBox.caption).toContain('hitbox 1.2x1 blocks');
  });

  it('rejects a frame without an animation, empty views, and bad sizes with named errors', async () => {
    await expect(renderViews(cubeDoc, { frame: 3, renderer: 'software' })).rejects.toThrow(
      /frame \(3\).*without an animation/,
    );
    await expect(renderViews(cubeDoc, { views: [], renderer: 'software' })).rejects.toThrow(
      /at least one view/,
    );
    await expect(renderViews(cubeDoc, { size: 7, renderer: 'software' })).rejects.toThrow(
      /size must be an integer between 32 and 2048/,
    );
  });
});

describe('faceBrightness — GetFaceBrightness port over world-space normals (tesselator.md §6b)', () => {
  it('axis-aligned normals reproduce the engine table exactly', () => {
    expect(faceBrightness([0, 1, 0])).toBeCloseTo(1.0, 12); // up
    expect(faceBrightness([0, -1, 0])).toBeCloseTo(0.45, 12); // down
    expect(faceBrightness([0, 0, -1])).toBeCloseTo(0.6, 12); // north
    expect(faceBrightness([0, 0, 1])).toBeCloseTo(0.6, 12); // south
    expect(faceBrightness([1, 0, 0])).toBeCloseTo(0.75, 12); // east
    expect(faceBrightness([-1, 0, 0])).toBeCloseTo(0.75, 12); // west
  });

  it('rotated normals interpolate by angular proximity (engine sum formula)', () => {
    // 45° between up (1.0) and east (0.75): each contributes (1 − 45/90)·shade.
    const n = Math.SQRT1_2;
    expect(faceBrightness([n, n, 0])).toBeCloseTo(0.5 * 1.0 + 0.5 * 0.75, 12);
    // 45° between down (0.45) and north (0.6).
    expect(faceBrightness([0, -n, -n])).toBeCloseTo(0.5 * 0.45 + 0.5 * 0.6, 12);
  });
});
