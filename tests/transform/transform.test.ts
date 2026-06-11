/**
 * Pins src/vs/transform.ts against independently-built reference math.
 *
 * Reference helpers below are textbook column-major implementations written from scratch
 * (not via the module under test) so agreement actually verifies the port:
 * Mat4f semantics per VintagestoryAPI.decompiled.cs (Mat4f :19284,
 * ShapeElement.GetLocalTransformMatrix :148741) and docs/GROUND-TRUTH.md §2–§3.
 */

import { describe, expect, it } from 'vitest';
import {
  type ElementTransformView,
  type Mat4,
  localTransformMatrix,
  mat4Create,
  mat4Identity,
  mat4Mul,
  mat4RotateByXYZ,
  mat4Scale,
  mat4TransformVec3,
  mat4Translate,
} from '../../src/vs/transform.js';
import type { PoseTf, Vec3 } from '../../src/vs/types.js';

// ---------------------------------------------------------------------------
// Reference implementations (plain number[], column-major: m[col*4 + row])
// ---------------------------------------------------------------------------

type RefMat = number[];

function refIdentity(): RefMat {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Textbook column-major multiply: out = a · b (fresh array). */
function refMul(a: RefMat, b: RefMat): RefMat {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function refMulChain(...ms: RefMat[]): RefMat {
  return ms.reduce((acc, m) => refMul(acc, m), refIdentity());
}

function refTranslate(x: number, y: number, z: number): RefMat {
  const m = refIdentity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

function refScale(x: number, y: number, z: number): RefMat {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

/** Standard right-handed rotation about +X: y→z. Columns: (1,0,0),(0,c,s),(0,−s,c). */
function refRotX(rad: number): RefMat {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

/** Standard right-handed rotation about +Y: z→x. Columns: (c,0,−s),(0,1,0),(s,0,c). */
function refRotY(rad: number): RefMat {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

/** Standard right-handed rotation about +Z: x→y. Columns: (c,s,0),(−s,c,0),(0,0,1). */
function refRotZ(rad: number): RefMat {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Engine rotation: R = Rx · Ry · Rz (GROUND-TRUTH §3). */
function refRotXYZ(radX: number, radY: number, radZ: number): RefMat {
  return refMulChain(refRotX(radX), refRotY(radY), refRotZ(radZ));
}

function refTransformPoint(m: RefMat, v: Vec3): Vec3 {
  const [x, y, z] = v;
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
  ];
}

function expectMatClose(actual: Mat4 | RefMat, expected: RefMat, digits = 12): void {
  expect(actual).toHaveLength(16);
  for (let i = 0; i < 16; i++) {
    expect(actual[i], `matrix entry [${i}] (col ${Math.floor(i / 4)}, row ${i % 4})`).toBeCloseTo(
      expected[i] ?? NaN,
      digits,
    );
  }
}

function maxAbsDiff(a: Mat4 | RefMat, b: Mat4 | RefMat): number {
  let max = 0;
  for (let i = 0; i < 16; i++) {
    max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  }
  return max;
}

function fromRef(m: RefMat): Mat4 {
  return Float64Array.from(m);
}

const DEG2RAD = Math.PI / 180;

// A deterministic, non-degenerate "arbitrary" affine matrix for post-multiply checks:
// T(0.3,−1.2,2.5) · Rx(0.4) · Ry(−1.1) · Rz(2.0) · S(1.5, 0.25, −2)
const ARBITRARY: RefMat = refMulChain(
  refTranslate(0.3, -1.2, 2.5),
  refRotXYZ(0.4, -1.1, 2.0),
  refScale(1.5, 0.25, -2),
);

// ---------------------------------------------------------------------------
// Basic ops
// ---------------------------------------------------------------------------

describe('mat4Create / mat4Identity', () => {
  it('mat4Create returns a fresh Float64Array(16) identity', () => {
    const m = mat4Create();
    expect(m).toBeInstanceOf(Float64Array);
    expectMatClose(m, refIdentity(), 15);
    expect(mat4Create()).not.toBe(m); // fresh allocation each call
  });

  it('mat4Identity resets an existing matrix in place and returns it', () => {
    const m = fromRef(ARBITRARY);
    const out = mat4Identity(m);
    expect(out).toBe(m);
    expectMatClose(m, refIdentity(), 15);
  });

  it('mat4Identity() with no argument allocates an identity', () => {
    expectMatClose(mat4Identity(), refIdentity(), 15);
  });
});

describe('mat4Mul', () => {
  it('computes a = a·b in place (column-major) and returns a', () => {
    const aRef = ARBITRARY;
    const bRef = refMulChain(refRotXYZ(-0.2, 0.9, 0.31), refTranslate(4, -5, 6));
    const a = fromRef(aRef);
    const out = mat4Mul(a, fromRef(bRef));
    expect(out).toBe(a);
    expectMatClose(a, refMul(aRef, bRef), 12);
  });

  it('multiplying by identity is a no-op; order matters for non-commuting matrices', () => {
    const a = fromRef(ARBITRARY);
    mat4Mul(a, mat4Create());
    expectMatClose(a, ARBITRARY, 15);

    const t = refTranslate(1, 2, 3);
    const r = refRotXYZ(0.5, 0, 0);
    expect(maxAbsDiff(refMul(t, r), refMul(r, t))).toBeGreaterThan(0.1);
    const tr = mat4Mul(fromRef(t), fromRef(r));
    const rt = mat4Mul(fromRef(r), fromRef(t));
    expectMatClose(tr, refMul(t, r), 12);
    expectMatClose(rt, refMul(r, t), 12);
  });
});

describe('mat4Translate', () => {
  it('post-multiplies: m = m·T, only column 3 changes', () => {
    const m = fromRef(ARBITRARY);
    mat4Translate(m, 0.7, -2.4, 13);
    expectMatClose(m, refMul(ARBITRARY, refTranslate(0.7, -2.4, 13)), 12);
    // columns 0–2 untouched
    for (let i = 0; i < 12; i++) {
      expect(m[i]).toBe(ARBITRARY[i]);
    }
  });

  it('on identity, writes the offset into m[12..14]', () => {
    const m = mat4Translate(mat4Create(), 3, 4, 5);
    expect([m[12], m[13], m[14], m[15]]).toEqual([3, 4, 5, 1]);
  });
});

describe('mat4Scale', () => {
  it('post-multiplies: m = m·S, scales columns 0–2 and leaves column 3 untouched', () => {
    const m = fromRef(ARBITRARY);
    mat4Scale(m, 2, -0.5, 3.25);
    expectMatClose(m, refMul(ARBITRARY, refScale(2, -0.5, 3.25)), 12);
    for (let i = 12; i < 16; i++) {
      expect(m[i]).toBe(ARBITRARY[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// RotateByXYZ
// ---------------------------------------------------------------------------

describe('mat4RotateByXYZ', () => {
  const triples: [number, number, number][] = [
    [0.3, -0.7, 1.2],
    [-1.0, 0.5, -2.2],
    [Math.PI / 2, 0, 0],
    [0, -Math.PI / 3, 0],
    [0, 0, 2.7],
    [-0.4, -0.5, -0.6],
    [3.1, -2.9, 0.05],
  ];

  it.each(triples)('equals the reference Rx·Ry·Rz for angles (%f, %f, %f)', (x, y, z) => {
    const m = mat4RotateByXYZ(mat4Create(), x, y, z);
    expectMatClose(m, refRotXYZ(x, y, z), 12);
  });

  it.each(triples)('post-multiplies an arbitrary matrix: M·(Rx·Ry·Rz) for (%f, %f, %f)', (x, y, z) => {
    const m = mat4RotateByXYZ(fromRef(ARBITRARY), x, y, z);
    expectMatClose(m, refMul(ARBITRARY, refRotXYZ(x, y, z)), 12);
  });

  it('rotates a column vector Z first, then Y, then X', () => {
    const [x, y, z] = [0.3, -0.7, 1.2];
    const m = mat4RotateByXYZ(mat4Create(), x, y, z);
    const v: Vec3 = [0.8, -0.3, 0.55];
    const stepwise = refTransformPoint(refRotX(x), refTransformPoint(refRotY(y), refTransformPoint(refRotZ(z), v)));
    const direct = mat4TransformVec3(m, v);
    expect(direct[0]).toBeCloseTo(stepwise[0], 12);
    expect(direct[1]).toBeCloseTo(stepwise[1], 12);
    expect(direct[2]).toBeCloseTo(stepwise[2], 12);
  });

  it('all-zero angles leave the matrix untouched (engine early-exit)', () => {
    const m = fromRef(ARBITRARY);
    mat4RotateByXYZ(m, 0, 0, 0);
    expect(Array.from(m)).toEqual(ARBITRARY);
  });
});

describe('post-multiply composition semantics', () => {
  it('T then R differs from R then T, each matching manual composition', () => {
    const tArgs: [number, number, number] = [1, 2, 3];
    const rArgs: [number, number, number] = [0.4, -0.8, 1.5];
    const tRef = refTranslate(...tArgs);
    const rRef = refRotXYZ(...rArgs);

    const m1 = mat4Create(); // T then R → M = T·R
    mat4Translate(m1, ...tArgs);
    mat4RotateByXYZ(m1, ...rArgs);
    expectMatClose(m1, refMul(tRef, rRef), 12);

    const m2 = mat4Create(); // R then T → M = R·T
    mat4RotateByXYZ(m2, ...rArgs);
    mat4Translate(m2, ...tArgs);
    expectMatClose(m2, refMul(rRef, tRef), 12);

    expect(maxAbsDiff(m1, m2)).toBeGreaterThan(0.1);
    // T·R keeps the raw translation; R·T rotates it.
    expect([m1[12], m1[13], m1[14]]).toEqual([1, 2, 3]);
    expect(maxAbsDiff(fromRef([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, m2[12]!, m2[13]!, m2[14]!, 0]),
      fromRef([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 0]))).toBeGreaterThan(0.1);
  });
});

describe('mat4TransformVec3', () => {
  it('treats v as a position (w = 1): translation applies', () => {
    const m = mat4Translate(mat4Create(), 5, -6, 7);
    expect(mat4TransformVec3(m, [1, 2, 3])).toEqual([6, -4, 10]);
  });

  it('matches reference transform through an arbitrary affine matrix', () => {
    const v: Vec3 = [-0.25, 1.5, 0.75];
    const got = mat4TransformVec3(fromRef(ARBITRARY), v);
    const want = refTransformPoint(ARBITRARY, v);
    expect(got[0]).toBeCloseTo(want[0], 12);
    expect(got[1]).toBeCloseTo(want[1], 12);
    expect(got[2]).toBeCloseTo(want[2], 12);
  });
});

// ---------------------------------------------------------------------------
// localTransformMatrix
// ---------------------------------------------------------------------------

describe('localTransformMatrix', () => {
  // Element with both rotation and (non-uniform) scale so v0 and v1 compose differently.
  const el: ElementTransformView = {
    from: [2, 3, 4],
    rotationOrigin: [8, 8, 8],
    rotationX: 30,
    rotationY: 45,
    rotationZ: 60,
    scaleX: 2,
    scaleY: 0.5,
    scaleZ: 1.25,
  };
  const o: Vec3 = [0.5, 0.5, 0.5]; // rotationOrigin/16
  const f: Vec3 = [2 / 16, 3 / 16, 4 / 16]; // from/16
  const rRef = refRotXYZ(30 * DEG2RAD, 45 * DEG2RAD, 60 * DEG2RAD);
  const sRef = refScale(2, 0.5, 1.25);

  it('version 0 + identity pose = T(origin)·R(elem)·S(elem)·T(from/16 − origin)', () => {
    const expected = refMulChain(
      refTranslate(...o),
      rRef,
      sRef,
      refTranslate(f[0] - o[0], f[1] - o[1], f[2] - o[2]),
    );
    expectMatClose(localTransformMatrix(el, 0), expected, 12);
  });

  it('version 1 + identity pose = T(origin)·S(elem)·R(elem)·T(−origin + from/16)', () => {
    const expected = refMulChain(
      refTranslate(...o),
      sRef,
      rRef,
      refTranslate(-o[0] + f[0], -o[1] + f[1], -o[2] + f[2]),
    );
    expectMatClose(localTransformMatrix(el, 1), expected, 12);
  });

  it('versions 0 and 1 DIFFER when rotation and non-uniform scale are both present', () => {
    expect(maxAbsDiff(localTransformMatrix(el, 0), localTransformMatrix(el, 1))).toBeGreaterThan(0.05);
  });

  it('versions agree when scale is uniform (R and S commute)', () => {
    const uniform: ElementTransformView = { ...el, scaleX: 2, scaleY: 2, scaleZ: 2 };
    expectMatClose(localTransformMatrix(uniform, 0), Array.from(localTransformMatrix(uniform, 1)), 12);
  });

  it('defaults: no origin/rotation/scale collapses to T(from/16) for both versions', () => {
    const bare: ElementTransformView = { from: [4, 0, 2] };
    const expected = refTranslate(0.25, 0, 0.125);
    expectMatClose(localTransformMatrix(bare, 0), expected, 15);
    expectMatClose(localTransformMatrix(bare, 1), expected, 15);
  });

  const pose: PoseTf = {
    translateX: 0.125,
    translateY: -0.25,
    translateZ: 0.0625,
    degX: 10,
    degY: -20,
    degZ: 35,
    scaleX: 1.5,
    scaleY: 0.75,
    scaleZ: 2,
  };

  it('version 0 + pose: angles SUM inside one RotateByXYZ, scales multiply, translate adds', () => {
    const expected = refMulChain(
      refTranslate(...o),
      refRotXYZ((30 + 10) * DEG2RAD, (45 - 20) * DEG2RAD, (60 + 35) * DEG2RAD),
      refScale(2 * 1.5, 0.5 * 0.75, 1.25 * 2),
      refTranslate(
        f[0] + pose.translateX - o[0],
        f[1] + pose.translateY - o[1],
        f[2] + pose.translateZ - o[2],
      ),
    );
    expectMatClose(localTransformMatrix(el, 0, pose), expected, 12);
    // Summed angles are NOT the same as R(elem)·R(pose) — pin that the port sums.
    const sequential = refMulChain(
      refTranslate(...o),
      rRef,
      refRotXYZ(10 * DEG2RAD, -20 * DEG2RAD, 35 * DEG2RAD),
      refScale(2 * 1.5, 0.5 * 0.75, 1.25 * 2),
      refTranslate(
        f[0] + pose.translateX - o[0],
        f[1] + pose.translateY - o[1],
        f[2] + pose.translateZ - o[2],
      ),
    );
    expect(maxAbsDiff(localTransformMatrix(el, 0, pose), sequential)).toBeGreaterThan(0.01);
  });

  it('version 1 + pose: pose S·R post-multiplied after the element transform', () => {
    const expected = refMulChain(
      refTranslate(...o),
      sRef,
      rRef,
      refTranslate(
        -o[0] + f[0] + pose.translateX,
        -o[1] + f[1] + pose.translateY,
        -o[2] + f[2] + pose.translateZ,
      ),
      refScale(1.5, 0.75, 2),
      refRotXYZ(10 * DEG2RAD, -20 * DEG2RAD, 35 * DEG2RAD),
    );
    expectMatClose(localTransformMatrix(el, 1, pose), expected, 12);
  });
});

// ---------------------------------------------------------------------------
// Numeric fixture: fox body
// ---------------------------------------------------------------------------

describe('fox body numeric fixture', () => {
  // from [4,4,6], to [8,8,10], rotationOrigin [6,6,8], rotationZ 1 (degrees).
  // origin = (0.375, 0.375, 0.5); from/16 = (0.25, 0.25, 0.375); (to−from)/16 = (0.25, 0.25, 0.25).
  // Static pose: world(p) = origin + Rz(1°)·(p + from/16 − origin), Rz about +Z (x→y).
  // With c = cos 1° = 0.99984769515639127, s = sin 1° = 0.017452406437283512:
  //   p = (0,0,0):        q = (−0.125, −0.125, −0.125)
  //     x = 0.375 + 0.125·(s − c) = 0.25220058891011155
  //     y = 0.375 − 0.125·(s + c) = 0.24783748730079067
  //     z = 0.5 − 0.125          = 0.375
  //   p = (0.25,0.25,0.25): q = (0.125, 0.125, 0.125)
  //     x = 0.375 + 0.125·(c − s) = 0.49779941108988845
  //     y = 0.375 + 0.125·(c + s) = 0.50216251269920931
  //     z = 0.5 + 0.125          = 0.625
  const foxBody: ElementTransformView = {
    from: [4, 4, 6],
    rotationOrigin: [6, 6, 8],
    rotationZ: 1,
  };

  it.each([0, 1] as const)('animVersion %d transforms local (0,0,0) to hand-computed world position', (v) => {
    const m = localTransformMatrix(foxBody, v);
    const p = mat4TransformVec3(m, [0, 0, 0]);
    expect(p[0]).toBeCloseTo(0.25220058891011155, 14);
    expect(p[1]).toBeCloseTo(0.24783748730079067, 14);
    expect(p[2]).toBeCloseTo(0.375, 14);
  });

  it.each([0, 1] as const)('animVersion %d transforms local (to−from)/16 to hand-computed world position', (v) => {
    const m = localTransformMatrix(foxBody, v);
    const p = mat4TransformVec3(m, [0.25, 0.25, 0.25]);
    expect(p[0]).toBeCloseTo(0.49779941108988845, 14);
    expect(p[1]).toBeCloseTo(0.50216251269920931, 14);
    expect(p[2]).toBeCloseTo(0.625, 14);
  });

  it('rotation about Z by +1° nudges the box counter-clockwise seen from +Z (x→y)', () => {
    // The corner at max x/y moves: x slightly down, y slightly up (right-handed +Z rotation).
    const m = localTransformMatrix(foxBody, 0);
    const p = mat4TransformVec3(m, [0.25, 0.25, 0.25]);
    expect(p[0]).toBeLessThan(0.5); // unrotated would be exactly 0.5
    expect(p[1]).toBeGreaterThan(0.5);
  });
});
