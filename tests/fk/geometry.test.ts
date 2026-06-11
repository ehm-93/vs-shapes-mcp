/**
 * Pins for the posed world-space geometry: elementMatrices, posedFaces, modelBounds,
 * footContacts. Expected corner values are hand-computed from GROUND-TRUTH §2 (local
 * transform) and docs/ground-truth/tesselator.md §3–§4 (face emission order, auto-UV).
 */
import { describe, expect, it } from 'vitest';

import {
  elementMatrices,
  footContacts,
  modelBounds,
  posedFaces,
} from '../../src/vs/fk.js';
import { FACE_NAMES, VsNum, type ShapeJson, type Vec3 } from '../../src/vs/types.js';

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

const shape = (raw: unknown): ShapeJson => wrapNums(raw) as ShapeJson;

const face = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  texture: '#skin',
  uv: [0, 0, 16, 16],
  ...over,
});

const allFaces = (): Record<string, unknown> => ({
  north: face(),
  east: face(),
  south: face(),
  west: face(),
  up: face(),
  down: face(),
});

const expectVec = (got: Vec3, want: Vec3, digits = 10): void => {
  expect(got[0]).toBeCloseTo(want[0], digits);
  expect(got[1]).toBeCloseTo(want[1], digits);
  expect(got[2]).toBeCloseTo(want[2], digits);
};

