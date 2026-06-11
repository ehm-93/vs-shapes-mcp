/**
 * Composed view grids and animation filmstrips → PNG (ARCHITECTURE.md §render). This is
 * the agent's eyes: every tile shares one camera extent (model AABB unioned across all
 * rendered frames + 10%) so tiles are visually comparable, and carries a ground grid,
 * north marker, labels and a scale bar so orientation and size are always discoverable.
 *
 * Scene content per tile (rendered by a pluggable backend, render/backend.ts):
 * - ground grid at y = 0, 1-block spacing, subtle color, depth-tested and biased slightly
 *   AWAY from the camera so model faces lying exactly on the ground win the depth tie on
 *   both backends;
 * - a small "N" marker drawn with ground-plane line segments just beyond the grid's north
 *   (−Z) edge, oriented to read correctly in the top view;
 * - the model's posed faces (vs/fk.posedFaces) as textured triangles, alpha-cutout, NO
 *   backface culling, flat shade from the engine's CubeMeshUtil.DefaultBlockSideShadings
 *   (docs/ground-truth/tesselator.md §6b: north/south 0.6, east/west 0.75, up 1.0,
 *   down 0.45 — exact constants) interpolated over each face's WORLD-SPACE normal
 *   GetFaceBrightness-style (API:8920-8938), so rotated/posed elements and shade:false
 *   faces brighten like in-game, with `glow` as a brightness floor (glow/255, §6c);
 * - an optional hitbox wireframe ({x, y} in blocks, square footprint, standing on y = 0,
 *   centered on the entity ground anchor (0.5, 0, 0.5) — tesselator.md §8; this is where
 *   the game puts an entity's collision box relative to its shape) biased slightly toward
 *   the camera.
 *
 * Labels (view name + frame), the scale bar, and the missing-texture footnote are
 * composited CPU-side via font.ts AFTER the backend pass, so backend choice never
 * affects them. PNG encoding goes through pngjs (no timestamp/ancillary chunks — encodes
 * are byte-stable for identical input; pinned by tests).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { initCorpus, type Corpus } from '../corpus/corpus.js';
import { modelBounds, posedFaces, rootOf, type PoseOpts, type ShapeDocLike } from '../vs/fk.js';
import type { AnimationJson, FaceName, RenderFace, Vec3 } from '../vs/types.js';
import {
  selectBackend,
  type BackendPreference,
  type Rgba,
  type SceneJob,
  type SceneLine,
  type SceneTri,
  type ScreenVertex,
} from './backend.js';
import {
  createOrthoCamera,
  fitOrthoExtent,
  viewToYawPitch,
  type OrthoCamera,
  type ViewName,
} from './camera.js';
import { drawText, textWidth } from './font.js';
import { blit, fillRect, type Framebuffer } from './raster.js';
import { createTextureSet, type TextureResolver, type TextureSet } from './textures.js';

export type { ViewName } from './camera.js';

// --- palette ---------------------------------------------------------------------------
const BG: Rgba = [33, 36, 41, 255];
const GRID_RGBA: Rgba = [58, 64, 71, 255];
const N_MARKER_RGBA: Rgba = [235, 137, 65, 255];
/** Exported so tests can count hitbox-overlay pixels. */
export const HITBOX_RGBA: Rgba = [96, 220, 144, 255];
const LABEL_RGBA: Rgba = [235, 235, 235, 255];
const MISSING_RGBA: Rgba = [255, 120, 120, 255];
const TILE_BORDER_RGBA: Rgba = [62, 66, 73, 255];

/**
 * Engine flat per-face brightness — CubeMeshUtil.DefaultBlockSideShadings mapped per
 * facing (tesselator.md §6b, API:52317/52322), interpolated over the world-space normal
 * via {@link faceBrightness} (the engine re-derives brightness from rotated normals).
 */
const FACE_SHADE: Readonly<Record<FaceName, number>> = {
  north: 0.6,
  east: 0.75,
  south: 0.6,
  west: 0.75,
  up: 1,
  down: 0.45,
};

