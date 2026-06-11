import { describe, expect, it } from 'vitest';
import {
  createOrthoCamera,
  fitOrthoExtent,
  viewToYawPitch,
  VIEW_NAMES,
  type ViewName,
} from '../../src/render/camera.js';
import type { Vec3 } from '../../src/vs/types.js';

// 200x100 viewport, extent 4 => pxPerUnit = min(200,100)/4 = 25.
const VIEWPORT = { w: 200, h: 100 };
const EXTENT = 4;
const SCALE = 25;

const ORIGIN: Vec3 = [0, 0, 0];
const NORTH: Vec3 = [0, 0, -1]; // north = -Z (GROUND-TRUTH §1)
const EAST: Vec3 = [1, 0, 0];
const UP: Vec3 = [0, 1, 0];

function cam(view: ViewName, overrides?: Partial<{ yawDeg: number; pitchDeg: number }>) {
  return createOrthoCamera({
    ...viewToYawPitch(view, overrides),
    center: ORIGIN,
    extent: EXTENT,
    viewport: VIEWPORT,
  });
}

describe('viewToYawPitch', () => {
  it('pins the full table: cardinals -10°, diagonals -20°, top -90°, bottom +90°', () => {
    expect(viewToYawPitch('n')).toEqual({ yawDeg: 0, pitchDeg: -10 });
    expect(viewToYawPitch('ne')).toEqual({ yawDeg: 315, pitchDeg: -20 });
    expect(viewToYawPitch('e')).toEqual({ yawDeg: 270, pitchDeg: -10 });
    expect(viewToYawPitch('se')).toEqual({ yawDeg: 225, pitchDeg: -20 });
    expect(viewToYawPitch('s')).toEqual({ yawDeg: 180, pitchDeg: -10 });
    expect(viewToYawPitch('sw')).toEqual({ yawDeg: 135, pitchDeg: -20 });
    expect(viewToYawPitch('w')).toEqual({ yawDeg: 90, pitchDeg: -10 });
    expect(viewToYawPitch('nw')).toEqual({ yawDeg: 45, pitchDeg: -20 });
    expect(viewToYawPitch('top')).toEqual({ yawDeg: 0, pitchDeg: -90 });
    expect(viewToYawPitch('bottom')).toEqual({ yawDeg: 0, pitchDeg: 90 });
  });

  it('overrides replace individual defaults', () => {
    expect(viewToYawPitch('n', { pitchDeg: 0 })).toEqual({ yawDeg: 0, pitchDeg: 0 });
    expect(viewToYawPitch('e', { yawDeg: 200 })).toEqual({ yawDeg: 200, pitchDeg: -10 });
    expect(viewToYawPitch('top', { yawDeg: 90, pitchDeg: -45 })).toEqual({
      yawDeg: 90,
      pitchDeg: -45,
    });
  });

  it('rejects unknown views naming the alternatives', () => {
    expect(() => viewToYawPitch('north' as ViewName)).toThrow(/unknown view 'north'.*n, ne, e/);
    expect(VIEW_NAMES).toHaveLength(10);
  });
});

describe("view 'n' (camera on -Z looking toward +Z)", () => {
  it('a point north of center projects to the viewport center and is nearer than center', () => {
    const c = cam('n', { pitchDeg: 0 }); // level so the pin is exact
    const p = c.worldToScreen(NORTH);
    expect(p.x).toBeCloseTo(100, 10);
    expect(p.y).toBeCloseTo(50, 10);
    expect(p.z).toBeCloseTo(-1, 10); // toward the camera: smaller depth
    expect(c.worldToScreen(ORIGIN).z).toBeCloseTo(0, 10);
  });

  it('east appears LEFT of center (camera faces +Z, so +X is on its left)', () => {
    const p = cam('n', { pitchDeg: 0 }).worldToScreen(EAST);
    expect(p.x).toBeCloseTo(100 - SCALE, 10);
    expect(p.y).toBeCloseTo(50, 10);
  });

  it('up appears ABOVE center (screen y down)', () => {
    const p = cam('n', { pitchDeg: 0 }).worldToScreen(UP);
    expect(p.x).toBeCloseTo(100, 10);
    expect(p.y).toBeCloseTo(50 - SCALE, 10);
  });

  it('with the default -10° pitch the camera sits slightly above: a north point drops below center', () => {
    const p = cam('n').worldToScreen(NORTH);
    expect(p.x).toBeCloseTo(100, 10);
    // cy = -sin(10°): the near point moves DOWN the screen when looking down at the model.
    expect(p.y).toBeCloseTo(50 + SCALE * Math.sin((10 * Math.PI) / 180), 10);
  });
});

