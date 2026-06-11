/**
 * WebGPU (Dawn) rasterization backend — same SceneJob contract as the software backend
 * (render/backend.ts), implemented with the official `webgpu` npm package (dawn-gpu /
 * node-webgpu). Patterns mirror the verified spike at scratch.spike-webgpu.mjs:
 * create() → requestAdapter → requestDevice, render to rgba8unorm, copyTextureToBuffer
 * readback with 256-byte bytesPerRow alignment.
 *
 * Matching the software reference:
 * - Vertex shader maps pixel coords → NDC via a {width, height} uniform; depth is the
 *   job's world-unit z affinely remapped into [0.05, 0.95] (monotonic, so ordering is
 *   identical to the software backend's raw-z compares; the margins keep the nearest and
 *   farthest vertices off the 0/1 clip boundaries).
 * - Triangles: depthCompare 'less' (first-drawn wins exact ties, like raster.ts),
 *   cullMode 'none', non-filtering nearest sampler (clamp-to-edge), fragment discard at
 *   alpha < 0.05 (the engine's entity alphaTest, Lib:174631 — the unorm image of the
 *   software backend's `alpha < 13` cutout; both discard exactly the same texel set),
 *   rgb *= per-vertex shade. Triangles are grouped by texId — one bind group + one draw
 *   per distinct texture — preserving first-seen group order and in-group array order.
 * - Lines: line-list pipelines, depthCompare 'less-equal' + depth-write when depthTest,
 *   'always' + no write otherwise; consecutive same-mode lines are batched so array order
 *   is preserved. Endpoints are snapped to pixel centers and extended half a pixel at the
 *   far end so Dawn's diamond-exit rule covers (approximately) the same pixels as
 *   raster.ts's endpoint-inclusive Bresenham.
 *
 * Lifetime: ONE lazy singleton device shared by every backend instance (ARCHITECTURE.md);
 * GPU textures/buffers are created per renderScene call and destroyed before it returns.
 * dispose() destroys the singleton device (a later createWebGpuBackend() re-initializes).
 *
 * node-webgpu 0.4.0 pitfalls (all found empirically on Windows/D3D12, pinned by tests):
 * - The root GPU instance and adapter must stay strongly referenced for the device's whole
 *   lifetime; see {@link GpuContext.gpu}. Letting V8 collect them while the device is in
 *   use segfaults the process a few renders later, inside whichever await next pumps Dawn
 *   events (mapAsync / popErrorScope / onSubmittedWorkDone).
 * - Even after device.destroy(), Dawn keeps the Node event loop referenced — a plain
 *   node/tsx process will NOT exit naturally once create() has run (the demo spike ends
 *   with process.exit for this reason). The long-lived MCP server doesn't care; one-shot
 *   scripts must process.exit.
 * - Under vitest: initialize Dawn inside the test lifecycle (beforeAll), never at test
 *   module top-level — top-level create() during collection kills the forked worker
 *   ("Channel closed"). With beforeAll init + dispose-in-afterAll, the default forks pool
 *   force-exits its workers and the suite completes cleanly (see tests/render/gpu.test.ts).
 */

import type { RenderBackend, SceneJob, ScreenVertex } from './backend.js';
import { validateSceneJob } from './backend.js';

interface GpuContext {
  /**
   * Root GPU instance + adapter, retained ON PURPOSE: node-webgpu 0.4.0 segfaults
   * (native use-after-free in the Dawn event pump) once these wrappers are garbage
   * collected while the device is still in use. Do not remove them.
   */
  gpu: GPU;
  adapter: GPUAdapter;
  device: GPUDevice;
  sampler: GPUSampler;
  triPipeline: GPURenderPipeline;
  lineDepthPipeline: GPURenderPipeline;
  lineOverlayPipeline: GPURenderPipeline;
}

let contextPromise: Promise<GpuContext> | null = null;
let liveContext: GpuContext | null = null;
/** First init failure, cached so 'auto' selection doesn't re-probe Dawn on every render. */
let initFailure: Error | null = null;

const COLOR_FORMAT: GPUTextureFormat = 'rgba8unorm';
const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

