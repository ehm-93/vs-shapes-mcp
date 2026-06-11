/**
 * Corpus tests against the real fox-male.json from the Vintage Story install.
 * Skips cleanly (with a console note) when the game install is absent.
 *
 * The posedFaces pin is the hand-worked example from docs/ground-truth/tesselator.md §9
 * (fox body north face). Note the fox has no rotation-free element chain — the single
 * root `body` carries a static rotationZ of 1°, inherited by every element — so the
 * "unrotated corners" pin lives in tests/fk/geometry.test.ts on a synthetic shape, and
 * this file pins the exact hand-computed 1°-rolled world corners instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { elementMatrices, footContacts, interpolatePose, modelBounds, posedFaces } from '../../src/vs/fk.js';
import { VsNum, type AnimationJson, type ShapeJson } from '../../src/vs/types.js';

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

const gameDir = process.env['VINTAGE_STORY'] ?? path.join(process.env['APPDATA'] ?? '', 'Vintagestory');
const foxPath = path.join(gameDir, 'assets', 'survival', 'shapes', 'entity', 'animal', 'mammal', 'fox', 'fox-male.json');
const haveFox = existsSync(foxPath);
if (!haveFox) {
  console.error(`tests/fk/fox.test.ts: Vintage Story install not found at ${gameDir} — skipping corpus tests`);
}

const fox: ShapeJson = haveFox
  ? (wrapNums(JSON.parse(readFileSync(foxPath, 'utf8'))) as ShapeJson)
  : ({ elements: [] } as unknown as ShapeJson);

describe.skipIf(!haveFox)('fox-male.json (corpus)', () => {
  it('static modelBounds are sane: positive volume, every extent under 2 blocks', () => {
    const { min, max } = modelBounds(fox);
    for (let axis = 0; axis < 3; axis++) {
      const extent = max[axis]! - min[axis]!;
      expect(extent, `extent on axis ${axis}`).toBeGreaterThan(0);
      expect(extent, `extent on axis ${axis}`).toBeLessThan(2);
      expect(Number.isFinite(min[axis]!)).toBe(true);
      expect(Number.isFinite(max[axis]!)).toBe(true);
    }
    // The fox model sits around the block-center anchor (8,0,8)/16 with feet near y=0.
    expect(min[1]!).toBeGreaterThan(-0.5);
    expect(min[1]!).toBeLessThan(0.5);
  });

  it('walk animation: two frames yield different L front leg world matrices', () => {
    const at5 = elementMatrices(fox, { anim: 'walk', frame: 5 }).get('L front leg')!;
    const at15 = elementMatrices(fox, { anim: 'walk', frame: 15 }).get('L front leg')!;
    expect(at5).toBeDefined();
    expect(at15).toBeDefined();
    let maxDiff = 0;
    for (let i = 0; i < 16; i++) maxDiff = Math.max(maxDiff, Math.abs(at5[i]! - at15[i]!));
    expect(maxDiff).toBeGreaterThan(1e-6);
    // Static pose differs from both.
    const stat = elementMatrices(fox).get('L front leg')!;
    let statDiff = 0;
    for (let i = 0; i < 16; i++) statDiff = Math.max(statDiff, Math.abs(stat[i]! - at5[i]!));
    expect(statDiff).toBeGreaterThan(1e-6);
  });

  it('interpolatePose pins real walk keyframe values exactly at and between keys', () => {
    const walk = (fox.animations ?? []).find((a) => (a.code ?? a.name) === 'walk') as AnimationJson;
    expect(walk).toBeDefined();
    // Keyframe at frame 2: L front leg offset (0.5, 0.5, 0)/16, rotation (2, 0, 0).
    const at2 = interpolatePose(walk, 2).get('L front leg')!;
    expect(at2.translateX).toBeCloseTo(0.5 / 16, 12);
    expect(at2.translateY).toBeCloseTo(0.5 / 16, 12);
    expect(at2.degX).toBeCloseTo(2, 12);
    expect(at2.degZ).toBeCloseTo(0, 12);
    // Frame 7 is halfway to the keyframe at 12 (offset (−1, −0.5, 0)/16, rotation (0, 0, −19)).
    const at7 = interpolatePose(walk, 7).get('L front leg')!;
    expect(at7.translateX).toBeCloseTo((0.5 / 16 + -1 / 16) / 2, 12);
    expect(at7.translateY).toBeCloseTo((0.5 / 16 + -0.5 / 16) / 2, 12);
    expect(at7.degX).toBeCloseTo(1, 12);
    expect(at7.degZ).toBeCloseTo(-9.5, 12);
  });

  it('posedFaces matches the hand-computed worked example (tesselator.md §9, body north face)', () => {
    // body: from [4,4,6], to [8,8,10], rotationOrigin [6,6,8], rotationZ 1°;
    // M = T(0.375, 0.375, 0.5) · Rz(1°) · T(−0.125, −0.125, −0.125), box size 0.25³.
    const body = fox.elements[0]!;
    expect(body.name).toBe('body');
    const bodyOnly: ShapeJson = { ...fox, elements: [{ ...body, children: [] }] };

    const faces = posedFaces(bodyOnly);
    expect(faces).toHaveLength(6);
    const north = faces.find((f) => f.facing === 'north')!;
    expect(north.textureKey).toBe('skin');
    expect(north.uvRect).toEqual([0, 4, 4, 8]);
    expect(north.uvRotation).toBe(270);

    // Hand-derived: world p = origin + Rz(1°)·(p_local − [0.125, 0.125, 0.125]) for x/y,
    // z = p_local.z + 0.375.
    const c = Math.cos(Math.PI / 180);
    const s = Math.sin(Math.PI / 180);
    const expected: [number, number, number][] = [
      [0.375 - 0.125 * (c - s), 0.375 - 0.125 * (c + s), 0.375], // v0 local (0,0,0)
      [0.375 - 0.125 * (c + s), 0.375 + 0.125 * (c - s), 0.375], // v1 local (0,.25,0)
      [0.375 + 0.125 * (c - s), 0.375 + 0.125 * (c + s), 0.375], // v2 local (.25,.25,0)
      [0.375 + 0.125 * (c + s), 0.375 - 0.125 * (c - s), 0.375], // v3 local (.25,0,0)
    ];
    // The same values as printed in the ground-truth doc's table:
    const docTable: [number, number, number][] = [
      [0.2522005889, 0.2478374873, 0.375],
      [0.2478374873, 0.4977994111, 0.375],
      [0.4977994111, 0.5021625127, 0.375],
      [0.5021625127, 0.2522005889, 0.375],
    ];
    for (let v = 0; v < 4; v++) {
      for (let axis = 0; axis < 3; axis++) {
        expect(north.positions[v]![axis], `v${v} axis ${axis}`).toBeCloseTo(expected[v]![axis]!, 12);
        expect(north.positions[v]![axis], `v${v} axis ${axis} (doc)`).toBeCloseTo(docTable[v]![axis]!, 9);
      }
    }
  });

  it('footContacts over the walk cycle produces one entry per frame and the feet move', () => {
    const frames = footContacts(fox, 'walk', { elements: ['left front feet'] });
    expect(frames).toHaveLength(40); // walk quantityframes
    expect(frames.map((f) => f.frame)).toEqual([...Array(40).keys()]);
    const xs = frames.map((f) => f.positions['left front feet']![0]);
    const ys = frames.map((f) => f.positions['left front feet']![1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.005);
    expect(ys.every((y) => Number.isFinite(y))).toBe(true);
  });
});
