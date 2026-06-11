import { describe, expect, it } from 'vitest';
import {
  blit,
  createFramebuffer,
  drawLine,
  fillRect,
  rasterQuad,
  rasterTriangle,
  type Framebuffer,
  type Rgba,
  type ScreenVertex,
} from '../../src/render/raster.js';

const BG: Rgba = [0, 0, 0, 0];
const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];

const flat =
  (rgba: Rgba) =>
  (_u: number, _v: number): Rgba =>
    rgba;

function vtx(x: number, y: number, z = 0, u = 0, v = 0): ScreenVertex {
  return { x, y, z, u, v };
}

/** Set of pixel indices whose color differs from the clear color. */
function paintedSet(fb: Framebuffer, bg: Rgba = BG): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < fb.width * fb.height; i++) {
    const o = i * 4;
    if (
      fb.rgba[o] !== bg[0] ||
      fb.rgba[o + 1] !== bg[1] ||
      fb.rgba[o + 2] !== bg[2] ||
      fb.rgba[o + 3] !== bg[3]
    ) {
      out.add(i);
    }
  }
  return out;
}

function pixelColor(fb: Framebuffer, x: number, y: number): Rgba {
  const o = (y * fb.width + x) * 4;
  return [fb.rgba[o]!, fb.rgba[o + 1]!, fb.rgba[o + 2]!, fb.rgba[o + 3]!];
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function setsDisjoint(a: Set<number>, b: Set<number>): boolean {
  for (const v of a) if (b.has(v)) return false;
  return true;
}

describe('createFramebuffer', () => {
  it('allocates cleared color and +Infinity depth', () => {
    const fb = createFramebuffer(4, 3, [10, 20, 30, 40]);
    expect(fb.width).toBe(4);
    expect(fb.height).toBe(3);
    expect(fb.rgba.length).toBe(4 * 3 * 4);
    expect(fb.depth.length).toBe(4 * 3);
    expect(pixelColor(fb, 3, 2)).toEqual([10, 20, 30, 40]);
    for (const d of fb.depth) expect(d).toBe(Number.POSITIVE_INFINITY);
  });

  it('rejects non-positive or fractional dimensions', () => {
    expect(() => createFramebuffer(0, 4, BG)).toThrow(/positive integers/);
    expect(() => createFramebuffer(4, -1, BG)).toThrow(/positive integers/);
    expect(() => createFramebuffer(4.5, 4, BG)).toThrow(/positive integers/);
  });
});

describe('rasterTriangle coverage', () => {
  it('right triangle (0,0)-(10,0)-(0,10) covers exactly 45 pixels (centers with i+j<=8)', () => {
    const fb = createFramebuffer(16, 16, BG);
    rasterTriangle(fb, vtx(0, 0), vtx(10, 0), vtx(0, 10), flat(RED));
    const painted = paintedSet(fb);
    expect(painted.size).toBe(45);
    // Brute-force reference: pixel center (i+0.5, j+0.5) is inside iff i+j+1 < 10
    // (hypotenuse excluded: it is neither a top nor a left edge of this triangle).
    for (let j = 0; j < 16; j++) {
      for (let i = 0; i < 16; i++) {
        expect(painted.has(j * 16 + i)).toBe(i + j <= 8);
      }
    }
  });

  it('triangle covering the whole framebuffer paints every pixel', () => {
    const fb = createFramebuffer(8, 8, BG);
    rasterTriangle(fb, vtx(-20, -20), vtx(40, -20), vtx(-20, 40), flat(RED));
    expect(paintedSet(fb).size).toBe(64);
  });

  it('both windings paint the identical pixel set (no back-face culling)', () => {
    const fbA = createFramebuffer(16, 16, BG);
    const fbB = createFramebuffer(16, 16, BG);
    rasterTriangle(fbA, vtx(1, 1), vtx(13, 4), vtx(3, 12), flat(RED));
    rasterTriangle(fbB, vtx(1, 1), vtx(3, 12), vtx(13, 4), flat(RED)); // reversed
    expect(setsEqual(paintedSet(fbA), paintedSet(fbB))).toBe(true);
    expect(paintedSet(fbA).size).toBeGreaterThan(0);
  });

  it('degenerate and sub-pixel triangles paint nothing and do not throw', () => {
    const fb = createFramebuffer(8, 8, BG);
    rasterTriangle(fb, vtx(1, 1), vtx(5, 5), vtx(3, 3), flat(RED)); // collinear
    // Tiny triangle between pixel centers (covers no center).
    rasterTriangle(fb, vtx(2.1, 2.1), vtx(2.4, 2.1), vtx(2.1, 2.4), flat(RED));
    expect(paintedSet(fb).size).toBe(0);
  });

  it('throws naming the vertex when a component is non-finite', () => {
    const fb = createFramebuffer(8, 8, BG);
    expect(() => rasterTriangle(fb, vtx(NaN, 0), vtx(4, 0), vtx(0, 4), flat(RED))).toThrow(
      /vertex v0 .*non-finite/,
    );
  });
});

describe('quad fill rule: no cracks, no double paint', () => {
  it('axis-aligned quad == direct rect fill, and its two triangles partition it', () => {
    // Quad (2,3)-(12,3)-(12,9)-(2,9) must paint exactly like fillRect(2,3,10,6).
    const fbQuad = createFramebuffer(16, 16, BG);
    rasterQuad(fbQuad, vtx(2, 3), vtx(12, 3), vtx(12, 9), vtx(2, 9), flat(RED));
    const fbRect = createFramebuffer(16, 16, BG);
    fillRect(fbRect, 2, 3, 10, 6, RED);
    const quadSet = paintedSet(fbQuad);
    const rectSet = paintedSet(fbRect);
    expect(quadSet.size).toBe(60);
    expect(setsEqual(quadSet, rectSet)).toBe(true);

    // Each diagonal half painted alone: disjoint sets whose union is the rect.
    const fbT1 = createFramebuffer(16, 16, BG);
    const fbT2 = createFramebuffer(16, 16, BG);
    rasterTriangle(fbT1, vtx(2, 3), vtx(12, 3), vtx(12, 9), flat(RED));
    rasterTriangle(fbT2, vtx(2, 3), vtx(12, 9), vtx(2, 9), flat(RED));
    const s1 = paintedSet(fbT1);
    const s2 = paintedSet(fbT2);
    expect(setsDisjoint(s1, s2)).toBe(true);
    expect(s1.size + s2.size).toBe(rectSet.size);
    const union = new Set([...s1, ...s2]);
    expect(setsEqual(union, rectSet)).toBe(true);
  });

  it('quad with pixel centers exactly on its edges follows half-open [top,left) coverage', () => {
    // Edges at x/y = .5 pass exactly through pixel centers: top and left edges own
    // their pixels, bottom and right do not -> pixels (0..3, 0..2), 12 total.
    const fb = createFramebuffer(8, 8, BG);
    rasterQuad(fb, vtx(0.5, 0.5), vtx(4.5, 0.5), vtx(4.5, 3.5), vtx(0.5, 3.5), flat(RED));
    const painted = paintedSet(fb);
    expect(painted.size).toBe(12);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(painted.has(y * 8 + x)).toBe(x <= 3 && y <= 2);
      }
    }
  });

  it('skewed convex quad: both diagonal splits are seam-free and cover the same set', () => {
    const q = [vtx(1, 1), vtx(13, 4), vtx(11, 12), vtx(3, 9)] as const;

    // Split on diagonal v0-v2 (what rasterQuad uses).
    const fbA1 = createFramebuffer(16, 16, BG);
    const fbA2 = createFramebuffer(16, 16, BG);
    rasterTriangle(fbA1, q[0], q[1], q[2], flat(RED));
    rasterTriangle(fbA2, q[0], q[2], q[3], flat(RED));
    const a1 = paintedSet(fbA1);
    const a2 = paintedSet(fbA2);
    expect(setsDisjoint(a1, a2)).toBe(true);
    const unionA = new Set([...a1, ...a2]);

    // Split on the OTHER diagonal v1-v3.
    const fbB1 = createFramebuffer(16, 16, BG);
    const fbB2 = createFramebuffer(16, 16, BG);
    rasterTriangle(fbB1, q[1], q[2], q[3], flat(RED));
    rasterTriangle(fbB2, q[1], q[3], q[0], flat(RED));
    const b1 = paintedSet(fbB1);
    const b2 = paintedSet(fbB2);
    expect(setsDisjoint(b1, b2)).toBe(true);
    const unionB = new Set([...b1, ...b2]);

    // Crack-free + no double paint means both splits cover the quad identically.
    expect(unionA.size).toBeGreaterThan(0);
    expect(setsEqual(unionA, unionB)).toBe(true);

    // rasterQuad itself equals the v0-v2 split.
    const fbQ = createFramebuffer(16, 16, BG);
    rasterQuad(fbQ, q[0], q[1], q[2], q[3], flat(RED));
    expect(setsEqual(paintedSet(fbQ), unionA)).toBe(true);
  });
});