const SHADER_WGSL = /* wgsl */ `
  // x = viewport width px, y = viewport height px, z = zMin, w = zRange
  @group(0) @binding(0) var<uniform> vp: vec4f;
  @group(0) @binding(1) var samp: sampler;
  @group(0) @binding(2) var tex: texture_2d<f32>;

  fn toClip(p: vec3f) -> vec4f {
    let x = p.x / vp.x * 2.0 - 1.0;
    let y = 1.0 - p.y / vp.y * 2.0;
    let z = 0.05 + 0.9 * (p.z - vp.z) / vp.w;
    return vec4f(x, y, z, 1.0);
  }

  struct TriOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) shade: f32,
  };

  @vertex fn vsTri(
    @location(0) pos: vec3f,
    @location(1) uv: vec2f,
    @location(2) shade: f32,
  ) -> TriOut {
    var out: TriOut;
    out.pos = toClip(pos);
    out.uv = uv;
    out.shade = shade;
    return out;
  }

  @fragment fn fsTri(in: TriOut) -> @location(0) vec4f {
    let c = textureSample(tex, samp, in.uv);
    // Engine entity alphaTest = 0.05 (Lib:174631); identical texel set to the software
    // backend's integer "alpha < 13" cutoff (12/255 < 0.05 < 13/255).
    if (c.a < 0.05) { discard; }
    return vec4f(c.rgb * in.shade, c.a);
  }

  struct LineOut {
    @builtin(position) pos: vec4f,
    @location(0) color: vec4f,
  };

  @vertex fn vsLine(@location(0) pos: vec3f, @location(1) color: vec4f) -> LineOut {
    var out: LineOut;
    out.pos = toClip(pos);
    out.color = color;
    return out;
  }

  @fragment fn fsLine(in: LineOut) -> @location(0) vec4f {
    return in.color;
  }
`;

async function initContext(): Promise<GpuContext> {
  // Dynamic import: loading the Dawn native addon is deferred until a GPU render is
  // actually requested (selectBackend('software') must never touch it).
  const { create, globals } = await import('webgpu');
  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error(
      'webgpu: no GPU adapter available (Dawn requestAdapter returned null); ' +
        'use the software renderer on this machine.',
    );
  }
  const device = await adapter.requestDevice();

  // Spontaneous device loss (Windows TDR/driver reset, sleep-resume, driver update — all
  // routine for a long-lived server) leaves every later mapAsync rejecting forever. Drop
  // the cached context so the next renderScene re-initializes; initFailure stays null so
  // 'auto' callers retry the GPU rather than being pinned to a dead device. The identity
  // guard keeps a stale lost event from clobbering a newer context (e.g. after dispose()).
  device.lost.then(
    () => {
      if (liveContext?.device === device) {
        liveContext = null;
        contextPromise = null;
      }
    },
    () => {
      /* the lost promise itself never rejects per spec; defensive for node-webgpu */
    },
  );

  const module = device.createShaderModule({ code: SHADER_WGSL });
  const sampler = device.createSampler({
    // Non-filtering nearest sampler, clamp-to-edge — identical semantics to
    // textures.sampleNearest in the software backend.
    magFilter: 'nearest',
    minFilter: 'nearest',
    mipmapFilter: 'nearest',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  const triPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vsTri',
      buffers: [
        {
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' }, // x, y px + z depth
            { shaderLocation: 1, offset: 12, format: 'float32x2' }, // normalized uv
            { shaderLocation: 2, offset: 20, format: 'float32' }, // shade
          ],
        },
      ],
    },
    fragment: { module, entryPoint: 'fsTri', targets: [{ format: COLOR_FORMAT }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
  });

  const lineDescriptor = (depthTest: boolean): GPURenderPipelineDescriptor => ({
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vsLine',
      buffers: [
        {
          arrayStride: 28,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x4' }, // rgba 0..1
          ],
        },
      ],
    },
    fragment: { module, entryPoint: 'fsLine', targets: [{ format: COLOR_FORMAT }] },
    primitive: { topology: 'line-list' },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: depthTest,
      depthCompare: depthTest ? 'less-equal' : 'always',
    },
  });

  return {
    gpu,
    adapter,
    device,
    sampler,
    triPipeline,
    lineDepthPipeline: device.createRenderPipeline(lineDescriptor(true)),
    lineOverlayPipeline: device.createRenderPipeline(lineDescriptor(false)),
  };
}

async function acquireContext(): Promise<GpuContext> {
  if (initFailure !== null) throw initFailure;
  if (contextPromise === null) {
    contextPromise = initContext().then(
      (ctx) => {
        liveContext = ctx;
        return ctx;
      },
      (e) => {
        contextPromise = null;
        initFailure = e instanceof Error ? e : new Error(String(e));
        throw initFailure;
      },
    );
  }
  return contextPromise;
}