describe('posedFaces — static, axis-aligned', () => {
  const unitCube = shape({
    elements: [{ name: 'cube', from: [0, 0, 0], to: [16, 16, 16], faces: allFaces() }],
  });

  it('emits 6 quads with the exact engine corner order (tesselator.md §3)', () => {
    const faces = posedFaces(unitCube);
    expect(faces.map((f) => f.facing)).toEqual([...FACE_NAMES]);
    const byFacing = Object.fromEntries(faces.map((f) => [f.facing, f.positions]));
    expect(byFacing['north']).toEqual([[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]);
    expect(byFacing['east']).toEqual([[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]);
    expect(byFacing['south']).toEqual([[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]]);
    expect(byFacing['west']).toEqual([[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]]);
    expect(byFacing['up']).toEqual([[1, 1, 1], [1, 1, 0], [0, 1, 0], [0, 1, 1]]);
    expect(byFacing['down']).toEqual([[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]]);
  });

  it('winding is counter-clockwise viewed from outside (north face normal = −Z)', () => {
    const north = posedFaces(unitCube).find((f) => f.facing === 'north')!;
    const [v0, v1, v2] = north.positions;
    // (v1−v0)×(v2−v1) must point outward, i.e. −Z.
    const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const e2 = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]];
    const cross = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ];
    expect(cross[0]).toBe(0);
    expect(cross[1]).toBe(0);
    expect(cross[2]).toBeLessThan(0);
  });

  it('unrotated offset element: corners are from/16 plus the local box (hand-computed)', () => {
    const doc = shape({
      elements: [{ name: 'box', from: [4, 0, 6], to: [12, 8, 10], faces: allFaces() }],
    });
    const faces = posedFaces(doc);
    const north = faces.find((f) => f.facing === 'north')!;
    expect(north.positions).toEqual([
      [0.25, 0, 0.375],
      [0.25, 0.5, 0.375],
      [0.75, 0.5, 0.375],
      [0.75, 0, 0.375],
    ]);
    const up = faces.find((f) => f.facing === 'up')!;
    expect(up.positions).toEqual([
      [0.75, 0.5, 0.625],
      [0.75, 0.5, 0.375],
      [0.25, 0.5, 0.375],
      [0.25, 0.5, 0.625],
    ]);
  });

  it('strips # from texture keys, passes glow through, defaults uvRotation to 0', () => {
    const doc = shape({
      elements: [
        {
          name: 'box',
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: {
            north: face({ glow: 128 }),
            east: face({ texture: 'bare' }),
            up: face({ rotation: 270 }),
          },
        },
      ],
    });
    const faces = posedFaces(doc);
    const north = faces.find((f) => f.facing === 'north')!;
    expect(north.textureKey).toBe('skin');
    expect(north.glow).toBe(128);
    expect(north.uvRotation).toBe(0);
    const east = faces.find((f) => f.facing === 'east')!;
    expect(east.textureKey).toBe('bare');
    expect(east.glow).toBeUndefined();
    expect(faces.find((f) => f.facing === 'up')!.uvRotation).toBe(270);
  });

  it('truncates non-multiple-of-90 rotations like the engine (int cast)', () => {
    const doc = shape({
      elements: [
        {
          name: 'box',
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: { north: face({ rotation: 100 }), east: face({ rotation: -90 }) },
        },
      ],
    });
    const faces = posedFaces(doc);
    expect(faces.find((f) => f.facing === 'north')!.uvRotation).toBe(90);
    // Engine UNDEFINED: negative rotations underflow the engine's UV table (crash).
    // We pin the cyclic normalization this port chose instead.
    expect(faces.find((f) => f.facing === 'east')!.uvRotation).toBe(270);
  });

  it('skips absent faces, enabled:false faces, and malformed uv arrays', () => {
    const doc = shape({
      elements: [
        {
          name: 'box',
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: {
            north: face({ enabled: false }),
            south: face({ uv: [0, 0] }), // length ≠ 4: engine warns and skips
            west: face(),
            up: face(),
            down: face(),
          },
        },
      ],
    });
    expect(posedFaces(doc).map((f) => f.facing)).toEqual(['west', 'up', 'down']);
  });

  it('zero size on ALL axes emits no faces but still parents children; one zero axis emits all 6', () => {
    const doc = shape({
      elements: [
        {
          name: 'pivot',
          from: [8, 8, 8],
          to: [8, 8, 8],
          faces: allFaces(),
          children: [{ name: 'ear', from: [0, 0, 0], to: [16, 0, 16], faces: allFaces() }],
        },
      ],
    });
    const faces = posedFaces(doc);
    // Only the (zero-thickness) child emits — all six of its faces, offset by the
    // pivot's translation T(0.5, 0.5, 0.5).
    expect(faces).toHaveLength(6);
    const north = faces.find((f) => f.facing === 'north')!;
    expect(north.positions[0]).toEqual([0.5, 0.5, 0.5]);
    expect(north.positions[2]).toEqual([1.5, 0.5, 0.5]);
  });

  it('applies the engine auto-UV when uv is absent', () => {
    const doc = shape({
      elements: [
        {
          name: 'box',
          from: [0, 0, 0],
          to: [8, 4, 2],
          faces: {
            north: { texture: '#skin' },
            east: { texture: '#skin' },
            up: { texture: '#skin' },
            down: { texture: '#skin' },
          },
        },
      ],
    });
    const faces = posedFaces(doc);
    expect(faces.find((f) => f.facing === 'north')!.uvRect).toEqual([0, 0, 8, 4]);
    expect(faces.find((f) => f.facing === 'east')!.uvRect).toEqual([0, 0, 2, 4]);
    expect(faces.find((f) => f.facing === 'up')!.uvRect).toEqual([0, 0, 8, 2]);
    expect(faces.find((f) => f.facing === 'down')!.uvRect).toEqual([0, 0, 8, 2]);
  });
});