describe('z-buffer', () => {
  const quad = (z: number) =>
    [vtx(2, 2, z), vtx(12, 2, z), vtx(12, 12, z), vtx(2, 12, z)] as const;

  it('near quad occludes far quad regardless of draw order (smaller z is nearer)', () => {
    const farThenNear = createFramebuffer(16, 16, BG);
    rasterQuad(farThenNear, ...quad(5), flat(RED));
    rasterQuad(farThenNear, ...quad(1), flat(GREEN));
    expect(pixelColor(farThenNear, 7, 7)).toEqual(GREEN);

    const nearThenFar = createFramebuffer(16, 16, BG);
    rasterQuad(nearThenFar, ...quad(1), flat(GREEN));
    rasterQuad(nearThenFar, ...quad(5), flat(RED));
    expect(pixelColor(nearThenFar, 7, 7)).toEqual(GREEN);
  });

  it('on exact depth ties the earlier fragment wins (strict less-than test)', () => {
    const fb = createFramebuffer(16, 16, BG);
    rasterQuad(fb, ...quad(3), flat(RED));
    rasterQuad(fb, ...quad(3), flat(GREEN));
    expect(pixelColor(fb, 7, 7)).toEqual(RED);
  });

  it('interpolates z across a triangle: a tilted face wins only where it is nearer', () => {
    const fb = createFramebuffer(16, 16, BG);
    rasterQuad(fb, ...quad(5), flat(RED));
    // Tilted quad: z ramps 0 -> 10 left to right; crossover at z=5 (x=8 in world terms).
    rasterQuad(fb, vtx(0, 0, 0), vtx(16, 0, 10), vtx(16, 16, 10), vtx(0, 16, 0), flat(BLUE));
    expect(pixelColor(fb, 3, 7)).toEqual(BLUE); // z = 3.5/16*10 ≈ 2.19 < 5
    expect(pixelColor(fb, 10, 7)).toEqual(RED); // z = 10.5/16*10 ≈ 6.56 > 5
  });
});