/** The six axis facings with their unit normals, in engine index order (API:8600-8630). */
const AXIS_FACINGS: readonly [FaceName, Vec3][] = [
  ['north', [0, 0, -1]],
  ['east', [1, 0, 0]],
  ['south', [0, 0, 1]],
  ['west', [-1, 0, 0]],
  ['up', [0, 1, 0]],
  ['down', [0, -1, 0]],
];

const HALF_PI = Math.PI / 2;

/**
 * Port of BlockFacing.GetFaceBrightness (API:8920-8938) over a world-space unit normal:
 * sum of (1 − angle/(π/2)) · FACE_SHADE[facing] for every axis facing within 90° of the
 * normal. Axis-aligned normals reproduce the §6b table exactly; rotated faces interpolate
 * by angular proximity, matching the engine's brightness for rotated/posed elements.
 * Exported for tests.
 */
export function faceBrightness(normal: Vec3): number {
  let b = 0;
  for (const [facing, n] of AXIS_FACINGS) {
    const dot = Math.min(1, Math.max(-1, normal[0] * n[0] + normal[1] * n[1] + normal[2] * n[2]));
    const angle = Math.acos(dot);
    if (angle < HALF_PI) b += (1 - angle / HALF_PI) * FACE_SHADE[facing];
  }
  return b;
}

const DEFAULT_VIEWS: readonly ViewName[] = ['n', 'e', 'sw', 'top'];

export interface RenderResult {
  /** Composited PNG. */
  png: Buffer;
  /** Texture keys that fell back to flat colors (also named in the caption). */
  missingTextures: string[];
  /** One-line human/agent summary of what was rendered. */
  caption: string;
}

export interface RenderViewsOpts {
  /** Compass side of the model the camera looks AT (north = −Z). Default n,e,sw,top. */
  views?: ViewName[];
  anim?: string;
  frame?: number;
  /** Pixels per square view tile, default 320. */
  size?: number;
  /** Wireframe entity hitbox, blocks: x = square footprint side, y = height. */
  overlayHitbox?: { x: number; y: number };
  /** Extra root dir for texture PNG resolution (mod assets); game assets always fall back. */
  texturesRoot?: string;
  renderer?: BackendPreference;
}

export interface RenderFilmstripOpts {
  anim: string;
  /** Tile count, evenly spaced over [0, quantityframes) including fractional. Default 8. */
  frames?: number;
  view?: ViewName;
  /** Pixels per square tile, default 240. */
  size?: number;
  texturesRoot?: string;
  renderer?: BackendPreference;
}

// --- texture resolution ----------------------------------------------------------------

/** undefined = not probed yet; null = no game install (resolve every path to null). */
let cachedCorpus: Corpus | null | undefined;

function gameAssetResolver(): TextureResolver {
  return (texturePath) => {
    if (cachedCorpus === undefined) {
      try {
        cachedCorpus = initCorpus();
      } catch {
        cachedCorpus = null; // no install — every lookup falls back to flat colors
      }
    }
    return cachedCorpus === null ? null : cachedCorpus.resolveTexturePng(texturePath);
  };
}

