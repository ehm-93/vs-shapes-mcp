/**
 * Texture loading + the ONE shared shape-UV → texture-coordinate mapping used by BOTH
 * rasterization backends (render/backend.ts software path, render/gpu.ts WebGPU path).
 *
 * Mapping (docs/ground-truth/tesselator.md §5): shape UVs are in "shape texture units"
 * bounded by textureWidth/textureHeight (default 16, per-key override via textureSizes).
 * PNG texel coords are `pngX = u · k` with `k = pngWidth / shapeTextureWidth`. Normalized
 * 0..1 coordinates therefore collapse to `u / shapeTextureWidth` — independent of the PNG
 * resolution — which is what {@link TextureSet.normalizeUv} returns and what both backends
 * consume: the software backend samples per pixel via {@link sampleNearest} (floor at
 * k-scale = floor(normalized · pngWidth)), the GPU backend feeds the same normalized
 * values to a non-filtering nearest sampler (identical floor semantics, clamp-to-edge).
 *
 * Alpha cutout convention (shared, = the engine's): the entity alpha test is 0.05
 * (Lib:174631; tesselator.md §7/§10) — PNG alpha < 0.05·255 = 12.75, i.e. alpha ≤ 12
 * ↔ unorm alpha < 0.05 → fragment discarded. Both backends agree bit-for-bit at this
 * threshold too (8-bit unorm quantizes to k/255: 12/255 ≈ 0.0471 < 0.05 < 13/255 ≈ 0.051).
 *
 * Missing textures (key absent from the shape's `textures` map, no resolver hit, or an
 * unreadable PNG) fall back to a deterministic 1×1 flat color derived from the key
 * (FNV-1a hash → hue, HSL s 0.55 l 0.55, alpha 255) and the key is recorded in
 * {@link TextureSet.missing} for captions.
 */

import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { rootOf } from '../vs/fk.js';
import { num, type ElementJson, type ShapeJson } from '../vs/types.js';

