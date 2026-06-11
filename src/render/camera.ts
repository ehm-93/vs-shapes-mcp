/**
 * Orthographic cameras for the shape renderer.
 *
 * World conventions (docs/GROUND-TRUTH.md §1): right-handed, Y up, north = −Z, so
 * east = +X, south = +Z, west = −X. Screen conventions (render/raster.ts): x right,
 * y DOWN, depth z grows AWAY from the camera (smaller = nearer).
 *
 * Yaw/pitch convention:
 * - yawDeg rotates the camera's FORWARD direction (the direction it looks) around world
 *   Y: forward = (sin yaw · cos pitch, sin pitch, cos yaw · cos pitch). yaw 0 looks
 *   toward +Z; yaw grows counter-clockwise seen from above (+Z → +X → −Z → −X).
 * - pitchDeg tilts forward up/down: NEGATIVE pitch looks downward, i.e. the camera sits
 *   above the model ("slightly above" the named views below). pitch −90 looks straight
 *   down (top view), +90 straight up (bottom view).
 *
 * Compass views name the side of the model the camera LOOKS AT: view 'n' puts the camera
 * on the −Z (north) side looking toward +Z. Default table (see {@link viewToYawPitch}):
 *
 * | view   | yawDeg | pitchDeg | camera sits at        | screen-right is |
 * |--------|--------|----------|-----------------------|-----------------|
 * | n      |    0   |   −10    | north (−Z)            | west  (−X)      |
 * | ne     |  315   |   −20    | north-east (+X, −Z)   |                 |
 * | e      |  270   |   −10    | east  (+X)            | north (−Z)      |
 * | se     |  225   |   −20    | south-east (+X, +Z)   |                 |
 * | s      |  180   |   −10    | south (+Z)            | east  (+X)      |
 * | sw     |  135   |   −20    | south-west (−X, +Z)   |                 |
 * | w      |   90   |   −10    | west  (−X)            | south (+Z)      |
 * | nw     |   45   |   −20    | north-west (−X, −Z)   |                 |
 * | top    |    0   |   −90    | above (+Y)            | west (−X); south at screen-top |
 * | bottom |    0   |   +90    | below (−Y)            | west (−X); north at screen-top |
 *
 * The top/bottom screen orientations follow continuously from tilting the 'n' camera all
 * the way down/up (view composition adds an N-axis marker so orientation is discoverable).
 */

import type { Vec3 } from '../vs/types.js';

export type ViewName = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' | 'top' | 'bottom';

export const VIEW_NAMES: readonly ViewName[] = [
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
  'nw',
  'top',
  'bottom',
];

export interface Viewport {
  w: number;
  h: number;
}

export interface OrthoCameraOpts {
  yawDeg: number;
  pitchDeg: number;
  /** World point projected to the viewport center (and the z = 0 depth plane). */
  center: Vec3;
  /** World length (blocks) mapped onto min(viewport.w, viewport.h) pixels. Must be > 0. */
  extent: number;
  viewport: Viewport;
}

export interface ScreenPoint {
  /** Pixel x. */
  x: number;
  /** Pixel y (down). */
  y: number;
  /**
   * Depth in WORLD units relative to the plane through `center` perpendicular to the
   * view direction; grows away from the camera, so smaller = nearer (raster convention).
   */
  z: number;
}

export interface OrthoCamera {
  worldToScreen(v: Vec3): ScreenPoint;
  /** Pixels per world unit: min(viewport.w, viewport.h) / extent. For scale bars. */
  readonly pxPerUnit: number;
  readonly viewport: Readonly<Viewport>;
}

