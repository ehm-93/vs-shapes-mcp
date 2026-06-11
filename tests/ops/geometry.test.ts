/**
 * Geometric pins for vs/elements.ts mirror / scale / reparent, verified through the fk
 * engine port (elementMatrices / modelBounds) rather than by inspecting raw numbers:
 * if the cascade math is wrong, the posed world geometry diverges.
 */
import { describe, expect, it } from 'vitest';

import { ShapeDocument } from '../../src/vs/document.js';
import {
  deleteElement,
  mirrorElement,
  reparentElement,
  scaleElement,
} from '../../src/vs/elements.js';
import { elementMatrices, modelBounds } from '../../src/vs/fk.js';

const docOf = (shape: unknown): ShapeDocument => ShapeDocument.parse(JSON.stringify(shape));

const face = (): unknown => ({ texture: '#skin', uv: [0, 0, 4, 4] });
const allFaces = (): Record<string, unknown> =>
  Object.fromEntries(['north', 'east', 'south', 'west', 'up', 'down'].map((f) => [f, face()]));

/** Asymmetric, multi-axis-rotated subtree; the child has rotations but NO rotationOrigin. */
const wingShape = (): unknown => ({
  textureWidth: 32,
  textureHeight: 32,
  textures: { skin: 'entity/test/skin' },
  elements: [
    {
      name: 'wing',
      from: [9, 2, 3],
      to: [14, 5, 11],
      rotationOrigin: [9, 2, 3],
      rotationX: 20,
      rotationY: 35,
      rotationZ: -50,
      faces: allFaces(),
      children: [
        {
          name: 'tip',
          from: [-2, 1, 0.5],
          to: [7, 2.5, 3],
          rotationX: -15,
          rotationY: 10,
          rotationZ: 40,
          faces: allFaces(),
        },
      ],
    },
  ],
});

const close = (a: number, b: number): void => {
  expect(Math.abs(a - b)).toBeLessThan(1e-9);
};

describe('mirrorElement — exact world-geometry reflection', () => {
  /**
   * Mirror the subtree, then compare fk.modelBounds of the mirrored copy (alone) against
   * the reflection of the original's bounds about the plane. Plane x = about/16 blocks:
   * min'ₓ = 2·A − maxₓ, max'ₓ = 2·A − minₓ; other axes identical.
   */
  const assertMirrorBounds = (axis: 'x' | 'z', about: number): void => {
    const original = docOf(wingShape());
    const mirrored = docOf(wingShape());
    const map = mirrorElement(mirrored, 'wing', axis, { about });
    deleteElement(mirrored, 'wing'); // leave only the mirrored subtree
    const b0 = modelBounds(original);
    const b1 = modelBounds(mirrored);
    const A = (2 * about) / 16; // plane reflection in blocks: v' = 2·(about/16) − v
    const ax = axis === 'x' ? 0 : 2;
    for (let i = 0; i < 3; i++) {
      if (i === ax) {
        close(b1.min[i]!, A - b0.max[i]!);
        close(b1.max[i]!, A - b0.min[i]!);
      } else {
        close(b1.min[i]!, b0.min[i]!);
        close(b1.max[i]!, b0.max[i]!);
      }
    }
    expect(Object.keys(map)).toEqual(['wing', 'tip']);
  };

  it('x-mirror about 8 reflects the posed bounds within 1e-9 (rotated parent + child)', () => {
    assertMirrorBounds('x', 8);
  });

  it('z-mirror about 8 reflects the posed bounds within 1e-9', () => {
    assertMirrorBounds('z', 8);
  });

  it('x-mirror about a non-center plane works too', () => {
    assertMirrorBounds('x', 5.5);
  });

  it('keeps box sizes and copies face UVs as-is (texture mirrors visually, broker is v2)', () => {
    const doc = docOf(wingShape());
    mirrorElement(doc, 'wing', 'x');
    const orig = doc.getElement('wing')!;
    const copy = doc.getElement('wing2')!;
    for (let i = 0; i < 3; i++) {
      close(copy.to[i]!.value - copy.from[i]!.value, orig.to[i]!.value - orig.from[i]!.value);
    }
    expect(copy.faces!.north!.uv.map((v) => v.value)).toEqual(
      orig.faces!.north!.uv.map((v) => v.value),
    );
    // x-mirror: rotationX kept, rotationY and rotationZ negated.
    expect(copy.rotationX!.value).toBe(20);
    expect(copy.rotationY!.value).toBe(-35);
    expect(copy.rotationZ!.value).toBe(50);
    // The child had no rotationOrigin: the mirror materializes the reflected (0,0,0).
    const tip2 = copy.children![0]!;
    expect(tip2.name).toBe('tip2');
    expect(tip2.rotationOrigin!.map((v) => v.value)).toEqual([5, 0, 0]); // parent size on x
  });

  it('applies L/R name-swap heuristics and unique-ifies the rest', () => {
    const doc = docOf({
      textures: { skin: 's' },
      elements: [
        {
          name: 'LegFrontLeft',
          from: [0, 0, 0],
          to: [1, 4, 1],
          faces: { north: face() },
          children: [
            { name: 'L paw', from: [0, 0, 0], to: [1, 1, 1], faces: { north: face() } },
            { name: 'claw-l', from: [0, 0, 0], to: [1, 1, 1], faces: { north: face() } },
            { name: 'dewclaw', from: [0, 0, 0], to: [1, 1, 1], faces: { north: face() } },
          ],
        },
      ],
    });
    const map = mirrorElement(doc, 'LegFrontLeft', 'x');
    expect(map).toEqual({
      LegFrontLeft: 'LegFrontRight',
      'L paw': 'R paw',
      'claw-l': 'claw-r',
      dewclaw: 'dewclaw2', // no heuristic — unique-ified
    });
    // Mirroring again: the swapped names are taken now, so they unique-ify.
    const map2 = mirrorElement(doc, 'LegFrontLeft', 'x');
    expect(map2['LegFrontLeft']).toBe('LegFrontRight2');
  });

  it('honors an explicit newName and refuses collisions', () => {
    const doc = docOf(wingShape());
    const map = mirrorElement(doc, 'wing', 'x', { newName: 'wing-mirror' });
    expect(map['wing']).toBe('wing-mirror');
    expect(() => mirrorElement(doc, 'wing', 'x', { newName: 'tip' })).toThrow(
      /'tip' is already used/,
    );
  });

  it('rejects unsupported axes', () => {
    const doc = docOf(wingShape());
    expect(() => mirrorElement(doc, 'wing', 'y' as 'x')).toThrow(/axis must be 'x' or 'z'/);
  });
});

