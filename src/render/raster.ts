/**
 * Software rasterizer core: z-buffered triangles/quads, Bresenham lines, rect fills and
 * tile blits onto plain RGBA byte buffers. Pure computation — no I/O, no platform deps.
 *
 * Conventions (shared with render/camera.ts and render/views.ts):
 *
 * - Screen space: x grows right, y grows DOWN, units are pixels. Vertex coordinates may be
 *   fractional; a pixel (px, py) is covered when its center (px + 0.5, py + 0.5) passes the
 *   fill rule.
 * - Depth: SMALLER z is NEARER the camera. The depth buffer is initialized to +Infinity and
 *   a fragment passes when `z < depth[i]` (strict), so on exact depth ties the EARLIER
 *   fragment wins — deterministically.
 * - Color writes OVERWRITE all four channels; there is no alpha blending. Alpha cutout is
 *   done by the shader returning null, which discards the fragment entirely (neither color
 *   nor depth is written, so farther geometry can still show through later).
 * - Back faces are NOT culled: triangles are accepted in either winding (vanilla shapes
 *   have zero-thickness parts, e.g. ears, that must render from both sides).
 *
 * Fill rule (crack-free, no double paint):
 *
 * Vertex x/y are snapped to a 1/256-pixel grid and edge functions are evaluated in exact
 * integer arithmetic, so the two triangles of a shared edge see bit-identical (negated)
 * edge equations. Boundary pixels are resolved by the top-left rule: after normalizing the
 * winding so the doubled signed area is positive (y down), an edge OWNS pixels lying
 * exactly on it iff it is a "top" edge (exactly horizontal, pointing +x) or a "left" edge
 * (pointing up the screen, i.e. toward smaller y). For the two opposite directions of a
 * shared edge exactly one direction is top-or-left, hence every seam pixel is painted by
 * exactly one of the adjacent triangles and no seam pixel is skipped.
 */

export interface Framebuffer {
  /** Width in pixels. */
  readonly width: number;
  /** Height in pixels. */
  readonly height: number;
  /** Row-major RGBA bytes, length width*height*4. */
  readonly rgba: Uint8ClampedArray;
  /**
   * Row-major depth values, length width*height. +Infinity = nothing drawn yet;
   * smaller = nearer the camera.
   */
  readonly depth: Float32Array;
}

/** [r, g, b, a], each 0–255 (values are clamped/rounded on write). */
export type Rgba = readonly [r: number, g: number, b: number, a: number];

export interface ScreenVertex {
  /** Pixel x; fractional allowed. */
  x: number;
  /** Pixel y, growing DOWN; fractional allowed. */
  y: number;
  /** Depth: SMALLER is NEARER the camera (camera.worldToScreen produces this). */
  z: number;
  /** First interpolated attribute (conventionally texture u). */
  u: number;
  /** Second interpolated attribute (conventionally texture v). */
  v: number;
}

/**
 * Per-fragment shader: receives the barycentric interpolation of the vertices' (u, v)
 * (affine — correct for orthographic projection; no perspective correction is applied).
 * Return the fragment color, or null to discard (alpha cutout): a discarded fragment
 * writes neither color nor depth.
 */
export type FragmentShader = (u: number, v: number) => Rgba | null;

/** Allocates a framebuffer cleared to `clearRgba`, with depth cleared to +Infinity. */
export function createFramebuffer(width: number, height: number, clearRgba: Rgba): Framebuffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(
      `createFramebuffer: width and height must be positive integers, got ${width}x${height}`,
    );
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  const [r, g, b, a] = clearRgba;
  for (let o = 0; o < rgba.length; o += 4) {
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = a;
  }
  const depth = new Float32Array(width * height).fill(Number.POSITIVE_INFINITY);
  return { width, height, rgba, depth };
}

