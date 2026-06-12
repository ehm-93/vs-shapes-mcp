/**
 * Palette extraction: read an existing model's texture PNGs and report the colors they
 * use as a compact, frequency-ranked palette — the colors you'd reuse to texture a
 * matching new model, or to describe a creature's color scheme.
 *
 * Textures are resolved and decoded through the SAME chain the renderer uses
 * ({@link createTextureSet} + {@link buildResolvers}): an optional mod-assets
 * `texturesRoot`, then the game install. A texture whose PNG cannot be resolved is
 * reported in {@link PaletteResult.missingTextures} and excluded — the deterministic flat
 * fallback the renderer substitutes is NOT a real model color and would pollute the
 * palette.
 *
 * Only texels at or above the alpha cutout (the engine alphaTest, alpha ≥ 13 — see
 * textures.ts) are counted; fully transparent background pixels are skipped. Alpha is
 * otherwise ignored (a palette is about hue/value).
 *
 * Two modes (vanilla entity textures are dithered — a fox skin has ~2 000 near-identical
 * browns across 4 096 texels — so exact counting fragments into indistinguishable shades):
 * - `representative` (default): median-cut quantization to `maxColors` perceptually
 *   distinct colors (via gifenc, the GIF renderer's quantizer), then every texel is
 *   assigned to its nearest one for accurate coverage. For flat pixel art the
 *   representatives ARE the exact colors; for dithered art they are meaningful clusters.
 * - `exact`: the exact 8-bit RGB triples, ranked by coverage and truncated to `maxColors`
 *   (use when you need precise hex values from flat textures).
 */

import { createRequire } from 'node:module';
// gifenc is CJS; createRequire loads module.exports identically under Node and vitest
// (mirrors render/views.ts, the other gifenc consumer).
const { applyPalette, quantize } = createRequire(import.meta.url)(
  'gifenc',
) as typeof import('gifenc');

import { rootOf, type ShapeDocLike } from '../vs/fk.js';
import { type ShapeJson } from '../vs/types.js';
import { createTextureSet, type TexturePixels } from './textures.js';
import { buildResolvers } from './views.js';

/** One palette entry: an 8-bit RGB color and how much of the texels it covers. */
export interface PaletteColor {
  /** Lowercase `#rrggbb`. */
  hex: string;
  rgb: [number, number, number];
  /** Texels assigned to this color (exact mode: of this exact color). */
  count: number;
  /** Share of all counted texels, 0..1 (rounded to 4 decimals). */
  fraction: number;
}

/** Per-texture-key palette breakdown (when requested). */
export interface TexturePaletteEntry {
  /** Texture key from the shape's `textures` map (no leading '#'). */
  key: string;
  /** The texture's asset path (the `textures` map value). */
  assetPath: string;
  width: number;
  height: number;
  /** Texels counted (alpha ≥ cutout). */
  opaquePixels: number;
  /** Distinct exact 8-bit colors in this texture (a noisiness signal). */
  distinctColors: number;
  /** This texture's palette, top `maxColors` by coverage. */
  colors: PaletteColor[];
}

export interface PaletteResult {
  /** Combined palette across every resolved texture, top `maxColors` by coverage. */
  colors: PaletteColor[];
  /** Which counting mode produced `colors`. */
  mode: 'representative' | 'exact';
  /** Total distinct exact 8-bit colors across all resolved textures (a noisiness signal). */
  distinctColors: number;
  /** Total texels counted across all resolved textures (alpha ≥ cutout). */
  opaquePixels: number;
  /** Fraction of `opaquePixels` the returned `colors` cover, 0..1 (rounded to 4 decimals). */
  coverage: number;
  /** Texture keys whose PNG resolved and was decoded. */
  resolvedTextures: string[];
  /** Texture keys with no resolvable PNG — excluded from the palette. */
  missingTextures: string[];
  /** Per-key breakdown when `perTexture` was set. */
  perTexture?: TexturePaletteEntry[];
}

export interface ExtractPaletteOpts {
  /** Extra root dir for texture PNG resolution (mod assets); game assets always fall back. */
  texturesRoot?: string;
  /** Max colors per palette list (combined and per-texture). Default 16. */
  maxColors?: number;
  /** Minimum alpha (0–255) for a texel to count. Default 13 (the engine alpha cutout). */
  alphaThreshold?: number;
  /** Count exact 8-bit colors instead of median-cut representatives. Default false. */
  exact?: boolean;
  /** Include the per-texture-key breakdown. Default false. */
  perTexture?: boolean;
}

const DEFAULT_MAX_COLORS = 16;
const DEFAULT_ALPHA_THRESHOLD = 13; // engine alphaTest 0.05 → alpha < 13 discarded (textures.ts)