describe('shader: interpolation and cutout', () => {
  it('interpolates u,v barycentrically (pinned bytes at a known pixel)', () => {
    const fb = createFramebuffer(16, 16, BG);
    // u = x/16, v = y/16 across this right triangle.
    rasterTriangle(
      fb,
      vtx(0, 0, 0, 0, 0),
      vtx(16, 0, 0, 1, 0),
      vtx(0, 16, 0, 0, 1),
      (u, v) => [u * 255, v * 255, 0, 255],
    );
    // Pixel (7,0): center (7.5, 0.5) -> u = 7.5/16 = 0.46875 -> 119.53 -> 120;
    // v = 0.5/16 = 0.03125 -> 7.97 -> 8.
    expect(pixelColor(fb, 7, 0)).toEqual([120, 8, 0, 255]);
  });

  it('null return discards: color and depth untouched, so later farther geometry shows', () => {
    const fb = createFramebuffer(16, 16, BG);
    // Near quad (z=1) discards its left half (u < 0.5).
    rasterQuad(
      fb,
      vtx(0, 0, 1, 0, 0),
      vtx(16, 0, 1, 1, 0),
      vtx(16, 16, 1, 1, 1),
      vtx(0, 16, 1, 0, 1),
      (u) => (u < 0.5 ? null : GREEN),
    );
    expect(pixelColor(fb, 2, 8)).toEqual(BG); // discarded
    expect(pixelColor(fb, 13, 8)).toEqual(GREEN);
    expect(fb.depth[8 * 16 + 2]).toBe(Number.POSITIVE_INFINITY);

    // A farther quad drawn afterwards fills the discarded region but not the kept one.
    rasterQuad(fb, vtx(0, 0, 9), vtx(16, 0, 9), vtx(16, 16, 9), vtx(0, 16, 9), flat(RED));
    expect(pixelColor(fb, 2, 8)).toEqual(RED);
    expect(pixelColor(fb, 13, 8)).toEqual(GREEN);
  });
});

