/**
 * Exact port of the engine's matrix math (Mat4f) and element local transform
 * (ShapeElement.GetLocalTransformMatrix).
 *
 * Sources (Vintage Story 1.22, decompiled):
 * - Mat4f: VintagestoryAPI.decompiled.cs:19284 (Span<float> overloads — Translate :19873,
 *   Scale :19973, RotateByXYZ :20294, Mul :19748, MulWithVec3_Position :20780).
 * - ShapeElement.GetLocalTransformMatrix: VintagestoryAPI.decompiled.cs:148741.
 *
 * Conventions (identical to Mat4f / gl-matrix):
 * - Column-major 16-element arrays: m[col*4 + row]; translation lives in m[12..14].
 * - All ops mutate the first argument in place and post-multiply: M = M · op.
 * - We use Float64Array where the engine uses float[]; double precision is a superset of the
 *   engine's float math, so values agree to float precision (~1e-7 relative).
 *
 * See docs/GROUND-TRUTH.md §2–§3 for the normative semantics.
 */

import { IDENTITY_POSE, type PoseTf, type Vec3 } from './types.js';

/** Column-major 4×4 matrix, 16 entries. */
export type Mat4 = Float64Array;

/**
 * Plain-number view of the element fields that feed the local transform.
 * `from`/`rotationOrigin` are in 1/16-block units (raw JSON values); rotations are degrees;
 * scales default to 1. Callers convert VsNum → number before calling.
 */
export interface ElementTransformView {
  from: Vec3;
  rotationOrigin?: Vec3;
  rotationX?: number;
  rotationY?: number;
  rotationZ?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
}

const DEG2RAD = Math.PI / 180;

/** Port of Mat4f.Create(): a fresh identity matrix. */
export function mat4Create(): Mat4 {
  const m = new Float64Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** Port of Mat4f.Identity(output): reset `m` to identity in place. Allocates when omitted. */
export function mat4Identity(m?: Mat4): Mat4 {
  if (m === undefined) return mat4Create();
  m.fill(0);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** Port of Mat4f.Mul(Span a, Span b): a = a · b, in place. Returns `a`. */
export function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const a0 = a[0]!,
    a1 = a[1]!,
    a2 = a[2]!,
    a3 = a[3]!,
    a4 = a[4]!,
    a5 = a[5]!,
    a6 = a[6]!,
    a7 = a[7]!,
    a8 = a[8]!,
    a9 = a[9]!,
    a10 = a[10]!,
    a11 = a[11]!,
    a12 = a[12]!,
    a13 = a[13]!,
    a14 = a[14]!,
    a15 = a[15]!;
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4]!,
      b1 = b[col * 4 + 1]!,
      b2 = b[col * 4 + 2]!,
      b3 = b[col * 4 + 3]!;
    a[col * 4] = b0 * a0 + b1 * a4 + b2 * a8 + b3 * a12;
    a[col * 4 + 1] = b0 * a1 + b1 * a5 + b2 * a9 + b3 * a13;
    a[col * 4 + 2] = b0 * a2 + b1 * a6 + b2 * a10 + b3 * a14;
    a[col * 4 + 3] = b0 * a3 + b1 * a7 + b2 * a11 + b3 * a15;
  }
  return a;
}

/** Port of Mat4f.Translate(Span, x, y, z): m = m · T(x,y,z). Only column 3 changes. */
export function mat4Translate(m: Mat4, x: number, y: number, z: number): Mat4 {
  m[12] = m[12]! + m[0]! * x + m[4]! * y + m[8]! * z;
  m[13] = m[13]! + m[1]! * x + m[5]! * y + m[9]! * z;
  m[14] = m[14]! + m[2]! * x + m[6]! * y + m[10]! * z;
  m[15] = m[15]! + m[3]! * x + m[7]! * y + m[11]! * z;
  return m;
}

/** Port of Mat4f.Scale(Span, x, y, z): m = m · S(x,y,z). Columns 0–2 scale, column 3 untouched. */
export function mat4Scale(m: Mat4, x: number, y: number, z: number): Mat4 {
  m[0] = m[0]! * x;
  m[1] = m[1]! * x;
  m[2] = m[2]! * x;
  m[3] = m[3]! * x;
  m[4] = m[4]! * y;
  m[5] = m[5]! * y;
  m[6] = m[6]! * y;
  m[7] = m[7]! * y;
  m[8] = m[8]! * z;
  m[9] = m[9]! * z;
  m[10] = m[10]! * z;
  m[11] = m[11]! * z;
  return m;
}

/**
 * Port of Mat4f.RotateByXYZ(Span, radX, radY, radZ): m = m · (Rx · Ry · Rz).
 *
 * The combined rotation post-multiplies, so a column vector is rotated by Z first, then Y,
 * then X (GROUND-TRUTH §3). The engine early-exits when all three angles are zero; preserved
 * here (semantically a no-op either way).
 */
