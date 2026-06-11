/**
 * gpu.ts: WebGPU (Dawn) backend. Skips gracefully (console note + runtime ctx.skip) when
 * no adapter/device is available. GPU output is NOT golden-byte-pinned — tests are
 * structural + same-process determinism + a pixel-diff budget against the software
 * reference (the two backends share pre-transformed geometry, so they may only disagree
 * on edge/rounding pixels).
 *
 * Teardown findings (verified on this machine, node-webgpu 0.4.0):
 * - Dawn MUST be initialized inside the test lifecycle (beforeAll), NOT at module
 *   top-level: top-level create() during vitest's collection kills the forked worker
 *   ("Channel closed" from tinypool). The same init inside a test/hook works fine.
 * - After device.destroy() a plain node/tsx process still does not exit on its own (Dawn
 *   keeps the event loop referenced); vitest's default forks pool force-exits its workers
 *   after the run, so dispose-in-afterAll + forks pool is the working combination.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSoftwareBackend,
  type RenderBackend,
  type SceneJob,
  type ScreenVertex,
  type TexturePixels,
} from '../../src/render/backend.js';
import { renderViews } from '../../src/render/views.js';
import { VsNum, type ShapeJson } from '../../src/vs/types.js';

let gpu: RenderBackend | null = null;

beforeAll(async () => {
  try {
    const { createWebGpuBackend } = await import('../../src/render/gpu.js');
    gpu = await createWebGpuBackend();
  } catch (e) {
    console.error(
      `tests/render/gpu.test.ts: WebGPU (Dawn) unavailable on this machine — skipping GPU tests: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
});
afterAll(() => gpu?.dispose());

/** Deep-wraps every number into a VsNum, mimicking the lossless parser's output. */
function wrapNums(value: unknown): unknown {
  if (typeof value === 'number') return new VsNum(value);
  if (Array.isArray(value)) return value.map(wrapNums);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = wrapNums(v);
    return out;
  }
  return value;
}

const gameDir =
  process.env['VINTAGE_STORY'] ?? path.join(process.env['APPDATA'] ?? '', 'Vintagestory');
const foxPath = path.join(
  gameDir, 'assets', 'survival', 'shapes', 'entity', 'animal', 'mammal', 'fox', 'fox-male.json',
);
const haveFox = existsSync(foxPath);
if (!haveFox) {
  console.error(
    `tests/render/gpu.test.ts: Vintage Story install not found at ${gameDir} — skipping fox parity tests`,
  );
}

const sv = (x: number, y: number, z: number, u = 0, v = 0): ScreenVertex => ({ x, y, z, u, v });
const CLEAR: [number, number, number, number] = [10, 20, 30, 255];
const quadTex: TexturePixels = {
  width: 2,
  height: 2,
  rgba: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 200, 200, 200, 0),
};
const whiteTex: TexturePixels = { width: 1, height: 1, rgba: Uint8Array.of(255, 255, 255, 255) };

function quadTris(size: number, texId: number, shade: number, z: number): SceneJob['tris'] {
  const v0 = sv(0, 0, z, 0, 0);
  const v1 = sv(size, 0, z, 1, 0);
  const v2 = sv(size, size, z, 1, 1);
  const v3 = sv(0, size, z, 0, 1);
  return [
    { v: [v0, v1, v2], texId, shade },
    { v: [v0, v2, v3], texId, shade },
  ];
}

function px(buf: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const o = (y * width + x) * 4;
  return [buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!];
}

function expectClose(actual: number[], expected: number[], tolerance: number, what: string): void {
  for (let i = 0; i < 4; i++) {
    expect(Math.abs(actual[i]! - expected[i]!), `${what} channel ${i}: ${actual} vs ${expected}`)
      .toBeLessThanOrEqual(tolerance);
  }
}

/** Fraction of pixels whose any channel differs by more than 8/255. */
function diffFraction(a: Buffer, b: Buffer): number {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  expect(pb.width).toBe(pa.width);
  expect(pb.height).toBe(pa.height);
  let bad = 0;
  for (let o = 0; o < pa.data.length; o += 4) {
    if (
      Math.abs(pa.data[o]! - pb.data[o]!) > 8 ||
      Math.abs(pa.data[o + 1]! - pb.data[o + 1]!) > 8 ||
      Math.abs(pa.data[o + 2]! - pb.data[o + 2]!) > 8 ||
      Math.abs(pa.data[o + 3]! - pb.data[o + 3]!) > 8
    ) {
      bad++;
    }
  }
  return bad / (pa.width * pa.height);
}