describe('scaleElement', () => {
  it('scales a subtree about the anchor; descendants scale about their local origin', () => {
    const doc = docOf({
      textures: { skin: 's' },
      elements: [
        {
          name: 'body',
          from: [4, 4, 6],
          to: [8, 8, 10],
          rotationOrigin: [6, 6, 8],
          rotationZ: 10,
          faces: allFaces(),
          children: [
            { name: 'leg', from: [1, -4, 0], to: [2, 0, 1], faces: allFaces() },
          ],
        },
      ],
    });
    scaleElement(doc, 'body', 2, [4, 4, 6]);
    const body = doc.getElement('body')!;
    expect(body.from.map((v) => v.value)).toEqual([4, 4, 6]); // anchor is the from corner
    expect(body.to.map((v) => v.value)).toEqual([12, 12, 14]);
    expect(body.rotationOrigin!.map((v) => v.value)).toEqual([8, 8, 10]);
    expect(body.rotationZ!.value).toBe(10); // rotations never scale
    const leg = doc.getElement('leg')!;
    expect(leg.from.map((v) => v.value)).toEqual([2, -8, 0]); // about (0,0,0)
    expect(leg.to.map((v) => v.value)).toEqual([4, 0, 2]);
  });

  it('whole-model scale doubles the posed bounds and scales keyframe offsets — not rotations/stretch', () => {
    const shape = {
      textures: { skin: 's' },
      elements: [
        { name: 'a', from: [2, 0, 2], to: [6, 4, 6], rotationY: 30, rotationOrigin: [4, 0, 4], faces: allFaces() },
      ],
      animations: [
        {
          name: 'walk',
          code: 'walk',
          quantityframes: 10,
          keyframes: [
            {
              frame: 0,
              elements: {
                a: {
                  offsetX: 1.0, offsetY: 2.0, offsetZ: -3.0,
                  rotationX: 15.0, rotationY: 0.0, rotationZ: 0.0,
                  stretchX: 1.5, stretchY: 1.0, stretchZ: 1.0,
                },
              },
            },
          ],
        },
      ],
    };
    const doc = docOf(shape);
    const before = modelBounds(doc, { anim: 'walk', frames: [0] });
    scaleElement(doc, null, 2, [0, 0, 0]);
    const kfe = doc.getAnimation('walk')!.keyframes[0]!.elements['a']!;
    expect([kfe.offsetX!.value, kfe.offsetY!.value, kfe.offsetZ!.value]).toEqual([2, 4, -6]);
    expect([kfe.rotationX!.value, kfe.rotationY!.value, kfe.rotationZ!.value]).toEqual([15, 0, 0]);
    expect([kfe.stretchX!.value, kfe.stretchY!.value, kfe.stretchZ!.value]).toEqual([1.5, 1, 1]);
    const after = modelBounds(doc, { anim: 'walk', frames: [0] });
    for (let i = 0; i < 3; i++) {
      close(after.min[i]!, before.min[i]! * 2);
      close(after.max[i]!, before.max[i]! * 2);
    }
  });

  it('supports per-axis factors and rejects non-positive ones', () => {
    const doc = docOf({ textures: {}, elements: [{ name: 'a', from: [0, 0, 0], to: [2, 2, 2], faces: allFaces() }] });
    scaleElement(doc, 'a', [1, 2, 3], [0, 0, 0]);
    expect(doc.getElement('a')!.to.map((v) => v.value)).toEqual([2, 4, 6]);
    expect(() => scaleElement(doc, 'a', -1, [0, 0, 0])).toThrow(/use mirrorElement/);
    expect(() => scaleElement(doc, 'a', 0, [0, 0, 0])).toThrow(/> 0/);
  });
});

