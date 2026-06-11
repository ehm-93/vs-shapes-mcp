/**
 * backend.ts: software backend semantics (the determinism reference) + backend selection.
 * The same quad/line scenes are re-rendered on the GPU in gpu.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  createSoftwareBackend,
  selectBackend,
  type SceneJob,
  type ScreenVertex,
  type TexturePixels,
} from '../../src/render/backend.js';

const CLEAR: [number, number, number, number] = [10, 20, 30, 255];

const sv = (x: number, y: number, z: number, u = 0, v = 0): ScreenVertex => ({ x, y, z, u, v });

/** 2×2 texture: tl red, tr green, bl blue, br transparent. */
const quadTex: TexturePixels = {
  width: 2,
  height: 2,
  rgba: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 200, 200, 200, 0),
};
const whiteTex: TexturePixels = { width: 1, height: 1, rgba: Uint8Array.of(255, 255, 255, 255) };

/** Full-viewport textured quad as two tris (uv 0..1 across), at constant depth z. */
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

describe('software backend', () => {
  const backend = createSoftwareBackend();

  it('samples nearest, applies shade, and cuts out alpha < 128', async () => {
    const job: SceneJob = {
      width: 16,
      height: 16,
      clear: CLEAR,
      textures: [quadTex],
      tris: quadTris(16, 0, 1, 0),
      lines: [],
    };
    const out = await backend.renderScene(job);
    expect(out.length).toBe(16 * 16 * 4);
    expect(px(out, 16, 4, 4)).toEqual([255, 0, 0, 255]); // tl texel
    expect(px(out, 16, 12, 4)).toEqual([0, 255, 0, 255]); // tr texel
    expect(px(out, 16, 4, 12)).toEqual([0, 0, 255, 255]); // bl texel
    expect(px(out, 16, 12, 12)).toEqual(CLEAR); // br texel transparent → clear shows

    const shaded = await backend.renderScene({ ...job, tris: quadTris(16, 0, 0.5, 0) });
    expect(px(shaded, 16, 4, 4)).toEqual([128, 0, 0, 255]); // 255·0.5 → clamped-array rounds to 128
  });

  it('depth-tests triangles: nearer wins regardless of draw order', async () => {
    const out = await backend.renderScene({
      width: 8,
      height: 8,
      clear: CLEAR,
      textures: [quadTex, whiteTex],
      tris: [...quadTris(8, 1, 1, -1), ...quadTris(8, 0, 1, 0)], // white nearer, drawn first
      lines: [],
    });
    expect(px(out, 8, 2, 2)).toEqual([255, 255, 255, 255]);
  });

  it('lines: depthTest=true hides behind nearer geometry, depthTest=false overlays', async () => {
    const lineColor: [number, number, number, number] = [250, 240, 10, 255];
    const out = await backend.renderScene({
      width: 32,
      height: 32,
      clear: CLEAR,
      textures: [whiteTex],
      // quad covering x,y ∈ [8, 24) at depth 0
      tris: [
        { v: [sv(8, 8, 0), sv(24, 8, 0), sv(24, 24, 0)], texId: 0, shade: 1 },
        { v: [sv(8, 8, 0), sv(24, 24, 0), sv(8, 24, 0)], texId: 0, shade: 1 },
      ],
      lines: [
        { a: sv(0, 12, 1), b: sv(31, 12, 1), rgba: lineColor, depthTest: true },
        { a: sv(0, 20, 1), b: sv(31, 20, 1), rgba: lineColor, depthTest: false },
      ],
    });
    expect(px(out, 32, 16, 12)).toEqual([255, 255, 255, 255]); // tested line hidden by quad
    expect(px(out, 32, 2, 12)).toEqual(lineColor); // visible off the quad
    expect(px(out, 32, 16, 20)).toEqual(lineColor); // overlay paints over the quad
  });

  it('interpolates depth along depth-tested lines (near end shows, far end hides)', async () => {
    const out = await backend.renderScene({
      width: 32,
      height: 32,
      clear: CLEAR,
      textures: [whiteTex],
      // quad at depth 0 covering everything
      tris: quadTris(32, 0, 1, 0),
      // line crossing from z=-1 (near, left) to z=+1 (far, right) at row 16
      lines: [{ a: sv(0, 16, -1), b: sv(31, 16, 1), rgba: [250, 240, 10, 255], depthTest: true }],
    });
    expect(px(out, 32, 2, 16)).toEqual([250, 240, 10, 255]); // near half in front
    expect(px(out, 32, 29, 16)).toEqual([255, 255, 255, 255]); // far half behind
  });

  it('is byte-deterministic across runs', async () => {
    const job: SceneJob = {
      width: 24,
      height: 24,
      clear: CLEAR,
      textures: [quadTex],
      tris: [
        { v: [sv(1.3, 2.7, 0.2, 0, 0), sv(22.1, 3.4, 0.5, 1, 0), sv(11.9, 21.8, -0.1, 1, 1)], texId: 0, shade: 0.77 },
      ],
      lines: [{ a: sv(0, 0, 0), b: sv(23.6, 23.2, 0), rgba: [9, 99, 199, 255], depthTest: false }],
    };
    const a = await backend.renderScene(job);
    const b = await backend.renderScene(job);
    expect(Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
      Buffer.from(b.buffer, b.byteOffset, b.byteLength),
    )).toBe(true);
  });

  it('rejects out-of-range texIds with a named error', async () => {
    await expect(
      backend.renderScene({
        width: 8,
        height: 8,
        clear: CLEAR,
        textures: [whiteTex],
        tris: [{ v: [sv(0, 0, 0), sv(8, 0, 0), sv(8, 8, 0)], texId: 3, shade: 1 }],
        lines: [],
      }),
    ).rejects.toThrow(/texId 3.*1 texture/);
  });
});

describe('selectBackend', () => {
  it("'software' returns the software backend", async () => {
    const b = await selectBackend('software');
    expect(b.name).toBe('software');
    b.dispose();
  });

  it("'auto' returns a working backend (either name) without throwing", async () => {
    const b = await selectBackend('auto');
    expect(['software', 'webgpu']).toContain(b.name);
    const out = await b.renderScene({
      width: 4,
      height: 4,
      clear: CLEAR,
      textures: [],
      tris: [],
      lines: [],
    });
    expect(out.length).toBe(4 * 4 * 4);
    expect(px(out, 4, 1, 1)).toEqual(CLEAR);
    b.dispose();
  });
});
