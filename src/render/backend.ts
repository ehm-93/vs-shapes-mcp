/**
 * The two-backend rasterization contract (ARCHITECTURE.md §render).
 *
 * A {@link SceneJob} is FULLY pre-transformed on the CPU (render/camera.ts projects world
 * geometry to screen px + depth; render/textures.ts supplies normalized UVs and the texel
 * buffers), so the WebGPU backend (render/gpu.ts) and the software backend (thin adapter
 * over render/raster.ts, below) rasterize byte-identical input. Shared conventions:
 *
 * - x/y in pixels (y down), z depth in arbitrary world units, SMALLER = NEARER. Triangles
 *   depth-test with strict "nearer wins; first drawn wins ties" semantics.
 * - u/v are normalized [0,1] texture coordinates; nearest sampling, clamp-to-edge.
 * - Alpha cutout: texel alpha < 13 (unorm < 0.05, the engine's entity alphaTest,
 *   Lib:174631) discards the fragment — no color, no depth; both backends discard exactly
 *   the same texel set (textures.ts module doc).
 * - `shade` multiplies the sampled RGB (flat per-face brightness); alpha is written as
 *   sampled. No blending — color writes overwrite.
 * - Back faces are NOT culled (vanilla zero-thickness ears render from both sides).
 * - Lines draw AFTER triangles, in array order. `depthTest: true` lines depth-test
 *   (less-equal) and write depth; `depthTest: false` lines are pure overlays (no depth
 *   read or write). Scene builders should bias line z slightly off coplanar surfaces —
 *   exact-tie resolution is the one place the two backends are allowed to disagree.
 */

import { createFramebuffer, drawLine, rasterTriangle, type Rgba, type ScreenVertex } from './raster.js';
import { sampleNearest, type TexturePixels } from './textures.js';

export type { Rgba, ScreenVertex } from './raster.js';
export type { TexturePixels } from './textures.js';

export interface SceneTri {
  v: [ScreenVertex, ScreenVertex, ScreenVertex];
  /** Index into {@link SceneJob.textures}. */
  texId: number;
  /** Flat brightness multiplier applied to sampled RGB (0..1]. */
  shade: number;
}

export interface SceneLine {
  a: ScreenVertex;
  b: ScreenVertex;
  rgba: Rgba;
  /** true: depth-test (less-equal) + depth-write; false: overlay (no depth read/write). */
  depthTest: boolean;
}

export interface SceneJob {
  width: number;
  height: number;
  /** Background [r,g,b,a] 0–255. */
  clear: Rgba;
  /** Texture pixel buffers; {@link SceneTri.texId} indexes this array. */
  textures: readonly TexturePixels[];
  tris: readonly SceneTri[];
  lines: readonly SceneLine[];
}

export interface RenderBackend {
  readonly name: 'webgpu' | 'software';
  /** Renders one job to a width*height*4 RGBA byte buffer (row-major, y down). */
  renderScene(job: SceneJob): Promise<Uint8ClampedArray>;
  /** Releases backend resources (GPU device). Safe to call more than once. */
  dispose(): void;
}

export type BackendPreference = 'webgpu' | 'software' | 'auto';

/** Auto-fallback is announced once per process (gpu.ts caches the init failure anyway). */
let warnedAutoFallback = false;

/** Shared job validation — both backends call this so errors are uniform. */
export function validateSceneJob(job: SceneJob): void {
  if (
    !Number.isInteger(job.width) ||
    !Number.isInteger(job.height) ||
    job.width <= 0 ||
    job.height <= 0
  ) {
    throw new Error(
      `renderScene: width and height must be positive integers, got ${job.width}x${job.height}`,
    );
  }
  for (let i = 0; i < job.tris.length; i++) {
    const texId = job.tris[i]!.texId;
    if (!Number.isInteger(texId) || texId < 0 || texId >= job.textures.length) {
      throw new Error(
        `renderScene: tris[${i}] references texId ${texId} but the job carries ` +
          `${job.textures.length} texture(s); texIds must index SceneJob.textures ` +
          `(use TextureSet.idFor).`,
      );
    }
  }
}

