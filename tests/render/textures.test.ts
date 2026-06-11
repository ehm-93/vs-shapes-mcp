/**
 * textures.ts: PNG loading, the shared shape-UV → normalized mapping (k-scale +
 * per-key textureSizes override), nearest sampling + alpha cutout, and deterministic
 * flat-color fallbacks for missing textures.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';

import {
  createTextureSet,
  fallbackColor,
  loadTexturePng,
  sampleNearest,
  type TexturePixels,
} from '../../src/render/textures.js';
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

const tempDir = mkdtempSync(path.join(tmpdir(), 'vs-shapes-textures-'));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

/** Writes an 8×4 PNG where pixel (x, y) = [x*30, y*60, 7, alpha(x,y)]. */
function writeTestPng(name: string, alphaAt: (x: number, y: number) => number): string {
  const png = new PNG({ width: 8, height: 4 });
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) {
      const o = (y * 8 + x) * 4;
      png.data[o] = x * 30;
      png.data[o + 1] = y * 60;
      png.data[o + 2] = 7;
      png.data[o + 3] = alphaAt(x, y);
    }
  }
  const abs = path.join(tempDir, name);
  writeFileSync(abs, PNG.sync.write(png));
  return abs;
}

describe('loadTexturePng', () => {
  it('round-trips dimensions and pixel bytes', () => {
    const abs = writeTestPng('roundtrip.png', () => 255);
    const tex = loadTexturePng(abs);
    expect(tex.width).toBe(8);
    expect(tex.height).toBe(4);
    expect(tex.rgba.length).toBe(8 * 4 * 4);
    const o = (2 * 8 + 5) * 4; // pixel (5, 2)
    expect([tex.rgba[o], tex.rgba[o + 1], tex.rgba[o + 2], tex.rgba[o + 3]]).toEqual([
      150, 120, 7, 255,
    ]);
  });

  it('names the path in read and decode errors', () => {
    expect(() => loadTexturePng(path.join(tempDir, 'absent.png'))).toThrow(/absent\.png/);
    const bogus = path.join(tempDir, 'not-a-png.png');
    writeFileSync(bogus, 'plainly not a png');
    expect(() => loadTexturePng(bogus)).toThrow(/not-a-png\.png.*not a decodable PNG/);
  });
});

describe('createTextureSet mapping', () => {
  const doc = makeDoc({
    textureWidth: 32,
    textureHeight: 64,
    textureSizes: { foo: [16, 16] },
    textures: { skin: 'some/skin', foo: 'some/foo' },
    elements: [
      {
        name: 'cube',
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: { north: { texture: '#skin', uv: [0, 0, 8, 8] } },
      },
    ],
  });

  it('normalizeUv divides by the per-key shape texture size (textureSizes override)', () => {
    const set = createTextureSet(doc, []);
    expect(set.normalizeUv('skin', 4, 8)).toEqual([4 / 32, 8 / 64]);
    expect(set.normalizeUv('foo', 4, 8)).toEqual([4 / 16, 8 / 16]);
  });

  it('normalized uv → png texel equals the k-scale rule (k = pngWidth / shapeTextureWidth)', () => {
    // 8×4 png under shape texture size 4×4 → kx = 2, ky = 1.
    const abs = writeTestPng('kscale.png', () => 255);
    const kdoc = makeDoc({
      textureWidth: 4,
      textureHeight: 4,
      textures: { t: 'kscale' },
      elements: [
        {
          name: 'e',
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: { north: { texture: '#t', uv: [0, 0, 4, 4] } },
        },
      ],
    });
    const set = createTextureSet(kdoc, [(p) => (p === 'kscale' ? abs : null)]);
    expect(set.missing).toEqual([]);
    const tex = set.textures[set.idFor('t')]!;
    // shape uv (1.2, 1.7) → png texel (floor(1.2·2), floor(1.7·1)) = (2, 1)
    const [nu, nv] = set.normalizeUv('t', 1.2, 1.7);
    const sample = sampleNearest(tex, nu, nv);
    expect(sample).toEqual([2 * 30, 1 * 60, 7, 255]);
  });

  it('idFor / normalizeUv name unknown keys and list known ones', () => {
    const set = createTextureSet(doc, []);
    expect(() => set.idFor('nope')).toThrow(/'nope'.*known keys: skin, foo/);
    expect(() => set.normalizeUv('nope', 0, 0)).toThrow(/'nope'/);
  });

  it('resolvers are consulted in order; an unreadable hit falls through to the next', () => {
    const abs = writeTestPng('second.png', () => 255);
    const set = createTextureSet(doc, [
      () => path.join(tempDir, 'does-not-exist.png'), // resolves but unreadable
      (p) => (p === 'some/skin' ? abs : null),
    ]);
    expect(set.missing).toEqual(['foo']); // skin found via second resolver
    expect(set.textures[set.idFor('skin')]!.width).toBe(8);
  });
});