const SUBPIXEL_BITS = 8;
const FP_ONE = 1 << SUBPIXEL_BITS; // 256 fixed-point units per pixel
const FP_HALF = FP_ONE >> 1;
// Coordinates are clamped to ±65536 px so edge-function products stay below 2^51 and are
// exact in doubles — that exactness is what guarantees crack-free shared edges. Vertices
// farther off-screen than that get (harmlessly, consistently) clamped.
const FP_LIMIT = 65536 * FP_ONE;

function snapCoord(v: number): number {
  const s = Math.round(v * FP_ONE);
  if (s < -FP_LIMIT) return -FP_LIMIT;
  if (s > FP_LIMIT) return FP_LIMIT;
  return s;
}

function assertFiniteVertex(name: string, v: ScreenVertex): void {
  if (
    !Number.isFinite(v.x) ||
    !Number.isFinite(v.y) ||
    !Number.isFinite(v.z) ||
    !Number.isFinite(v.u) ||
    !Number.isFinite(v.v)
  ) {
    throw new Error(
      `rasterTriangle: vertex ${name} has a non-finite component ` +
        `(x=${v.x}, y=${v.y}, z=${v.z}, u=${v.u}, v=${v.v}); ` +
        `fix the projection/UV math that produced it`,
    );
  }
}

/**
 * Top-left ownership for the directed edge (px,py)→(qx,qy), winding normalized to
 * positive doubled area with y down: "top" = horizontal pointing +x, "left" = pointing
 * up the screen. Exactly one direction of any edge is an owner.
 */
function isTopLeftEdge(px: number, py: number, qx: number, qy: number): boolean {
  return (py === qy && qx > px) || qy < py;
}

/**
 * Rasterizes one triangle with per-pixel depth test (smaller z wins) and barycentric
 * (affine) u/v interpolation. Either winding is accepted; degenerate (zero-area after
 * 1/256-px snapping) triangles draw nothing. See the module doc for the exact fill rule.
 */