describe('elementMatrices', () => {
  it('identity for an element at the origin; pure translation for offset from', () => {
    const doc = shape({
      elements: [
        { name: 'origin', from: [0, 0, 0], to: [16, 16, 16], faces: allFaces() },
        { name: 'offset', from: [4, 0, 6], to: [12, 8, 10], faces: allFaces() },
      ],
    });
    const mats = elementMatrices(doc);
    expect(Array.from(mats.get('origin')!)).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    const offset = mats.get('offset')!;
    expect(offset[12]).toBe(0.25);
    expect(offset[13]).toBe(0);
    expect(offset[14]).toBe(0.375);
  });

  it('children accumulate world = parent · local, including the parent pose', () => {
    const doc = shape({
      elements: [
        {
          name: 'parent',
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: allFaces(),
          children: [{ name: 'child', from: [16, 0, 0], to: [32, 16, 16], faces: allFaces() }],
        },
      ],
      animations: [
        {
          name: 'Shift',
          code: 'shift',
          quantityframes: 10,
          keyframes: [
            { frame: 0, elements: { parent: { offsetX: 16, offsetY: 0, offsetZ: 0 } } },
          ],
        },
      ],
    });
    expect(elementMatrices(doc).get('child')![12]).toBe(1);
    const posed = elementMatrices(doc, { anim: 'shift', frame: 0 });
    expect(posed.get('parent')![12]).toBe(1);
    expect(posed.get('child')![12]).toBe(2);
  });

  it('accepts a ShapeDocument-like holder exposing root', () => {
    const root = shape({
      elements: [{ name: 'cube', from: [0, 0, 0], to: [16, 16, 16], faces: allFaces() }],
    });
    const viaHolder = elementMatrices({ root });
    expect(Array.from(viaHolder.get('cube')!)).toEqual(Array.from(elementMatrices(root).get('cube')!));
  });

  it('throws on a frame without an animation and on an unknown animation code', () => {
    const doc = shape({
      elements: [{ name: 'cube', from: [0, 0, 0], to: [16, 16, 16], faces: allFaces() }],
      animations: [{ name: 'Walk', code: 'walk', quantityframes: 2, keyframes: [{ frame: 0, elements: {} }] }],
    });
    expect(() => elementMatrices(doc, { frame: 3 })).toThrowError(/without an animation/);
    expect(() => elementMatrices(doc, { anim: 'run' })).toThrowError(/'run'/);
    expect(() => elementMatrices(doc, { anim: 'run' })).toThrowError(/walk/);
  });
});

describe('posed geometry — animated poses (hand-computed)', () => {
  // One element, two animations identical except for `version`; the keyframe both
  // translates (offsetX 16 → 1 block) and rotates (rotationZ 90°).
  const versionDoc = shape({
    elements: [{ name: 'arm', from: [0, 0, 0], to: [16, 16, 16], faces: allFaces() }],
    animations: [
      {
        name: 'Swing0',
        code: 'swing0',
        quantityframes: 10,
        keyframes: [
          {
            frame: 0,
            elements: {
              arm: { offsetX: 16, offsetY: 0, offsetZ: 0, rotationX: 0, rotationY: 0, rotationZ: 90 },
            },
          },
        ],
      },
      {
        name: 'Swing1',
        code: 'swing1',
        version: 1,
        quantityframes: 10,
        keyframes: [
          {
            frame: 0,
            elements: {
              arm: { offsetX: 16, offsetY: 0, offsetZ: 0, rotationX: 0, rotationY: 0, rotationZ: 90 },
            },
          },
        ],
      },
    ],
  });

  it('animVersion 0: rotate(elem+pose) then translate inside — east v0 → Rz90(p + tx)', () => {
    const east = posedFaces(versionDoc, { anim: 'swing0', frame: 0 }).find(
      (f) => f.facing === 'east',
    )!;
    // M = R z(90°) · T(1,0,0); local (1,0,0) → translate (2,0,0) → rotate (0,2,0).
    expectVec(east.positions[0], [0, 2, 0]);
  });

  it('animVersion 1: translate then pose-rotate last — east v0 → Rz90(p) + tx', () => {
    const east = posedFaces(versionDoc, { anim: 'swing1', frame: 0 }).find(
      (f) => f.facing === 'east',
    )!;
    // M = T(1,0,0) · Rz(90°); local (1,0,0) → rotate (0,1,0) → translate (1,1,0).
    expectVec(east.positions[0], [1, 1, 0]);
  });

  it('stretch scales the local box about the from corner', () => {
    const doc = shape({
      elements: [{ name: 'cube', from: [0, 0, 0], to: [16, 16, 16], faces: allFaces() }],
      animations: [
        {
          name: 'Grow',
          code: 'grow',
          quantityframes: 10,
          keyframes: [
            { frame: 0, elements: { cube: { stretchX: 1, stretchY: 2, stretchZ: 1 } } },
          ],
        },
      ],
    });
    const up = posedFaces(doc, { anim: 'grow', frame: 0 }).find((f) => f.facing === 'up')!;
    expect(up.positions[0]).toEqual([1, 2, 1]);
  });
});