describe('drawLine', () => {
  it('paints endpoints inclusive; diagonal covers max(dx,dy)+1 pixels', () => {
    const fb = createFramebuffer(16, 16, BG);
    drawLine(fb, 2, 3, 9, 3, RED);
    expect(paintedSet(fb).size).toBe(8);
    expect(pixelColor(fb, 2, 3)).toEqual(RED);
    expect(pixelColor(fb, 9, 3)).toEqual(RED);

    const fb2 = createFramebuffer(16, 16, BG);
    drawLine(fb2, 0, 0, 7, 7, RED);
    expect(paintedSet(fb2).size).toBe(8);
    expect(pixelColor(fb2, 0, 0)).toEqual(RED);
    expect(pixelColor(fb2, 7, 7)).toEqual(RED);
  });

  it('clips off-screen segments without throwing', () => {
    const fb = createFramebuffer(8, 8, BG);
    drawLine(fb, -5, -5, 20, 20, RED);
    const painted = paintedSet(fb);
    expect(painted.size).toBe(8); // the on-screen diagonal 0..7
    for (let i = 0; i < 8; i++) expect(painted.has(i * 8 + i)).toBe(true);

    const fbMiss = createFramebuffer(8, 8, BG);
    drawLine(fbMiss, -10, -2, -10, 30, RED); // entirely left of the canvas
    expect(paintedSet(fbMiss).size).toBe(0);
  });

  it('without z ignores depth; with z it is depth-tested and depth-written', () => {
    const quadZ1 = [vtx(0, 0, 1), vtx(16, 0, 1), vtx(16, 16, 1), vtx(0, 16, 1)] as const;

    const fbNoZ = createFramebuffer(16, 16, BG);
    rasterQuad(fbNoZ, ...quadZ1, flat(RED));
    drawLine(fbNoZ, 0, 8, 15, 8, GREEN); // annotation: paints over near geometry
    expect(pixelColor(fbNoZ, 7, 8)).toEqual(GREEN);
    expect(fbNoZ.depth[8 * 16 + 7]).toBe(1); // depth untouched

    const fbBehind = createFramebuffer(16, 16, BG);
    rasterQuad(fbBehind, ...quadZ1, flat(RED));
    drawLine(fbBehind, 0, 8, 15, 8, GREEN, 2); // farther than the quad: hidden
    expect(pixelColor(fbBehind, 7, 8)).toEqual(RED);

    const fbFront = createFramebuffer(16, 16, BG);
    rasterQuad(fbFront, ...quadZ1, flat(RED));
    drawLine(fbFront, 0, 8, 15, 8, GREEN, 0.5); // nearer: visible, depth written
    expect(pixelColor(fbFront, 7, 8)).toEqual(GREEN);
    expect(fbFront.depth[8 * 16 + 7]).toBe(0.5);
  });

  it('rejects non-finite endpoints', () => {
    const fb = createFramebuffer(8, 8, BG);
    expect(() => drawLine(fb, 0, 0, Infinity, 4, RED)).toThrow(/finite/);
  });
});