export function rasterTriangle(
  fb: Framebuffer,
  v0: ScreenVertex,
  v1: ScreenVertex,
  v2: ScreenVertex,
  shader: FragmentShader,
): void {
  assertFiniteVertex('v0', v0);
  assertFiniteVertex('v1', v1);
  assertFiniteVertex('v2', v2);

  let a = v0;
  let b = v1;
  let c = v2;
  let ax = snapCoord(a.x);
  let ay = snapCoord(a.y);
  let bx = snapCoord(b.x);
  let by = snapCoord(b.y);
  let cx = snapCoord(c.x);
  let cy = snapCoord(c.y);

  let area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area2 === 0) return;
  if (area2 < 0) {
    // Normalize winding by swapping b and c (back faces are not culled).
    const t = b;
    b = c;
    c = t;
    let ti = bx;
    bx = cx;
    cx = ti;
    ti = by;
    by = cy;
    cy = ti;
    area2 = -area2;
  }

  const minX = Math.min(ax, bx, cx);
  const maxX = Math.max(ax, bx, cx);
  const minY = Math.min(ay, by, cy);
  const maxY = Math.max(ay, by, cy);
  // Smallest/largest pixel whose center (px*256 + 128) can lie inside the bbox.
  const pxMin = Math.max(0, Math.ceil((minX - FP_HALF) / FP_ONE));
  const pxMax = Math.min(fb.width - 1, Math.floor((maxX - FP_HALF) / FP_ONE));
  const pyMin = Math.max(0, Math.ceil((minY - FP_HALF) / FP_ONE));
  const pyMax = Math.min(fb.height - 1, Math.floor((maxY - FP_HALF) / FP_ONE));
  if (pxMin > pxMax || pyMin > pyMax) return;

  // Edge function w_i is the edge OPPOSITE vertex i, so w_i/area2 is the barycentric
  // weight of vertex i. All w values are exact integers (fp² units).
  const sx = pxMin * FP_ONE + FP_HALF;
  const sy = pyMin * FP_ONE + FP_HALF;
  let w0row = (cx - bx) * (sy - by) - (cy - by) * (sx - bx); // edge b→c
  let w1row = (ax - cx) * (sy - cy) - (ay - cy) * (sx - cx); // edge c→a
  let w2row = (bx - ax) * (sy - ay) - (by - ay) * (sx - ax); // edge a→b

  // The -1 bias on non-owning edges turns (w > 0 || (w === 0 && owns)) into (w+bias >= 0).
  const bias0 = isTopLeftEdge(bx, by, cx, cy) ? 0 : -1;
  const bias1 = isTopLeftEdge(cx, cy, ax, ay) ? 0 : -1;
  const bias2 = isTopLeftEdge(ax, ay, bx, by) ? 0 : -1;

  const stepX0 = -(cy - by) * FP_ONE;
  const stepY0 = (cx - bx) * FP_ONE;
  const stepX1 = -(ay - cy) * FP_ONE;
  const stepY1 = (ax - cx) * FP_ONE;
  const stepX2 = -(by - ay) * FP_ONE;
  const stepY2 = (bx - ax) * FP_ONE;

  const invArea = 1 / area2;
  const { width, rgba, depth } = fb;
  const az = a.z, bz = b.z, cz = c.z;
  const au = a.u, bu = b.u, cu = c.u;
  const av = a.v, bv = b.v, cv = c.v;

  for (let py = pyMin; py <= pyMax; py++) {
    let w0 = w0row;
    let w1 = w1row;
    let w2 = w2row;
    for (let px = pxMin; px <= pxMax; px++) {
      if (w0 + bias0 >= 0 && w1 + bias1 >= 0 && w2 + bias2 >= 0) {
        const l0 = w0 * invArea;
        const l1 = w1 * invArea;
        const l2 = w2 * invArea;
        const z = l0 * az + l1 * bz + l2 * cz;
        const idx = py * width + px;
        if (z < depth[idx]!) {
          const col = shader(l0 * au + l1 * bu + l2 * cu, l0 * av + l1 * bv + l2 * cv);
          if (col !== null) {
            depth[idx] = z;
            const o = idx * 4;
            rgba[o] = col[0];
            rgba[o + 1] = col[1];
            rgba[o + 2] = col[2];
            rgba[o + 3] = col[3];
          }
        }
      }
      w0 += stepX0;
      w1 += stepX1;
      w2 += stepX2;
    }
    w0row += stepY0;
    w1row += stepY1;
    w2row += stepY2;
  }
}

/**
 * Rasterizes a quad by splitting it on the CONSISTENT diagonal v0–v2 into triangles
 * (v0, v1, v2) and (v0, v2, v3). With the top-left fill rule the two halves never crack
 * nor double-paint the seam, so the quad paints exactly like its outline suggests.
 */
export function rasterQuad(
  fb: Framebuffer,
  v0: ScreenVertex,
  v1: ScreenVertex,
  v2: ScreenVertex,
  v3: ScreenVertex,
  shader: FragmentShader,
): void {
  rasterTriangle(fb, v0, v1, v2, shader);
  rasterTriangle(fb, v0, v2, v3, shader);
}

// Bounds the Bresenham loop for absurd endpoints; only affects geometry farther than
// ~1M px off-screen (slope error from clamping is < 1px across any visible viewport).
const LINE_COORD_LIMIT = 1 << 20;

function clampLineCoord(v: number): number {
  const r = Math.round(v);
  if (r < -LINE_COORD_LIMIT) return -LINE_COORD_LIMIT;
  if (r > LINE_COORD_LIMIT) return LINE_COORD_LIMIT;
  return r;
}

/**
 * Bresenham line, endpoints inclusive, coordinates rounded to integers, clipped to the
 * framebuffer. When `z` is given the line is depth-TESTED (drawn only where `z` is nearer
 * than existing geometry) and depth-WRITTEN at that constant z; pass a z slightly smaller
 * than the surface's to overlay lines onto coplanar geometry. Without `z` the line is a
 * pure annotation: color only, depth untouched.
 */