/**
 * Software backend: thin adapter over raster.ts primitives. This is the determinism
 * reference — given the same SceneJob it produces byte-identical output on every run.
 */
export function createSoftwareBackend(): RenderBackend {
  return {
    name: 'software',
    // eslint-disable-next-line @typescript-eslint/require-await
    async renderScene(job: SceneJob): Promise<Uint8ClampedArray> {
      validateSceneJob(job);
      const fb = createFramebuffer(job.width, job.height, job.clear);

      for (const tri of job.tris) {
        const tex = job.textures[tri.texId]!;
        const shade = tri.shade;
        rasterTriangle(fb, tri.v[0], tri.v[1], tri.v[2], (u, v) => {
          const c = sampleNearest(tex, u, v);
          if (c === null) return null;
          // Uint8ClampedArray rounds on write; the GPU's unorm conversion may round
          // 0.5-ties the other way — a 1-LSB difference covered by the diff tolerance.
          return [c[0] * shade, c[1] * shade, c[2] * shade, c[3]];
        });
      }

      for (const line of job.lines) {
        if (!line.depthTest) {
          drawLine(fb, line.a.x, line.a.y, line.b.x, line.b.y, line.rgba);
          continue;
        }
        // raster.drawLine only supports a constant z; approximate the GPU's per-pixel
        // depth interpolation by subdividing into ≤2 px segments, each at its midpoint z.
        const dx = line.b.x - line.a.x;
        const dy = line.b.y - line.a.y;
        const segments = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 2));
        for (let s = 0; s < segments; s++) {
          const t0 = s / segments;
          const t1 = (s + 1) / segments;
          const zMid = line.a.z + (line.b.z - line.a.z) * ((t0 + t1) / 2);
          drawLine(
            fb,
            line.a.x + dx * t0,
            line.a.y + dy * t0,
            line.a.x + dx * t1,
            line.a.y + dy * t1,
            line.rgba,
            zMid,
          );
        }
      }

      return fb.rgba;
    },
    dispose(): void {
      // No resources held.
    },
  };
}

/**
 * Selects a backend. 'auto' (default) tries WebGPU lazily and falls back to software on
 * ANY init failure with a single console.error line (NEVER console.log — the MCP server
 * speaks JSON-RPC on stdout). The VS_SHAPES_RENDERER env var ('webgpu' | 'software')
 * overrides 'auto'; an explicit `pref` argument beats the env var.
 */
export async function selectBackend(pref: BackendPreference = 'auto'): Promise<RenderBackend> {
  let effective = pref;
  if (effective === 'auto') {
    const env = process.env['VS_SHAPES_RENDERER']?.toLowerCase();
    if (env === 'webgpu' || env === 'software') effective = env;
    else if (env !== undefined && env !== '' && env !== 'auto') {
      console.error(
        `vs-shapes-mcp render: ignoring VS_SHAPES_RENDERER="${env}" (expected "webgpu" or "software"); using auto.`,
      );
    }
  }

  if (effective === 'software') return createSoftwareBackend();

  try {
    // Dynamic import keeps the Dawn native addon out of the process until actually needed.
    const { createWebGpuBackend } = await import('./gpu.js');
    return await createWebGpuBackend();
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim();
    if (effective === 'webgpu') {
      throw new Error(
        `WebGPU renderer was explicitly requested but failed to initialize: ${reason}. ` +
          `Pass renderer 'software' (or set VS_SHAPES_RENDERER=software) to use the software rasterizer.`,
      );
    }
    if (!warnedAutoFallback) {
      warnedAutoFallback = true;
      console.error(
        `vs-shapes-mcp render: WebGPU (Dawn) unavailable (${reason}); falling back to the software rasterizer.`,
      );
    }
    return createSoftwareBackend();
  }
}