function buildResolvers(texturesRoot: string | undefined): TextureResolver[] {
  const resolvers: TextureResolver[] = [];
  if (texturesRoot !== undefined && texturesRoot !== '') {
    resolvers.push((texturePath) => {
      const rel = texturePath
        .trim()
        .replaceAll('\\', '/')
        .replace(/^[a-z0-9_-]+:/i, '')
        .replace(/^\/+/, '')
        .replace(/^textures\//i, '')
        .replace(/\.png$/i, '');
      if (rel === '') return null;
      const parts = rel.split('/');
      for (const candidate of [
        join(texturesRoot, 'textures', ...parts) + '.png',
        join(texturesRoot, ...parts) + '.png',
      ]) {
        if (existsSync(candidate)) return candidate;
      }
      return null;
    });
  }
  resolvers.push(gameAssetResolver());
  return resolvers;
}

// --- scene building --------------------------------------------------------------------

function screenVertex(camera: OrthoCamera, p: Vec3, u = 0, v = 0, zOffset = 0): ScreenVertex {
  const s = camera.worldToScreen(p);
  return { x: s.x, y: s.y, z: s.z + zOffset, u, v };
}

/** UV corner cycle [(u2,v2),(u2,v1),(u1,v1),(u1,v2)]; vertex j gets index (rot/90 + j) % 4. */
function faceUvCorners(face: RenderFace): [number, number][] {
  const [u1, v1, u2, v2] = face.uvRect;
  const cycle: [number, number][] = [
    [u2, v2],
    [u2, v1],
    [u1, v1],
    [u1, v2],
  ];
  const r = face.uvRotation / 90;
  return [0, 1, 2, 3].map((j) => cycle[(r + j) % 4]!);
}

function buildModelTris(
  faces: readonly RenderFace[],
  camera: OrthoCamera,
  texSet: TextureSet,
): SceneTri[] {
  const tris: SceneTri[] = [];
  for (const face of faces) {
    const texId = texSet.idFor(face.textureKey);
    const uvs = faceUvCorners(face);
    const verts = face.positions.map((p, j) => {
      const [cu, cv] = uvs[j]!;
      const [nu, nv] = texSet.normalizeUv(face.textureKey, cu, cv);
      return screenVertex(camera, p, nu, nv);
    }) as [ScreenVertex, ScreenVertex, ScreenVertex, ScreenVertex];
    // Glow is a brightness floor (glow/255); at glow ≈ 255 directional shading vanishes.
    const shade = Math.min(1, Math.max(faceBrightness(face.normal), (face.glow ?? 0) / 255));
    tris.push({ v: [verts[0], verts[1], verts[2]], texId, shade });
    tris.push({ v: [verts[0], verts[2], verts[3]], texId, shade });
  }
  return tris;
}

/** Integer block range covering the model footprint plus the anchor block, max 24 blocks. */
function gridRange(lo: number, hi: number): [number, number] {
  let a = Math.floor(Math.min(lo, 0)) - 1;
  let b = Math.ceil(Math.max(hi, 1)) + 1;
  if (b - a > 24) {
    const mid = (lo + hi) / 2;
    a = Math.round(mid - 12);
    b = a + 24;
  }
  return [a, b];
}

interface SceneExtras {
  bounds: { min: Vec3; max: Vec3 };
  center: Vec3;
  extent: number;
  hitbox?: { x: number; y: number } | undefined;
}

function buildGroundAndOverlays(camera: OrthoCamera, extras: SceneExtras): SceneLine[] {
  const lines: SceneLine[] = [];
  const zBias = extras.extent * 1e-3;
  const [x0, x1] = gridRange(extras.bounds.min[0], extras.bounds.max[0]);
  const [z0, z1] = gridRange(extras.bounds.min[2], extras.bounds.max[2]);

  // Grid biased away from the camera: model faces at y=0 win the tie on both backends.
  const grid = (a: Vec3, b: Vec3): SceneLine => ({
    a: screenVertex(camera, a, 0, 0, zBias),
    b: screenVertex(camera, b, 0, 0, zBias),
    rgba: GRID_RGBA,
    depthTest: true,
  });
  for (let gx = x0; gx <= x1; gx++) lines.push(grid([gx, 0, z0], [gx, 0, z1]));
  for (let gz = z0; gz <= z1; gz++) lines.push(grid([x0, 0, gz], [x1, 0, gz]));

  // "N" glyph on the ground toward −Z, anchored just inside the camera fit (the visible
  // half-span is extent/2 around `center`) so it stays in frame even in the top view.
  // Reads correctly there (screen-up = +Z, screen-right = −X): letter-up = +Z,
  // letter-right = −X.
  const h = Math.min(0.5, extras.extent * 0.12);
  const w = h * 0.72;
  const cx = extras.center[0];
  const zBase = extras.center[2] - extras.extent * 0.45; // letter spans z ∈ [zBase, zBase + h]
  const nPoint = (sx: number, sy: number): Vec3 => [cx - sx, 0, zBase + sy];
  const marker = (p: Vec3, q: Vec3): SceneLine => ({
    a: screenVertex(camera, p),
    b: screenVertex(camera, q),
    rgba: N_MARKER_RGBA,
    depthTest: true,
  });
  lines.push(marker(nPoint(-w / 2, 0), nPoint(-w / 2, h))); // left stroke
  lines.push(marker(nPoint(-w / 2, h), nPoint(w / 2, 0))); // diagonal
  lines.push(marker(nPoint(w / 2, 0), nPoint(w / 2, h))); // right stroke

  if (extras.hitbox) {
    const hx = extras.hitbox.x / 2;
    const hy = extras.hitbox.y;
    // Entity anchor: model point (0.5, 0, 0.5) in blocks (tesselator.md §8).
    const ax = 0.5;
    const az = 0.5;
    const corners: [number, number][] = [
      [ax - hx, az - hx],
      [ax + hx, az - hx],
      [ax + hx, az + hx],
      [ax - hx, az + hx],
    ];
    const edge = (p: Vec3, q: Vec3): SceneLine => ({
      // Biased toward the camera so the wireframe stays visible on coplanar model faces.
      a: screenVertex(camera, p, 0, 0, -2 * zBias),
      b: screenVertex(camera, q, 0, 0, -2 * zBias),
      rgba: HITBOX_RGBA,
      depthTest: true,
    });
    for (let i = 0; i < 4; i++) {
      const [cxa, cza] = corners[i]!;
      const [cxb, czb] = corners[(i + 1) % 4]!;
      lines.push(edge([cxa, 0, cza], [cxb, 0, czb])); // bottom rim
      lines.push(edge([cxa, hy, cza], [cxb, hy, czb])); // top rim
      lines.push(edge([cxa, 0, cza], [cxa, hy, cza])); // vertical
    }
  }
  return lines;
}

// --- CPU composition -------------------------------------------------------------------

/** Wraps a backend's raw RGBA output for the CPU-side raster/font helpers (color-only). */
function asFramebuffer(width: number, height: number, rgba: Uint8ClampedArray): Framebuffer {
  return { width, height, rgba, depth: new Float32Array(0) };
}

function overlayTileChrome(
  fb: Framebuffer,
  label: string,
  pxPerUnit: number,
  size: number,
): void {
  const scale = size >= 160 ? 2 : 1;
  drawText(fb, 4, 4, label, LABEL_RGBA, scale);
  // Scale bar: 1 block long, bottom-left.
  const barW = Math.max(2, Math.min(Math.round(pxPerUnit), size - 8));
  const barY = size - 8;
  fillRect(fb, 4, barY, barW, 2, LABEL_RGBA);
  fillRect(fb, 4, barY - 3, 1, 3, LABEL_RGBA);
  fillRect(fb, 4 + barW - 1, barY - 3, 1, 3, LABEL_RGBA);
  drawText(fb, 4, barY - 13, '1 block', LABEL_RGBA, 1);
}

function drawTileBorder(fb: Framebuffer): void {
  fillRect(fb, 0, 0, fb.width, 1, TILE_BORDER_RGBA);
  fillRect(fb, 0, fb.height - 1, fb.width, 1, TILE_BORDER_RGBA);
  fillRect(fb, 0, 0, 1, fb.height, TILE_BORDER_RGBA);
  fillRect(fb, fb.width - 1, 0, 1, fb.height, TILE_BORDER_RGBA);
}

function encodePng(fb: Framebuffer): Buffer {
  const png = new PNG({ width: fb.width, height: fb.height });
  png.data.set(fb.rgba);
  // pngjs writes no tIME/ancillary chunks; identical input ⇒ identical bytes (test-pinned).
  return PNG.sync.write(png);
}

/** Compact frame label: f0, f7.5, f12.34 (≤2 decimals, trailing zeros trimmed). */
function fmtFrame(frame: number): string {
  return String(Number(frame.toFixed(2)));
}

function validateSize(size: number, what: string): void {
  if (!Number.isInteger(size) || size < 32 || size > 2048) {
    throw new Error(`${what}: size must be an integer between 32 and 2048 px, got ${size}`);
  }
}

// --- public API ------------------------------------------------------------------------

/**
 * Renders a labeled grid of orthographic views (2-column grid for ≥4 views, one row for
 * fewer) sharing a single camera extent. See the module doc for tile contents.
 */
export async function renderViews(
  doc: ShapeDocLike,
  opts: RenderViewsOpts = {},
): Promise<RenderResult> {
  const root = rootOf(doc);
  const views = opts.views ?? [...DEFAULT_VIEWS];
  if (views.length === 0) {
    throw new Error(`renderViews: opts.views is empty; pass at least one view (e.g. ['n']).`);
  }
  const size = opts.size ?? 320;
  validateSize(size, 'renderViews');
  if (opts.overlayHitbox) {
    const { x, y } = opts.overlayHitbox;
    if (!(x > 0) || !(y > 0) || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(
        `renderViews: overlayHitbox must have positive finite x and y (blocks), got x=${x}, y=${y}`,
      );
    }
  }

  const poseOpts: PoseOpts = {};
  if (opts.anim !== undefined) poseOpts.anim = opts.anim;
  if (opts.frame !== undefined) poseOpts.frame = opts.frame;

  const faces = posedFaces(root, poseOpts); // also surfaces frame-without-anim errors
  const bounds = modelBounds(
    root,
    opts.anim === undefined ? {} : { anim: opts.anim, frames: [opts.frame ?? 0] },
  );
  const { center, extent } = fitOrthoExtent(bounds.min, bounds.max, 0.1);
  const texSet = createTextureSet(root, buildResolvers(opts.texturesRoot));
  const backend = await selectBackend(opts.renderer ?? 'auto');

  const tiles: Framebuffer[] = [];
  for (const view of views) {
    const camera = createOrthoCamera({
      ...viewToYawPitch(view),
      center,
      extent,
      viewport: { w: size, h: size },
    });
    const job: SceneJob = {
      width: size,
      height: size,
      clear: BG,
      textures: texSet.textures,
      tris: buildModelTris(faces, camera, texSet),
      lines: buildGroundAndOverlays(camera, { bounds, center, extent, hitbox: opts.overlayHitbox }),
    };
    const raw = await backend.renderScene(job);
    const fb = asFramebuffer(size, size, raw);
    const tileLabel =
      opts.anim !== undefined ? `${view} f${fmtFrame(opts.frame ?? 0)}` : view;
    overlayTileChrome(fb, tileLabel, camera.pxPerUnit, size);
    drawTileBorder(fb);
    tiles.push(fb);
  }

  const cols = views.length < 4 ? views.length : Math.ceil(Math.sqrt(views.length));
  const rows = Math.ceil(views.length / cols);
  const canvas = (() => {
    const fb = asFramebuffer(
      cols * size,
      rows * size,
      new Uint8ClampedArray(cols * size * rows * size * 4),
    );
    fillRect(fb, 0, 0, fb.width, fb.height, BG);
    return fb;
  })();
  tiles.forEach((tile, i) => blit(tile, canvas, (i % cols) * size, Math.floor(i / cols) * size));

  const missing = [...texSet.missing];
  if (missing.length > 0) {
    const note = `missing tex: ${missing.join(', ')}`;
    drawText(canvas, Math.max(4, canvas.width - textWidth(note) - 4), 4, note, MISSING_RGBA, 1);
  }

  const caption =
    `views ${views.join(',')} | ` +
    (opts.anim !== undefined
      ? `anim '${opts.anim}' frame ${fmtFrame(opts.frame ?? 0)}`
      : 'static pose') +
    ` | extent ${extent.toFixed(2)} blocks across ${size}px tiles | grid 1 block, N marker at -Z` +
    (opts.overlayHitbox ? ` | hitbox ${opts.overlayHitbox.x}x${opts.overlayHitbox.y} blocks` : '') +
    ` | backend ${backend.name}` +
    (missing.length > 0 ? ` | missing textures: ${missing.join(', ')}` : '');

  return { png: encodePng(canvas), missingTextures: missing, caption };
}

/**
 * Renders one row of `frames` tiles sampling the animation evenly over
 * [0, quantityframes) — fractional frames included — with frame numbers burned in, a
 * ground line at y = 0, and a camera extent shared across ALL rendered frames.
 */
export async function renderFilmstrip(
  doc: ShapeDocLike,
  opts: RenderFilmstripOpts,
): Promise<RenderResult> {
  const root = rootOf(doc);
  const anims = root.animations ?? [];
  const anim: AnimationJson | undefined = anims.find((a) => (a.code ?? a.name) === opts.anim);
  if (anim === undefined) {
    const codes = anims.map((a) => a.code ?? a.name);
    throw new Error(
      `renderFilmstrip: animation '${opts.anim}' not found; ` +
        (codes.length > 0
          ? `available animation codes: ${codes.join(', ')}.`
          : `the shape has no animations.`),
    );
  }
  const quantityFrames = anim.quantityframes.value;
  const count = opts.frames ?? 8;
  if (!Number.isInteger(count) || count < 1 || count > 64) {
    throw new Error(
      `renderFilmstrip: frames must be an integer between 1 and 64, got ${count} ` +
        `(each frame becomes one tile).`,
    );
  }
  const size = opts.size ?? 240;
  validateSize(size, 'renderFilmstrip');
  const view = opts.view ?? 'e';
  const frames = Array.from({ length: count }, (_, i) => (i * quantityFrames) / count);

  const bounds = modelBounds(root, { anim: opts.anim, frames });
  const { center, extent } = fitOrthoExtent(bounds.min, bounds.max, 0.1);
  const texSet = createTextureSet(root, buildResolvers(opts.texturesRoot));
  const backend = await selectBackend(opts.renderer ?? 'auto');

  const { yawDeg, pitchDeg } = viewToYawPitch(view);
  const camera = createOrthoCamera({
    yawDeg,
    pitchDeg,
    center,
    extent,
    viewport: { w: size, h: size },
  });
  // Ground line: along the camera's horizontal screen axis through the model center.
  const yawRad = (yawDeg * Math.PI) / 180;
  const right: Vec3 = [-Math.cos(yawRad), 0, Math.sin(yawRad)];
  const zBias = extent * 1e-3;
  const groundLine: SceneLine = {
    a: screenVertex(
      camera,
      [center[0] - right[0] * extent, 0, center[2] - right[2] * extent],
      0,
      0,
      zBias,
    ),
    b: screenVertex(
      camera,
      [center[0] + right[0] * extent, 0, center[2] + right[2] * extent],
      0,
      0,
      zBias,
    ),
    rgba: GRID_RGBA,
    depthTest: true,
  };

  const canvas = (() => {
    const fb = asFramebuffer(count * size, size, new Uint8ClampedArray(count * size * size * 4));
    fillRect(fb, 0, 0, fb.width, fb.height, BG);
    return fb;
  })();

  for (let i = 0; i < count; i++) {
    const frame = frames[i]!;
    const faces = posedFaces(root, { anim: opts.anim, frame });
    const job: SceneJob = {
      width: size,
      height: size,
      clear: BG,
      textures: texSet.textures,
      tris: buildModelTris(faces, camera, texSet),
      lines: [groundLine],
    };
    const raw = await backend.renderScene(job);
    const fb = asFramebuffer(size, size, raw);
    drawText(fb, 4, 4, `f${fmtFrame(frame)}`, LABEL_RGBA, size >= 160 ? 2 : 1);
    drawTileBorder(fb);
    blit(fb, canvas, i * size, 0);
  }

  const missing = [...texSet.missing];
  if (missing.length > 0) {
    const note = `missing tex: ${missing.join(', ')}`;
    drawText(
      canvas,
      Math.max(4, canvas.width - textWidth(note) - 4),
      canvas.height - 12,
      note,
      MISSING_RGBA,
      1,
    );
  }

  const caption =
    `filmstrip anim '${opts.anim}' view ${view} | ${count} tiles at frames ` +
    `${frames.map(fmtFrame).join(', ')} of ${quantityFrames} | ` +
    `extent ${extent.toFixed(2)} blocks across ${size}px tiles | backend ${backend.name}` +
    (missing.length > 0 ? ` | missing textures: ${missing.join(', ')}` : '');

  return { png: encodePng(canvas), missingTextures: missing, caption };
}