const hexOf = (r: number, g: number, b: number): string =>
  `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Counted index→count map → ranked, truncated palette + coverage of the kept subset. */
function rankCounts(
  counts: Map<number, number>,
  total: number,
  maxColors: number,
  rgbOf: (key: number) => [number, number, number],
): { colors: PaletteColor[]; coverage: number } {
  // Sort by count desc, then key asc so ties are deterministic across runs.
  const kept = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, maxColors);
  let keptCount = 0;
  const colors = kept.map(([key, count]) => {
    keptCount += count;
    const [r, g, b] = rgbOf(key);
    return {
      hex: hexOf(r, g, b),
      rgb: [r, g, b] as [number, number, number],
      count,
      fraction: total > 0 ? round4(count / total) : 0,
    };
  });
  return { colors, coverage: total > 0 ? round4(keptCount / total) : 0 };
}

/** Exact-RGB palette: every distinct packed color, ranked by coverage. */
function exactPalette(
  packedCounts: Map<number, number>,
  total: number,
  maxColors: number,
): { colors: PaletteColor[]; coverage: number } {
  return rankCounts(packedCounts, total, maxColors, (p) => [(p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff]);
}

/** Median-cut representative palette: quantize, then assign each texel to a representative. */
function representativePalette(
  rgba: Uint8Array,
  total: number,
  maxColors: number,
): { colors: PaletteColor[]; coverage: number } {
  if (total === 0) return { colors: [], coverage: 0 };
  // gifenc needs ≥ 2 buckets; for maxColors 1 we still rank and slice to the top one.
  const palette = quantize(rgba, Math.max(2, maxColors), { format: 'rgb565' });
  const indices = applyPalette(rgba, palette, 'rgb565');
  const counts = new Map<number, number>();
  for (const idx of indices) counts.set(idx, (counts.get(idx) ?? 0) + 1);
  return rankCounts(counts, total, maxColors, (idx) => {
    const c = palette[idx]!;
    return [c[0]!, c[1]!, c[2]!];
  });
}

/** Single pass over a texture: compact opaque RGBA buffer + exact packed-color histogram. */
function gatherOpaque(
  tex: TexturePixels,
  alphaThreshold: number,
): { opaque: Uint8Array; packedCounts: Map<number, number> } {
  const { rgba } = tex;
  const opaque = new Uint8Array(rgba.length);
  const packedCounts = new Map<number, number>();
  let n = 0;
  for (let o = 0; o < rgba.length; o += 4) {
    const r = rgba[o]!;
    const g = rgba[o + 1]!;
    const b = rgba[o + 2]!;
    if (rgba[o + 3]! < alphaThreshold) continue;
    opaque[n] = r;
    opaque[n + 1] = g;
    opaque[n + 2] = b;
    opaque[n + 3] = 255;
    n += 4;
    const packed = (r << 16) | (g << 8) | b;
    packedCounts.set(packed, (packedCounts.get(packed) ?? 0) + 1);
  }
  return { opaque: opaque.subarray(0, n), packedCounts };
}

/**
 * Extract the color palette of a model from its (resolved) texture PNGs. Reads no model
 * geometry — only the `textures` map and the PNGs it points at.
 */
export function extractPalette(doc: ShapeDocLike, opts: ExtractPaletteOpts = {}): PaletteResult {
  const root: ShapeJson = rootOf(doc);
  const maxColors = opts.maxColors ?? DEFAULT_MAX_COLORS;
  if (!Number.isInteger(maxColors) || maxColors < 1 || maxColors > 256) {
    throw new Error(`extractPalette: maxColors must be an integer between 1 and 256, got ${maxColors}`);
  }
  const alphaThreshold = opts.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
  if (!Number.isFinite(alphaThreshold) || alphaThreshold < 0 || alphaThreshold > 255) {
    throw new Error(`extractPalette: alphaThreshold must be between 0 and 255, got ${alphaThreshold}`);
  }
  const exact = opts.exact === true;
  const mode = exact ? 'exact' : 'representative';

  const texMap = root.textures ?? {};
  const texSet = createTextureSet(root, buildResolvers(opts.texturesRoot));
  const missingSet = new Set(texSet.missing);

  const combinedPacked = new Map<number, number>();
  const combinedOpaque: Uint8Array[] = [];
  let combinedTotal = 0;
  const resolvedTextures: string[] = [];
  const perTexture: TexturePaletteEntry[] = [];

  // Iterate the declared texture keys (the model's sheet); face-only keys have no asset
  // path and can never resolve, so they only ever land in `missing`.
  for (const [key, assetPath] of Object.entries(texMap)) {
    if (typeof assetPath !== 'string' || missingSet.has(key)) continue;
    const tex = texSet.textures[texSet.idFor(key)];
    if (tex === undefined) continue;
    resolvedTextures.push(key);

    const { opaque, packedCounts } = gatherOpaque(tex, alphaThreshold);
    const localTotal = opaque.length / 4;
    combinedOpaque.push(opaque);
    combinedTotal += localTotal;
    for (const [packed, c] of packedCounts) {
      combinedPacked.set(packed, (combinedPacked.get(packed) ?? 0) + c);
    }

    if (opts.perTexture === true) {
      const local = exact
        ? exactPalette(packedCounts, localTotal, maxColors)
        : representativePalette(opaque, localTotal, maxColors);
      perTexture.push({
        key,
        assetPath,
        width: tex.width,
        height: tex.height,
        opaquePixels: localTotal,
        distinctColors: packedCounts.size,
        colors: local.colors,
      });
    }
  }

  let combined: { colors: PaletteColor[]; coverage: number };
  if (exact) {
    combined = exactPalette(combinedPacked, combinedTotal, maxColors);
  } else {
    // Concatenate every texture's opaque texels into one buffer for a shared palette.
    const all = new Uint8Array(combinedOpaque.reduce((s, b) => s + b.length, 0));
    let off = 0;
    for (const b of combinedOpaque) {
      all.set(b, off);
      off += b.length;
    }
    combined = representativePalette(all, combinedTotal, maxColors);
  }

  return {
    colors: combined.colors,
    mode,
    distinctColors: combinedPacked.size,
    opaquePixels: combinedTotal,
    coverage: combined.coverage,
    resolvedTextures,
    missingTextures: [...texSet.missing],
    ...(opts.perTexture === true ? { perTexture } : {}),
  };
}