describe('fillRect', () => {
  it('fills and clips, color only', () => {
    const fb = createFramebuffer(8, 8, BG);
    fillRect(fb, -2, -2, 4, 4, RED); // only the 2x2 overlap survives
    const painted = paintedSet(fb);
    expect(painted.size).toBe(4);
    expect(pixelColor(fb, 0, 0)).toEqual(RED);
    expect(pixelColor(fb, 1, 1)).toEqual(RED);
    expect(pixelColor(fb, 2, 2)).toEqual(BG);
    for (const d of fb.depth) expect(d).toBe(Number.POSITIVE_INFINITY);
  });

  it('non-positive sizes are a no-op', () => {
    const fb = createFramebuffer(8, 8, BG);
    fillRect(fb, 2, 2, 0, 5, RED);
    fillRect(fb, 2, 2, -3, 5, RED);
    expect(paintedSet(fb).size).toBe(0);
  });
});

describe('blit', () => {
  it('composites a tile at an offset, color only', () => {
    const tile = createFramebuffer(3, 2, RED);
    const canvas = createFramebuffer(8, 8, BG);
    canvas.depth.fill(7);
    blit(tile, canvas, 2, 1);
    expect(pixelColor(canvas, 2, 1)).toEqual(RED);
    expect(pixelColor(canvas, 4, 2)).toEqual(RED);
    expect(pixelColor(canvas, 1, 1)).toEqual(BG);
    expect(pixelColor(canvas, 5, 1)).toEqual(BG);
    expect(paintedSet(canvas).size).toBe(6);
    for (const d of canvas.depth) expect(d).toBe(7); // depth untouched
  });

  it('clips at all four canvas edges', () => {
    const tile = createFramebuffer(4, 4, RED);
    const canvas = createFramebuffer(8, 8, BG);
    blit(tile, canvas, -2, -2); // top-left: 2x2 visible
    blit(tile, canvas, 6, 6); // bottom-right: 2x2 visible
    expect(paintedSet(canvas).size).toBe(8);
    expect(pixelColor(canvas, 0, 0)).toEqual(RED);
    expect(pixelColor(canvas, 7, 7)).toEqual(RED);
    expect(pixelColor(canvas, 2, 2)).toEqual(BG);

    const off = createFramebuffer(8, 8, BG);
    blit(tile, off, 20, 20); // fully outside: no-op
    expect(paintedSet(off).size).toBe(0);
  });
});

describe('determinism', () => {
  it('two identical render sequences produce byte-equal color and depth', () => {
    const renderScene = (): Framebuffer => {
      const fb = createFramebuffer(64, 64, [12, 34, 56, 255]);
      const checker = (u: number, v: number): Rgba | null => {
        if ((Math.floor(u * 8) + Math.floor(v * 8)) % 2 === 0) return [200, 150, 50, 255];
        return u > 0.9 ? null : [40, 90, 160, 255];
      };
      rasterQuad(
        fb,
        vtx(5, 5, 2, 0, 0),
        vtx(58, 9, 3, 1, 0),
        vtx(55, 60, 4, 1, 1),
        vtx(2, 50, 2.5, 0, 1),
        checker,
      );
      rasterTriangle(fb, vtx(30, 2, 1, 0, 0), vtx(62, 40, 1, 1, 0), vtx(10, 62, 1.5, 0, 1), (u, v) => [
        u * 255,
        v * 255,
        128,
        255,
      ]);
      drawLine(fb, 0, 32, 63, 30, [255, 255, 255, 255], 1.2);
      drawLine(fb, 10, 0, 10, 63, [0, 0, 0, 255]);
      fillRect(fb, 50, 50, 10, 10, [9, 9, 9, 255]);
      return fb;
    };

    const a = renderScene();
    const b = renderScene();
    expect(Buffer.from(a.rgba.buffer, a.rgba.byteOffset, a.rgba.byteLength).equals(
      Buffer.from(b.rgba.buffer, b.rgba.byteOffset, b.rgba.byteLength),
    )).toBe(true);
    expect(Buffer.from(a.depth.buffer, a.depth.byteOffset, a.depth.byteLength).equals(
      Buffer.from(b.depth.buffer, b.depth.byteOffset, b.depth.byteLength),
    )).toBe(true);
  });
});