export function mat4RotateByXYZ(m: Mat4, radX: number, radY: number, radZ: number): Mat4 {
  if (radX === 0 && radY === 0 && radZ === 0) return m;
  const sx = Math.sin(radX);
  const cx = Math.cos(radX);
  const sy = Math.sin(radY);
  const cy = Math.cos(radY);
  const sz = Math.sin(radZ);
  const cz = Math.cos(radZ);
  const sxsy = sx * sy;
  const ncxsy = -cx * sy;
  // R = Rx·Ry·Rz, column-major (only the 3×3 block; w row/col are identity):
  const r00 = cy * cz;
  const r10 = sxsy * cz + cx * sz;
  const r20 = ncxsy * cz + sx * sz;
  const r01 = -cy * sz;
  const r11 = cx * cz - sxsy * sz;
  const r21 = sx * cz - ncxsy * sz;
  const r02 = sy;
  const r12 = -sx * cy;
  const r22 = cx * cy;
  const m0 = m[0]!,
    m1 = m[1]!,
    m2 = m[2]!,
    m3 = m[3]!,
    m4 = m[4]!,
    m5 = m[5]!,
    m6 = m[6]!,
    m7 = m[7]!,
    m8 = m[8]!,
    m9 = m[9]!,
    m10 = m[10]!,
    m11 = m[11]!;
  m[0] = r00 * m0 + r10 * m4 + r20 * m8;
  m[1] = r00 * m1 + r10 * m5 + r20 * m9;
  m[2] = r00 * m2 + r10 * m6 + r20 * m10;
  m[3] = r00 * m3 + r10 * m7 + r20 * m11;
  m[4] = r01 * m0 + r11 * m4 + r21 * m8;
  m[5] = r01 * m1 + r11 * m5 + r21 * m9;
  m[6] = r01 * m2 + r11 * m6 + r21 * m10;
  m[7] = r01 * m3 + r11 * m7 + r21 * m11;
  m[8] = r02 * m0 + r12 * m4 + r22 * m8;
  m[9] = r02 * m1 + r12 * m5 + r22 * m9;
  m[10] = r02 * m2 + r12 * m6 + r22 * m10;
  m[11] = r02 * m3 + r12 * m7 + r22 * m11;
  return m;
}

/**
 * Port of Mat4f.MulWithVec3_Position: transform a point (w = 1, translation applies).
 * No perspective divide — every matrix built here is affine.
 */
export function mat4TransformVec3(m: Mat4, v: Vec3): Vec3 {
  const [x, y, z] = v;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

/**
 * Exact port of ShapeElement.GetLocalTransformMatrix (VintagestoryAPI.decompiled.cs:148741),
 * per GROUND-TRUTH §2. `animVersion` is the *animation's* `version` field; the engine treats
 * exactly 1 specially and everything else as version 0.
 *
 * animVersion 0:  M = T(origin) · R(elem+pose) · S(elem·pose) · T(from/16 + pose.translate − origin)
 * animVersion 1:  M = T(origin) · S(elem) · R(elem) · T(−origin + from/16 + pose.translate)
 *                     · S(pose) · R(pose)
 *
 * The engine's pose `degX + degOffX` pair is collapsed into PoseTf.degX (the animator sums
 * them before composing; identity pose has both zero). With the default identity pose, both
 * branches reduce to the static element transform.
 */
export function localTransformMatrix(
  el: ElementTransformView,
  animVersion: 0 | 1,
  pose: PoseTf = IDENTITY_POSE,
): Mat4 {
  const m = mat4Create();
  const ox = (el.rotationOrigin?.[0] ?? 0) / 16;
  const oy = (el.rotationOrigin?.[1] ?? 0) / 16;
  const oz = (el.rotationOrigin?.[2] ?? 0) / 16;
  const rx = el.rotationX ?? 0;
  const ry = el.rotationY ?? 0;
  const rz = el.rotationZ ?? 0;
  const sx = el.scaleX ?? 1;
  const sy = el.scaleY ?? 1;
  const sz = el.scaleZ ?? 1;
  if (animVersion === 1) {
    mat4Translate(m, ox, oy, oz);
    mat4Scale(m, sx, sy, sz);
    mat4RotateByXYZ(m, rx * DEG2RAD, ry * DEG2RAD, rz * DEG2RAD);
    mat4Translate(
      m,
      -ox + el.from[0] / 16 + pose.translateX,
      -oy + el.from[1] / 16 + pose.translateY,
      -oz + el.from[2] / 16 + pose.translateZ,
    );
    mat4Scale(m, pose.scaleX, pose.scaleY, pose.scaleZ);
    mat4RotateByXYZ(m, pose.degX * DEG2RAD, pose.degY * DEG2RAD, pose.degZ * DEG2RAD);
  } else {
    mat4Translate(m, ox, oy, oz);
    mat4RotateByXYZ(
      m,
      (rx + pose.degX) * DEG2RAD,
      (ry + pose.degY) * DEG2RAD,
      (rz + pose.degZ) * DEG2RAD,
    );
    mat4Scale(m, sx * pose.scaleX, sy * pose.scaleY, sz * pose.scaleZ);
    mat4Translate(
      m,
      el.from[0] / 16 + pose.translateX - ox,
      el.from[1] / 16 + pose.translateY - oy,
      el.from[2] / 16 + pose.translateZ - oz,
    );
  }
  return m;
}