describe('reparentElement', () => {
  const rigShape = (torsoRotY: number): unknown => ({
    textures: { skin: 's' },
    elements: [
      {
        name: 'torso',
        from: [4, 8, 4],
        to: [12, 14, 12],
        ...(torsoRotY !== 0 ? { rotationOrigin: [8, 8, 8], rotationY: torsoRotY } : {}),
        faces: allFaces(),
        children: [
          {
            name: 'arm',
            from: [-2, -1, 3],
            to: [0, 5, 5],
            rotationOrigin: [-1, 5, 4],
            rotationZ: 25,
            faces: allFaces(),
          },
        ],
      },
      { name: 'pack', from: [6, 14, 6], to: [10, 18, 10], faces: allFaces() },
    ],
  });

  it('preserves the element world matrix exactly when the ancestor chains are unrotated', () => {
    const doc = docOf(rigShape(0));
    const before = elementMatrices(doc).get('arm')!;
    const result = reparentElement(doc, 'arm', null);
    expect(result.warning).toBeUndefined();
    const after = elementMatrices(doc).get('arm')!;
    for (let i = 0; i < 16; i++) close(after[i]!, before[i]!);
    expect(doc.getElement('torso')!.children ?? []).toHaveLength(0);
    expect(doc.root.elements!.map((e) => e.name)).toContain('arm');
    // And back under a different unrotated parent — still exact.
    const before2 = elementMatrices(doc).get('arm')!;
    reparentElement(doc, 'arm', 'pack');
    const after2 = elementMatrices(doc).get('arm')!;
    for (let i = 0; i < 16; i++) close(after2[i]!, before2[i]!);
  });

  it('materializes rotationOrigin for an origin-less rotated element (pivot must travel)', () => {
    const doc = docOf({
      textures: { skin: 's' },
      elements: [
        {
          name: 'base',
          from: [4, 0, 4],
          to: [8, 4, 8],
          faces: allFaces(),
          children: [
            { name: 'blade', from: [1, 4, 1], to: [2, 10, 2], rotationZ: 45, faces: allFaces() },
          ],
        },
      ],
    });
    const before = elementMatrices(doc).get('blade')!;
    reparentElement(doc, 'blade', null);
    const after = elementMatrices(doc).get('blade')!;
    for (let i = 0; i < 16; i++) close(after[i]!, before[i]!);
    // The pivot was (0,0,0) in base's frame; at root it must be base.from to compensate.
    expect(doc.getElement('blade')!.rotationOrigin!.map((v) => v.value)).toEqual([4, 0, 4]);
  });

  it('with a rotated ancestor: warns, but still preserves the rotationOrigin world point exactly', () => {
    const doc = docOf(rigShape(30));
    const mats = elementMatrices(doc);
    const torso = mats.get('torso')!;
    const arm = doc.getElement('arm')!;
    const o = arm.rotationOrigin!.map((v) => v.value / 16) as [number, number, number];
    // World position of the origin point under the old (rotated) parent frame.
    const worldRef = [
      torso[0]! * o[0] + torso[4]! * o[1] + torso[8]! * o[2] + torso[12]!,
      torso[1]! * o[0] + torso[5]! * o[1] + torso[9]! * o[2] + torso[13]!,
      torso[2]! * o[0] + torso[6]! * o[1] + torso[10]! * o[2] + torso[14]!,
    ];
    const result = reparentElement(doc, 'arm', null);
    expect(result.warning).toMatch(/'torso'/);
    expect(result.warning).toMatch(/rotation/);
    // At root level the parent frame is identity: origin/16 IS the world position.
    const newOrigin = doc.getElement('arm')!.rotationOrigin!.map((v) => v.value / 16);
    for (let i = 0; i < 3; i++) close(newOrigin[i]!, worldRef[i]!);
  });

  it('refuses reparenting into its own subtree and self-parenting', () => {
    const doc = docOf(rigShape(0));
    expect(() => reparentElement(doc, 'torso', 'arm')).toThrow(/inside 'torso''s own subtree/);
    expect(() => reparentElement(doc, 'torso', 'torso')).toThrow(/own parent/);
  });

  it('preserveWorld: false moves the subtree without touching the numbers', () => {
    const doc = docOf(rigShape(0));
    const before = doc.getElement('arm')!.from.map((v) => v.value);
    reparentElement(doc, 'arm', null, { preserveWorld: false });
    expect(doc.getElement('arm')!.from.map((v) => v.value)).toEqual(before);
  });
});