describe('modelBounds', () => {
  it('static bounds equal the from/to extremes in blocks', () => {
    const doc = shape({
      elements: [{ name: 'box', from: [4, 0, 6], to: [12, 8, 10], faces: allFaces() }],
    });
    expect(modelBounds(doc)).toEqual({ min: [0.25, 0, 0.375], max: [0.75, 0.5, 0.625] });
  });

  it('unions across the given frames', () => {
    const doc = shape({
      elements: [{ name: 'foot', from: [4, 0, 4], to: [12, 4, 12], faces: allFaces() }],
      animations: [
        {
          name: 'Walk',
          code: 'walk',
          quantityframes: 2,
          keyframes: [
            { frame: 0, elements: { foot: { offsetX: 0, offsetY: 0, offsetZ: 0 } } },
            { frame: 1, elements: { foot: { offsetX: 16, offsetY: 0, offsetZ: 0 } } },
          ],
        },
      ],
    });
    expect(modelBounds(doc, { anim: 'walk', frames: [0] })).toEqual({
      min: [0.25, 0, 0.25],
      max: [0.75, 0.25, 0.75],
    });
    expect(modelBounds(doc, { anim: 'walk', frames: [0, 1] })).toEqual({
      min: [0.25, 0, 0.25],
      max: [1.75, 0.25, 0.75],
    });
  });

  it('throws when the shape emits no faces', () => {
    const doc = shape({
      elements: [{ name: 'bone', from: [0, 0, 0], to: [16, 16, 16] }],
    });
    expect(() => modelBounds(doc)).toThrowError(/no faces/);
    expect(() => modelBounds(shape({ elements: [] }))).toThrowError(/no elements/);
  });
});

describe('footContacts', () => {
  const doc = shape({
    elements: [{ name: 'foot', from: [4, 0, 4], to: [12, 4, 12], faces: allFaces() }],
    animations: [
      {
        name: 'Walk',
        code: 'walk',
        quantityframes: 2,
        keyframes: [
          { frame: 0, elements: { foot: { offsetX: 0, offsetY: 0, offsetZ: 0 } } },
          { frame: 1, elements: { foot: { offsetX: 16, offsetY: 0, offsetZ: 0 } } },
        ],
      },
    ],
  });

  it('returns the world bottom-center of each element for every integer frame 0..q−1', () => {
    const frames = footContacts(doc, 'walk', { elements: ['foot'] });
    expect(frames.map((f) => f.frame)).toEqual([0, 1]);
    // Bottom-center local point: ((to−from)/32, 0, (to−from)/32) = (0.25, 0, 0.25);
    // world = from/16 + pose.translate + that point.
    expect(frames[0]!.positions['foot']).toEqual([0.5, 0, 0.5]);
    expect(frames[1]!.positions['foot']).toEqual([1.5, 0, 0.5]);
  });

  it('names the missing element and the known ones when asked for a nonexistent element', () => {
    expect(() => footContacts(doc, 'walk', { elements: ['toe'] })).toThrowError(/'toe'/);
    expect(() => footContacts(doc, 'walk', { elements: ['toe'] })).toThrowError(/foot/);
  });
});