describe('missing-texture fallback', () => {
  it('is a deterministic 1×1 flat color per key (alpha 255), stable across calls', () => {
    const doc = makeDoc({
      textures: { alpha: 'no/such/a', beta: 'no/such/b' },
      elements: [
        {
          name: 'e',
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: {
            north: { texture: '#alpha', uv: [0, 0, 4, 4] },
            south: { texture: '#beta', uv: [0, 0, 4, 4] },
          },
        },
      ],
    });
    const a = createTextureSet(doc, []);
    const b = createTextureSet(doc, []);
    expect(a.missing).toEqual(['alpha', 'beta']);
    const texA1 = a.textures[a.idFor('alpha')]!;
    const texA2 = b.textures[b.idFor('alpha')]!;
    expect(texA1.width).toBe(1);
    expect(texA1.height).toBe(1);
    expect([...texA1.rgba]).toEqual([...texA2.rgba]);
    expect([...texA1.rgba.subarray(0, 3)]).toEqual(fallbackColor('alpha'));
    expect(texA1.rgba[3]).toBe(255);
    // Different keys hash to different hues (pinned for these two names).
    expect(fallbackColor('alpha')).not.toEqual(fallbackColor('beta'));
  });

  it('faces referencing keys absent from the textures map also fall back (and are reported)', () => {
    const doc = makeDoc({
      elements: [
        {
          name: 'e',
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: { north: { texture: '#ghost', uv: [0, 0, 4, 4] } },
        },
      ],
    });
    const set = createTextureSet(doc, []);
    expect(set.missing).toEqual(['ghost']);
    expect(set.textures[set.idFor('ghost')]!.width).toBe(1);
  });
});

describe('sampleNearest', () => {
  const tex: TexturePixels = {
    width: 2,
    height: 2,
    // tl red a255 | tr green a128 ; bl blue a127 | br white a0
    rgba: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 127, 255, 255, 255, 0),
  };

  it('nearest texel with clamp-to-edge', () => {
    expect(sampleNearest(tex, 0.25, 0.25)).toEqual([255, 0, 0, 255]);
    expect(sampleNearest(tex, 0.75, 0.25)).toEqual([0, 255, 0, 128]);
    expect(sampleNearest(tex, -0.5, 0.25)).toEqual([255, 0, 0, 255]); // clamped left
    expect(sampleNearest(tex, 1.5, 0.25)).toEqual([0, 255, 0, 128]); // clamped right
  });

  it('alpha < 13 is the cutout (engine alphaTest 0.05; a 12 discards, 13 keeps — matches GPU < 0.05)', () => {
    expect(sampleNearest(tex, 0.75, 0.75)).toBeNull(); // a 0
    expect(sampleNearest(tex, 0.25, 0.75)).not.toBeNull(); // a 127 — visible in-game (~50% opacity)
    expect(sampleNearest(tex, 0.75, 0.25)).not.toBeNull(); // a 128
    const at = (a: number) =>
      sampleNearest({ width: 1, height: 1, rgba: Uint8Array.of(9, 9, 9, a) }, 0, 0);
    expect(at(12)).toBeNull(); // 12/255 ≈ 0.047 < 0.05 → discarded on both backends
    expect(at(13)).not.toBeNull(); // 13/255 ≈ 0.051 ≥ 0.05 → kept on both backends
  });
});