function destroyContext(): void {
  if (liveContext !== null) {
    try {
      liveContext.device.destroy();
    } catch {
      // Already destroyed/lost — dispose() must stay safe to call repeatedly.
    }
    liveContext = null;
  }
  contextPromise = null;
  // A deliberate dispose() also clears a cached failure so a later attempt can retry.
  initFailure = null;
}

/**
 * Snap line endpoints to pixel centers and extend the far end by half a pixel so the
 * diamond-exit rule paints (approximately) the same endpoint-inclusive pixel run as
 * raster.drawLine's Bresenham.
 */
function snapLine(
  a: ScreenVertex,
  b: ScreenVertex,
): { ax: number; ay: number; bx: number; by: number } {
  const ax = Math.round(a.x) + 0.5;
  const ay = Math.round(a.y) + 0.5;
  let bx = Math.round(b.x) + 0.5;
  let by = Math.round(b.y) + 0.5;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    bx += (dx / len) * 0.5;
    by += (dy / len) * 0.5;
  } else {
    bx += 0.5; // zero-length line: Bresenham paints one pixel; exit its diamond eastward
  }
  return { ax, ay, bx, by };
}

async function renderSceneGpu(ctx: GpuContext, job: SceneJob): Promise<Uint8ClampedArray> {
  validateSceneJob(job);
  const { device } = ctx;
  const { width, height } = job;

  // Depth normalization range over every vertex (tris + lines).
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const tri of job.tris) {
    for (const v of tri.v) {
      if (v.z < zMin) zMin = v.z;
      if (v.z > zMax) zMax = v.z;
    }
  }
  for (const line of job.lines) {
    zMin = Math.min(zMin, line.a.z, line.b.z);
    zMax = Math.max(zMax, line.a.z, line.b.z);
  }
  if (!Number.isFinite(zMin)) {
    zMin = 0;
    zMax = 1;
  }
  const zRange = zMax > zMin ? zMax - zMin : 1;

  device.pushErrorScope('validation');

  const cleanup: { destroy(): void }[] = [];
  try {
    const uniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    cleanup.push(uniform);
    device.queue.writeBuffer(uniform, 0, Float32Array.of(width, height, zMin, zRange));

    // Group triangles by texId, preserving first-seen group order and in-group order.
    const groups = new Map<number, number[]>(); // texId → indices into job.tris
    for (let i = 0; i < job.tris.length; i++) {
      const texId = job.tris[i]!.texId;
      let list = groups.get(texId);
      if (list === undefined) {
        list = [];
        groups.set(texId, list);
      }
      list.push(i);
    }

    interface TriDraw {
      buffer: GPUBuffer;
      bindGroup: GPUBindGroup;
      vertexCount: number;
    }
    const triDraws: TriDraw[] = [];
    for (const [texId, indices] of groups) {
      const src = job.textures[texId]!;
      const texture = device.createTexture({
        size: [src.width, src.height],
        format: COLOR_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      cleanup.push(texture);
      // writeTexture has no 256-byte row alignment requirement (unlike buffer copies).
      device.queue.writeTexture(
        { texture },
        src.rgba,
        { bytesPerRow: src.width * 4 },
        [src.width, src.height],
      );

      const data = new Float32Array(indices.length * 3 * 6);
      let o = 0;
      for (const i of indices) {
        for (const v of job.tris[i]!.v) {
          data[o++] = v.x;
          data[o++] = v.y;
          data[o++] = v.z;
          data[o++] = v.u;
          data[o++] = v.v;
          data[o++] = job.tris[i]!.shade;
        }
      }
      const buffer = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      cleanup.push(buffer);
      device.queue.writeBuffer(buffer, 0, data);

      triDraws.push({
        buffer,
        vertexCount: indices.length * 3,
        bindGroup: device.createBindGroup({
          layout: ctx.triPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: ctx.sampler },
            { binding: 2, resource: texture.createView() },
          ],
        }),
      });
    }

    // Batch consecutive same-depth-mode lines so array order is preserved exactly.
    interface LineBatch {
      depthTest: boolean;
      buffer: GPUBuffer;
      vertexCount: number;
    }
    const lineBatches: LineBatch[] = [];
    let runStart = 0;
    while (runStart < job.lines.length) {
      const mode = job.lines[runStart]!.depthTest;
      let runEnd = runStart + 1;
      while (runEnd < job.lines.length && job.lines[runEnd]!.depthTest === mode) runEnd++;
      const data = new Float32Array((runEnd - runStart) * 2 * 7);
      let o = 0;
      for (let i = runStart; i < runEnd; i++) {
        const line = job.lines[i]!;
        const { ax, ay, bx, by } = snapLine(line.a, line.b);
        const [r, g, b, a] = line.rgba;
        data[o++] = ax;
        data[o++] = ay;
        data[o++] = line.a.z;
        data[o++] = r / 255;
        data[o++] = g / 255;
        data[o++] = b / 255;
        data[o++] = a / 255;
        data[o++] = bx;
        data[o++] = by;
        data[o++] = line.b.z;
        data[o++] = r / 255;
        data[o++] = g / 255;
        data[o++] = b / 255;
        data[o++] = a / 255;
      }
      const buffer = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      cleanup.push(buffer);
      device.queue.writeBuffer(buffer, 0, data);
      lineBatches.push({ depthTest: mode, buffer, vertexCount: (runEnd - runStart) * 2 });
      runStart = runEnd;
    }
    const lineBindGroupFor = (pipeline: GPURenderPipeline): GPUBindGroup =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniform } }],
      });
    const depthLineBindGroup = lineBindGroupFor(ctx.lineDepthPipeline);
    const overlayLineBindGroup = lineBindGroupFor(ctx.lineOverlayPipeline);

    const colorTarget = device.createTexture({
      size: [width, height],
      format: COLOR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    cleanup.push(colorTarget);
    const depthTarget = device.createTexture({
      size: [width, height],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    cleanup.push(depthTarget);

    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const readback = device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    cleanup.push(readback);

    const [cr, cg, cb, ca] = job.clear;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: colorTarget.createView(),
          loadOp: 'clear',
          clearValue: { r: cr / 255, g: cg / 255, b: cb / 255, a: ca / 255 },
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthTarget.createView(),
        depthLoadOp: 'clear',
        depthClearValue: 1,
        depthStoreOp: 'discard',
      },
    });
    if (triDraws.length > 0) {
      pass.setPipeline(ctx.triPipeline);
      for (const draw of triDraws) {
        pass.setBindGroup(0, draw.bindGroup);
        pass.setVertexBuffer(0, draw.buffer);
        pass.draw(draw.vertexCount);
      }
    }
    for (const batch of lineBatches) {
      pass.setPipeline(batch.depthTest ? ctx.lineDepthPipeline : ctx.lineOverlayPipeline);
      pass.setBindGroup(0, batch.depthTest ? depthLineBindGroup : overlayLineBindGroup);
      pass.setVertexBuffer(0, batch.buffer);
      pass.draw(batch.vertexCount);
    }
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: colorTarget },
      { buffer: readback, bytesPerRow },
      [width, height],
    );
    device.queue.submit([encoder.finish()]);

    const validationError = await device.popErrorScope();
    if (validationError) {
      throw new Error(`webgpu renderScene: validation error from Dawn: ${validationError.message}`);
    }

    await readback.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(readback.getMappedRange());
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      out.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    }
    readback.unmap();
    return out;
  } finally {
    for (const resource of cleanup) {
      try {
        resource.destroy();
      } catch {
        // Best-effort per-job cleanup; the device owns anything we miss.
      }
    }
  }
}

/**
 * TEST-ONLY: the live singleton device (null before init / after a loss). Exposed so the
 * spontaneous device-loss recovery path (the device.lost handler clearing the cached
 * context, letting the next renderScene re-initialize) can be exercised; production code
 * must never call this.
 */
export function _liveDeviceForTests(): GPUDevice | null {
  return liveContext?.device ?? null;
}

/**
 * Creates the WebGPU backend, initializing the lazy singleton device (so failures surface
 * here, where selectBackend can fall back). All instances share the singleton; dispose()
 * destroys it globally — the next createWebGpuBackend() re-initializes.
 */
export async function createWebGpuBackend(): Promise<RenderBackend> {
  await acquireContext();
  return {
    name: 'webgpu',
    async renderScene(job: SceneJob): Promise<Uint8ClampedArray> {
      const ctx = await acquireContext();
      return renderSceneGpu(ctx, job);
    },
    dispose(): void {
      destroyContext();
    },
  };
}