describe("view 'e' (camera on +X looking toward -X)", () => {
  it('a point north of center appears RIGHT of center (pinned)', () => {
    const c = cam('e', { pitchDeg: 0 });
    const p = c.worldToScreen(NORTH);
    expect(p.x).toBeCloseTo(100 + SCALE, 10); // facing west, north is on the right
    expect(p.y).toBeCloseTo(50, 10);
    expect(p.z).toBeCloseTo(0, 10);
  });

  it('a point east of center is nearer than center', () => {
    const c = cam('e', { pitchDeg: 0 });
    const p = c.worldToScreen(EAST);
    expect(p.x).toBeCloseTo(100, 10);
    expect(p.z).toBeCloseTo(-1, 10);
  });
});

describe('top and bottom views', () => {
  it('top: camera above looking down; north lands at screen-BOTTOM, up is nearer', () => {
    const c = cam('top');
    const n = c.worldToScreen(NORTH);
    expect(n.x).toBeCloseTo(100, 6);
    expect(n.y).toBeCloseTo(50 + SCALE, 6); // south at screen-top (tilt continuity from 'n')
    expect(c.worldToScreen(UP).z).toBeCloseTo(-1, 6); // toward the camera
    const e = c.worldToScreen(EAST);
    expect(e.x).toBeCloseTo(100 - SCALE, 6); // east on the left, like view 'n'
  });

  it('bottom: camera below looking up; north lands at screen-TOP, up is farther', () => {
    const c = cam('bottom');
    const n = c.worldToScreen(NORTH);
    expect(n.x).toBeCloseTo(100, 6);
    expect(n.y).toBeCloseTo(50 - SCALE, 6);
    expect(c.worldToScreen(UP).z).toBeCloseTo(1, 6); // away from the camera
  });
});

describe('extent and viewport mapping', () => {
  it('extent maps onto the SMALLER viewport dimension', () => {
    const c = cam('n', { pitchDeg: 0 });
    expect(c.pxPerUnit).toBe(SCALE);
    // extent 4 on a 100px-tall viewport: ±2 world units vertically reach the edges.
    expect(c.worldToScreen([0, 2, 0]).y).toBeCloseTo(0, 10);
    expect(c.worldToScreen([0, -2, 0]).y).toBeCloseTo(100, 10);
    // Horizontally the same world length spans only half of the 200px width.
    expect(c.worldToScreen([-2, 0, 0]).x).toBeCloseTo(150, 10);
  });

  it('center is configurable', () => {
    const c = createOrthoCamera({
      ...viewToYawPitch('n', { pitchDeg: 0 }),
      center: [10, 5, -3],
      extent: EXTENT,
      viewport: VIEWPORT,
    });
    const p = c.worldToScreen([10, 5, -3]);
    expect(p.x).toBeCloseTo(100, 10);
    expect(p.y).toBeCloseTo(50, 10);
    expect(p.z).toBeCloseTo(0, 10);
  });

  it('rejects invalid extent, viewport, and non-finite angles/center', () => {
    const base = { yawDeg: 0, pitchDeg: 0, center: ORIGIN, extent: EXTENT, viewport: VIEWPORT };
    expect(() => createOrthoCamera({ ...base, extent: 0 })).toThrow(/extent must be a positive/);
    expect(() => createOrthoCamera({ ...base, extent: -2 })).toThrow(/extent/);
    expect(() => createOrthoCamera({ ...base, viewport: { w: 0, h: 100 } })).toThrow(/viewport/);
    expect(() => createOrthoCamera({ ...base, yawDeg: NaN })).toThrow(/yawDeg\/pitchDeg/);
    expect(() => createOrthoCamera({ ...base, center: [0, NaN, 0] })).toThrow(/center/);
  });
});

describe('fitOrthoExtent', () => {
  it('returns the AABB center and diagonal length + margin', () => {
    const { center, extent } = fitOrthoExtent([0, 0, 0], [2, 2, 1], 0.1);
    expect(center).toEqual([1, 1, 0.5]);
    expect(extent).toBeCloseTo(3 * 1.1, 12); // diagonal sqrt(4+4+1)=3
  });

  it('fits the box at every named view (conservative for any orientation)', () => {
    const min: Vec3 = [-1, 0, -2];
    const max: Vec3 = [3, 2, 1];
    const corners: Vec3[] = [];
    for (const x of [min[0], max[0]]) {
      for (const y of [min[1], max[1]]) {
        for (const z of [min[2], max[2]]) corners.push([x, y, z]);
      }
    }
    const { center, extent } = fitOrthoExtent(min, max, 0.1);
    for (const view of VIEW_NAMES) {
      const c = createOrthoCamera({
        ...viewToYawPitch(view),
        center,
        extent,
        viewport: { w: 320, h: 320 },
      });
      for (const corner of corners) {
        const p = c.worldToScreen(corner);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(320);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(320);
      }
    }
  });

  it('degenerate bounds fall back to extent 1 so the camera stays constructible', () => {
    const { center, extent } = fitOrthoExtent([5, 5, 5], [5, 5, 5]);
    expect(center).toEqual([5, 5, 5]);
    expect(extent).toBe(1);
    expect(() =>
      createOrthoCamera({ yawDeg: 0, pitchDeg: 0, center, extent, viewport: VIEWPORT }),
    ).not.toThrow();
  });
});