describe('webgpu backend', () => {
  it('renders the textured quad scene: nearest sampling, shade, cutout, clear', async (ctx) => {
    if (gpu === null) return ctx.skip();
    const job: SceneJob = {
      width: 16,
      height: 16,
      clear: CLEAR,
      textures: [quadTex],
      tris: quadTris(16, 0, 1, 0),
      lines: [],
    };
    const out = await gpu.renderScene(job);
    expect(out.length).toBe(16 * 16 * 4);
    expectClose(px(out, 16, 4, 4), [255, 0, 0, 255], 1, 'tl');
    expectClose(px(out, 16, 12, 4), [0, 255, 0, 255], 1, 'tr');
    expectClose(px(out, 16, 4, 12), [0, 0, 255, 255], 1, 'bl');
    expectClose(px(out, 16, 12, 12), CLEAR, 1, 'br (cutout → clear)');

    const shaded = await gpu.renderScene({ ...job, tris: quadTris(16, 0, 0.5, 0) });
    expectClose(px(shaded, 16, 4, 4), [127.5, 0, 0, 255], 0.5, 'shaded'); // 127 or 128 per driver rounding
  });

  it('depth-tests triangles and renders both line depth modes like the software backend', async (ctx) => {
    if (gpu === null) return ctx.skip();
    const lineColor: [number, number, number, number] = [250, 240, 10, 255];
    // white quad covering x,y ∈ [8, 24) at depth −1 (nearer than the lines at +1)
    const job: SceneJob = {
      width: 32,
      height: 32,
      clear: CLEAR,
      textures: [whiteTex],
      tris: [
        { v: [sv(8, 8, -1), sv(24, 8, -1), sv(24, 24, -1)], texId: 0, shade: 1 },
        { v: [sv(8, 8, -1), sv(24, 24, -1), sv(8, 24, -1)], texId: 0, shade: 1 },
      ],
      lines: [
        { a: sv(0, 12, 1), b: sv(31, 12, 1), rgba: lineColor, depthTest: true },
        { a: sv(0, 20, 1), b: sv(31, 20, 1), rgba: lineColor, depthTest: false },
      ],
    };
    const out = await gpu.renderScene(job);
    expectClose(px(out, 32, 16, 12), [255, 255, 255, 255], 1, 'tested line hidden by quad');
    expectClose(px(out, 32, 2, 12), lineColor, 1, 'tested line visible off-quad');
    expectClose(px(out, 32, 16, 20), lineColor, 1, 'overlay line over quad');
  });

  it('matches the software backend on a synthetic scene within the diff budget', async (ctx) => {
    if (gpu === null) return ctx.skip();
    const software = createSoftwareBackend();
    const job: SceneJob = {
      width: 64,
      height: 64,
      clear: CLEAR,
      textures: [quadTex],
      tris: [
        {
          v: [sv(3.2, 5.1, 0.4, 0, 0), sv(60.7, 9.9, 0.1, 1, 0), sv(31.5, 58.3, -0.6, 1, 1)],
          texId: 0,
          shade: 0.8,
        },
        ...quadTris(64, 0, 1, 0.5),
      ],
      lines: [{ a: sv(2, 60, 0), b: sv(62, 40, 0), rgba: [99, 199, 9, 255], depthTest: false }],
    };
    const [g, s] = [await gpu.renderScene(job), await software.renderScene(job)];
    let bad = 0;
    for (let o = 0; o < g.length; o += 4) {
      if (
        Math.abs(g[o]! - s[o]!) > 8 ||
        Math.abs(g[o + 1]! - s[o + 1]!) > 8 ||
        Math.abs(g[o + 2]! - s[o + 2]!) > 8
      ) {
        bad++;
      }
    }
    expect(bad / (64 * 64)).toBeLessThanOrEqual(0.02);
  });

  it(
    'fox views: dims, >5% non-background, same-process byte-determinism, ≤2% diff vs software',
    async (ctx) => {
      if (gpu === null || !haveFox) return ctx.skip();
      const fox = wrapNums(JSON.parse(readFileSync(foxPath, 'utf8'))) as ShapeJson;
      const viaGpu = await renderViews(fox, { renderer: 'webgpu' });
      const viaGpu2 = await renderViews(fox, { renderer: 'webgpu' });
      const viaSoftware = await renderViews(fox, { renderer: 'software' });

      expect(viaGpu.caption).toContain('backend webgpu');
      const png = PNG.sync.read(viaGpu.png);
      expect(png.width).toBe(640);
      expect(png.height).toBe(640);

      // >5% non-background (sample the background from a corner-adjacent pixel).
      const bo = (4 * png.width + 4) * 4;
      const bg = [png.data[bo]!, png.data[bo + 1]!, png.data[bo + 2]!];
      let non = 0;
      for (let o = 0; o < png.data.length; o += 4) {
        if (png.data[o] !== bg[0] || png.data[o + 1] !== bg[1] || png.data[o + 2] !== bg[2]) {
          non++;
        }
      }
      expect(non / (png.width * png.height)).toBeGreaterThan(0.05);

      expect(viaGpu.png.equals(viaGpu2.png)).toBe(true); // same-process determinism

      const diff = diffFraction(viaGpu.png, viaSoftware.png);
      // Reported for the build log — the actual measured backend divergence.
      console.error(
        `tests/render/gpu.test.ts: fox views gpu-vs-software pixel diff (>8/255 in any channel): ` +
          `${(diff * 100).toFixed(3)}% of ${png.width * png.height} px`,
      );
      expect(diff).toBeLessThanOrEqual(0.02);
    },
    120_000,
  );

  // Keep this LAST: it destroys the live device mid-session to simulate a Windows
  // TDR/driver reset and asserts the singleton recovers (device.lost handler clears the
  // cached context so the next renderScene re-initializes instead of mapAsync-failing
  // forever on the dead device).
  it('recovers from spontaneous device loss: the next renderScene re-initializes', async (ctx) => {
    if (gpu === null) return ctx.skip();
    const { _liveDeviceForTests } = await import('../../src/render/gpu.js');
    const job: SceneJob = {
      width: 8,
      height: 8,
      clear: CLEAR,
      textures: [whiteTex],
      tris: quadTris(8, 0, 1, 0),
      lines: [],
    };
    await gpu.renderScene(job); // ensure the device is live
    const device = _liveDeviceForTests();
    expect(device).not.toBeNull();
    device!.destroy(); // same spec lost-state as a TDR/driver reset
    await device!.lost; // the handler runs once the lost promise settles
    const out = await gpu.renderScene(job); // must re-init, not fail on the dead device
    expectClose(px(out, 8, 4, 4), [255, 255, 255, 255], 1, 'post-loss render');
    expect(_liveDeviceForTests()).not.toBe(device); // a fresh device was created
  });
});