describe('posedFaces — world-space shading normals (tesselator.md §6a)', () => {
  it('axis-aligned elements get the facing normal; rotations rotate it', () => {
    const doc = shape({
      elements: [
        { name: 'flat', from: [0, 0, 0], to: [16, 16, 16], faces: allFaces() },
        {
          name: 'tipped',
          from: [0, 0, 0],
          to: [16, 16, 16],
          rotationX: 90,
          faces: allFaces(),
        },
      ],
    });
    const faces = posedFaces(doc);
    const normal = (el: number, facing: string): Vec3 =>
      faces.filter((_, i) => (el === 0 ? i < 6 : i >= 6)).find((f) => f.facing === facing)!.normal;
    expectVec(normal(0, 'north'), [0, 0, -1]);
    expectVec(normal(0, 'up'), [0, 1, 0]);
    // Rx(90°) maps +Y → +Z and −Z → +Y: the rotated element's 'up' face points +Z and
    // its 'north' face points straight up in world space — the engine derives brightness
    // from THESE normals, not the authored facing.
    expectVec(normal(1, 'up'), [0, 0, 1]);
    expectVec(normal(1, 'north'), [0, 1, 0]);
  });

  it('shade:false packs the element-up normal for every face (Lib:155072-155076)', () => {
    const doc = shape({
      elements: [
        { name: 'lamp', from: [0, 0, 0], to: [16, 16, 16], shade: false, faces: allFaces() },
      ],
    });
    for (const f of posedFaces(doc)) expectVec(f.normal, [0, 1, 0]);
  });

  it('gradientShade approximates the per-vertex mix with normalize(0.5·up + face)', () => {
    const doc = shape({
      elements: [
        { name: 'grad', from: [0, 0, 0], to: [16, 16, 16], gradientShade: true, faces: allFaces() },
      ],
    });
    const north = posedFaces(doc).find((f) => f.facing === 'north')!;
    const len = Math.hypot(0, 0.5, -1);
    expectVec(north.normal, [0, 0.5 / len, -1 / len]);
  });
});

describe('duplicate element names — engine pre-order-last-wins animation', () => {
  // Shape.CollectElements overwrites by name (API:148028): only the pre-order-LAST
  // instance of a duplicated name is animated in-game; the rest hold the identity pose.
  const dupDoc = shape({
    elements: [
      { name: 'gear', from: [0, 0, 0], to: [16, 16, 16], faces: { north: face() } },
      { name: 'gear', from: [32, 0, 0], to: [48, 16, 16], faces: { north: face() } },
    ],
    animations: [
      {
        name: 'spin',
        quantityframes: 10,
        keyframes: [
          { frame: 0, elements: { gear: { offsetX: 0, offsetY: 0, offsetZ: 0 } } },
          { frame: 5, elements: { gear: { offsetX: 16, offsetY: 0, offsetZ: 0 } } },
        ],
      },
    ],
  });

  it('posedFaces animates ONLY the last instance; the first stays at the identity pose', () => {
    const faces = posedFaces(dupDoc, { anim: 'spin', frame: 5 });
    // First instance: untouched at x ∈ [0, 1]. Second: offset by 16/16 = 1 block → x = 3.
    expect(faces[0]!.positions[0]![0]).toBe(0);
    expect(faces[1]!.positions[0]![0]).toBe(3);
  });

  it('elementMatrices returns the (engine-correct) pre-order-last instance under the name', () => {
    const m = elementMatrices(dupDoc, { anim: 'spin', frame: 5 })!.get('gear')!;
    expect(m[12]).toBe(2 + 1); // from 32/16 + offset 16/16
  });
});

describe('rootOf duck-typing robustness', () => {
  it('a bare tree without an elements key is treated as a tree, not a document holder', () => {
    // ShapeDocument.parse accepts shapes that omit `elements` entirely; their .root must
    // not crash the geometry entry points (they see an empty tree).
    const bare = shape({ textures: { skin: 'x' } });
    expect(elementMatrices(bare).size).toBe(0);
    expect(posedFaces(bare)).toEqual([]);
    expect(() => modelBounds(bare)).toThrowError(/no elements/);
  });
});