/** Decoded RGBA pixel buffer (row-major, 4 bytes per pixel). */
export interface TexturePixels {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/**
 * Ordered texture resolver: maps a shape texture asset path (e.g.
 * `entity/animal/mammal/fox/red-male`) to an absolute PNG path, or null when this
 * resolver cannot supply it (the next resolver is consulted).
 */
export type TextureResolver = (texturePath: string) => string | null;

/** Same duck-typing as fk.ts: accept the shape tree or any holder exposing it as `root`. */
export type ShapeDocLike = ShapeJson | { root: ShapeJson };

/** Decodes a PNG file into raw RGBA bytes. Throws naming the path on read/decode failure. */
export function loadTexturePng(absPath: string): TexturePixels {
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch (e) {
    throw new Error(
      `loadTexturePng: cannot read "${absPath}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let png: PNG;
  try {
    png = PNG.sync.read(buf);
  } catch (e) {
    throw new Error(
      `loadTexturePng: "${absPath}" is not a decodable PNG: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return {
    width: png.width,
    height: png.height,
    // pngjs always yields 8-bit RGBA in `data`; reuse its buffer without copying.
    rgba: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
  };
}

export interface TextureSet {
  /** Pixel buffers indexed by texId (the SceneJob texture table). */
  readonly textures: readonly TexturePixels[];
  /** Texture keys that fell back to a flat color, in first-reference order. */
  readonly missing: readonly string[];
  /** texId for a texture key referenced by the shape (leading '#' already stripped). */
  idFor(key: string): number;
  /** Shape-UV units → normalized [0,1] coordinates for the key's texture (see module doc). */
  normalizeUv(key: string, u: number, v: number): [number, number];
}

/**
 * Builds the texture table for a shape: one entry per texture key referenced by any face
 * (plus declared-but-unused keys from the `textures` map, so texIds are stable even when
 * faces are toggled). Resolvers are consulted in order; a resolver hit whose PNG fails to
 * decode falls through to the next resolver, then to the flat-color fallback.
 */
export function createTextureSet(
  doc: ShapeDocLike,
  resolvers: readonly TextureResolver[] = [],
): TextureSet {
  const root = rootOf(doc);
  const texMap = root.textures ?? {};
  // Guard zero/negative sizes (would divide UVs by 0); the engine default is 16.
  const defW = num(root.textureWidth, 16) > 0 ? num(root.textureWidth, 16) : 16;
  const defH = num(root.textureHeight, 16) > 0 ? num(root.textureHeight, 16) : 16;

  // Collect keys in deterministic order: face references (tree order), then declared keys.
  const keys: string[] = [];
  const seen = new Set<string>();
  const addKey = (raw: string): void => {
    const key = raw.startsWith('#') ? raw.slice(1) : raw;
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  };
  const walk = (els: readonly ElementJson[] | undefined): void => {
    for (const el of els ?? []) {
      for (const face of Object.values(el.faces ?? {})) {
        if (face && typeof face.texture === 'string') addKey(face.texture);
      }
      walk(el.children);
    }
  };
  walk(root.elements);
  for (const key of Object.keys(texMap)) addKey(key);

  const ids = new Map<string, number>();
  const sizes = new Map<string, readonly [number, number]>();
  const textures: TexturePixels[] = [];
  const missing: string[] = [];

  for (const key of keys) {
    const override = root.textureSizes?.[key];
    const w = override ? num(override[0], defW) : defW;
    const h = override ? num(override[1], defH) : defH;
    sizes.set(key, [w > 0 ? w : defW, h > 0 ? h : defH]);

    let pixels: TexturePixels | null = null;
    const assetPath = texMap[key];
    if (typeof assetPath === 'string') {
      for (const resolve of resolvers) {
        const abs = resolve(assetPath);
        if (abs === null) continue;
        try {
          pixels = loadTexturePng(abs);
          break;
        } catch {
          // Resolver pointed at an unreadable/undecodable file — try the next resolver.
        }
      }
    }
    if (pixels === null) {
      missing.push(key);
      pixels = fallbackTexture(key);
    }
    ids.set(key, textures.length);
    textures.push(pixels);
  }

  const knownKeys = (): string => (keys.length > 0 ? keys.join(', ') : '(none)');
  return {
    textures,
    missing,
    idFor(key: string): number {
      const id = ids.get(key);
      if (id === undefined) {
        throw new Error(
          `Texture key '${key}' is not referenced by this shape; known keys: ${knownKeys()}. ` +
            `Faces must reference '#<key>' entries of the shape's "textures" map.`,
        );
      }
      return id;
    },
    normalizeUv(key: string, u: number, v: number): [number, number] {
      const size = sizes.get(key);
      if (size === undefined) {
        throw new Error(
          `Texture key '${key}' is not referenced by this shape; known keys: ${knownKeys()}. ` +
            `Cannot map shape UVs for it.`,
        );
      }
      return [u / size[0], v / size[1]];
    },
  };
}

/**
 * Nearest-neighbor sample at normalized [0,1] coordinates, clamp-to-edge (the same floor +
 * clamp the GPU's non-filtering clamp-to-edge sampler performs). Returns null for the
 * engine alpha-cutout convention (alpha < 0.05·255, i.e. < 13 ↔ unorm < 0.05 — see
 * module doc and tesselator.md §7).
 */
export function sampleNearest(
  tex: TexturePixels,
  u: number,
  v: number,
): [number, number, number, number] | null {
  let tx = Math.floor(u * tex.width);
  let ty = Math.floor(v * tex.height);
  if (tx < 0) tx = 0;
  else if (tx >= tex.width) tx = tex.width - 1;
  if (ty < 0) ty = 0;
  else if (ty >= tex.height) ty = tex.height - 1;
  const o = (ty * tex.width + tx) * 4;
  const a = tex.rgba[o + 3]!;
  if (a < 13) return null;
  return [tex.rgba[o]!, tex.rgba[o + 1]!, tex.rgba[o + 2]!, a];
}

/** FNV-1a 32-bit over UTF-16 code units — stable across runs/platforms. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic flat color for a missing texture key: hash → hue, HSL s 0.55 l 0.55,
 * alpha 255. Exported so tests (and captions) can pin the determinism contract.
 */
export function fallbackColor(key: string): [number, number, number] {
  return hslToRgb(fnv1a(key) % 360, 0.55, 0.55);
}

function fallbackTexture(key: string): TexturePixels {
  const [r, g, b] = fallbackColor(key);
  return { width: 1, height: 1, rgba: Uint8Array.of(r, g, b, 255) };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