export function drawLine(
  fb: Framebuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgba: Rgba,
  z?: number,
): void {
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
    throw new Error(
      `drawLine: endpoints must be finite, got (${x0}, ${y0})→(${x1}, ${y1})`,
    );
  }
  if (z !== undefined && Number.isNaN(z)) {
    throw new Error(`drawLine: z must not be NaN (NaN never passes the depth test)`);
  }
  let ix = clampLineCoord(x0);
  let iy = clampLineCoord(y0);
  const ex = clampLineCoord(x1);
  const ey = clampLineCoord(y1);

  // Early out when the line's bbox misses the framebuffer entirely.
  if (
    Math.max(ix, ex) < 0 ||
    Math.min(ix, ex) >= fb.width ||
    Math.max(iy, ey) < 0 ||
    Math.min(iy, ey) >= fb.height
  ) {
    return;
  }

  const [r, g, b, a] = rgba;
  const dx = Math.abs(ex - ix);
  const sx = ix < ex ? 1 : -1;
  const dy = -Math.abs(ey - iy);
  const sy = iy < ey ? 1 : -1;
  let err = dx + dy;

  for (;;) {
    if (ix >= 0 && ix < fb.width && iy >= 0 && iy < fb.height) {
      const idx = iy * fb.width + ix;
      if (z === undefined || z < fb.depth[idx]!) {
        if (z !== undefined) fb.depth[idx] = z;
        const o = idx * 4;
        fb.rgba[o] = r;
        fb.rgba[o + 1] = g;
        fb.rgba[o + 2] = b;
        fb.rgba[o + 3] = a;
      }
    }
    if (ix === ex && iy === ey) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      ix += sx;
    }
    if (e2 <= dx) {
      err += dx;
      iy += sy;
    }
  }
}

/**
 * Fills the integer pixel rect [x, x+w) × [y, y+h) with `rgba`, clipped to the
 * framebuffer. Color only — the depth buffer is untouched (backgrounds/labels).
 * Inputs are rounded to integers; non-positive sizes are a no-op.
 */
export function fillRect(
  fb: Framebuffer,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: Rgba,
): void {
  const rx = Math.round(x);
  const ry = Math.round(y);
  const x0 = Math.max(0, rx);
  const y0 = Math.max(0, ry);
  const x1 = Math.min(fb.width, rx + Math.round(w));
  const y1 = Math.min(fb.height, ry + Math.round(h));
  if (x0 >= x1 || y0 >= y1) return;
  const [r, g, b, a] = rgba;
  for (let py = y0; py < y1; py++) {
    let o = (py * fb.width + x0) * 4;
    for (let px = x0; px < x1; px++) {
      fb.rgba[o] = r;
      fb.rgba[o + 1] = g;
      fb.rgba[o + 2] = b;
      fb.rgba[o + 3] = a;
      o += 4;
    }
  }
}

/**
 * Copies `src`'s COLOR onto `dst` with src's top-left at (dx, dy), clipped to dst.
 * Pixels are overwritten verbatim (no alpha blending) and dst's depth buffer is left
 * untouched — this is for compositing finished tiles onto a grid canvas.
 */
export function blit(src: Framebuffer, dst: Framebuffer, dx: number, dy: number): void {
  const ox = Math.round(dx);
  const oy = Math.round(dy);
  const sx0 = Math.max(0, -ox);
  const sy0 = Math.max(0, -oy);
  const sx1 = Math.min(src.width, dst.width - ox);
  const sy1 = Math.min(src.height, dst.height - oy);
  if (sx0 >= sx1 || sy0 >= sy1) return;
  const rowBytes = (sx1 - sx0) * 4;
  for (let sy = sy0; sy < sy1; sy++) {
    const from = (sy * src.width + sx0) * 4;
    const to = ((sy + oy) * dst.width + (sx0 + ox)) * 4;
    dst.rgba.set(src.rgba.subarray(from, from + rowBytes), to);
  }
}