/** Creates an orthographic camera; see the module doc for the yaw/pitch convention. */
export function createOrthoCamera(opts: OrthoCameraOpts): OrthoCamera {
  const { yawDeg, pitchDeg, center, extent, viewport } = opts;
  if (!Number.isFinite(yawDeg) || !Number.isFinite(pitchDeg)) {
    throw new Error(
      `createOrthoCamera: yawDeg/pitchDeg must be finite, got yaw=${yawDeg}, pitch=${pitchDeg}`,
    );
  }
  if (!Number.isFinite(extent) || extent <= 0) {
    throw new Error(
      `createOrthoCamera: extent must be a positive world length, got ${extent}; ` +
        `use fitOrthoExtent(min, max) to derive one from model bounds`,
    );
  }
  if (
    !Number.isFinite(viewport.w) ||
    !Number.isFinite(viewport.h) ||
    viewport.w <= 0 ||
    viewport.h <= 0
  ) {
    throw new Error(
      `createOrthoCamera: viewport must have positive dimensions, got ${viewport.w}x${viewport.h}`,
    );
  }
  if (!Number.isFinite(center[0]) || !Number.isFinite(center[1]) || !Number.isFinite(center[2])) {
    throw new Error(
      `createOrthoCamera: center must be finite, got [${center[0]}, ${center[1]}, ${center[2]}]`,
    );
  }

  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);

  // forward = look direction (screen depth axis); right/up span the screen.
  const fx = sinY * cosP;
  const fy = sinP;
  const fz = cosY * cosP;
  // right is horizontal (independent of pitch): facing +Z (south travel) right is −X.
  const rx = -cosY;
  const rz = sinY;
  // up = right × forward; unit because right ⊥ forward and both are unit.
  const ux = rz * -fy; // ry = 0
  const uy = rz * fx - rx * fz;
  const uz = rx * fy;

  const pxPerUnit = Math.min(viewport.w, viewport.h) / extent;
  const halfW = viewport.w / 2;
  const halfH = viewport.h / 2;
  const [cx, cy, cz] = center;
  const vp: Readonly<Viewport> = Object.freeze({ w: viewport.w, h: viewport.h });

  return {
    pxPerUnit,
    viewport: vp,
    worldToScreen(v: Vec3): ScreenPoint {
      const dx = v[0] - cx;
      const dy = v[1] - cy;
      const dz = v[2] - cz;
      return {
        x: halfW + (dx * rx + dz * rz) * pxPerUnit,
        y: halfH - (dx * ux + dy * uy + dz * uz) * pxPerUnit, // screen y down
        z: dx * fx + dy * fy + dz * fz,
      };
    },
  };
}

const VIEW_TABLE: Readonly<Record<ViewName, { yawDeg: number; pitchDeg: number }>> = {
  n: { yawDeg: 0, pitchDeg: -10 },
  ne: { yawDeg: 315, pitchDeg: -20 },
  e: { yawDeg: 270, pitchDeg: -10 },
  se: { yawDeg: 225, pitchDeg: -20 },
  s: { yawDeg: 180, pitchDeg: -10 },
  sw: { yawDeg: 135, pitchDeg: -20 },
  w: { yawDeg: 90, pitchDeg: -10 },
  nw: { yawDeg: 45, pitchDeg: -20 },
  top: { yawDeg: 0, pitchDeg: -90 },
  bottom: { yawDeg: 0, pitchDeg: 90 },
};

/**
 * Maps a named view to camera yaw/pitch (table in the module doc). Compass views name
 * the side of the model the camera LOOKS AT (north = −Z), slightly from above: pitch
 * −10° for cardinals, −20° for diagonals, −90° top, +90° bottom. Pass `overrides` to
 * replace either default (e.g. `{ pitchDeg: 0 }` for a dead-level cardinal view).
 */
export function viewToYawPitch(
  view: ViewName,
  overrides?: Partial<{ yawDeg: number; pitchDeg: number }>,
): { yawDeg: number; pitchDeg: number } {
  const base = VIEW_TABLE[view];
  if (!base) {
    throw new Error(
      `viewToYawPitch: unknown view '${String(view)}'; expected one of ${VIEW_NAMES.join(', ')}`,
    );
  }
  return {
    yawDeg: overrides?.yawDeg ?? base.yawDeg,
    pitchDeg: overrides?.pitchDeg ?? base.pitchDeg,
  };
}

/**
 * Conservative fit of a world AABB for an orthographic camera at ANY yaw/pitch: the
 * box's projection onto any screen axis is at most its diagonal, so
 * extent = |max − min| · (1 + marginFrac) guarantees the whole box fits in the viewport.
 * A degenerate (point) box falls back to extent = 1 block so the camera stays valid.
 */
export function fitOrthoExtent(
  min: Vec3,
  max: Vec3,
  marginFrac = 0.1,
): { center: Vec3; extent: number } {
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(min[i]!) || !Number.isFinite(max[i]!)) {
      throw new Error(
        `fitOrthoExtent: bounds must be finite, got min=[${min.join(', ')}], max=[${max.join(', ')}]`,
      );
    }
  }
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  const diagonal = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const extent = diagonal > 0 ? diagonal * (1 + marginFrac) : 1;
  return {
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    extent,
  };
}
