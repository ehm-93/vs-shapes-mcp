/**
 * Server-level pins for the quick-wins batch: face_set, render savePath export,
 * grouped validation in mutate responses, anim_create anchorElements, uv_auto summary
 * mode, and the anim_set_keyframe / anim_mirror_phase parameter additions.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../../src/server.js';

interface ContentItem {
  type: string;
  text?: string;
  data?: string;
}
interface ToolResult {
  content: ContentItem[];
  isError?: boolean;
}

async function connect() {
  const server = buildServer({ renderer: 'software' });
  const client = new Client({ name: 'quickwins-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  return { client, call };
}

function payload(res: ToolResult): Record<string, unknown> {
  expect(res.isError ?? false, res.content.find((c) => c.type === 'text')?.text ?? '').toBe(false);
  return JSON.parse(res.content.find((c) => c.type === 'text')!.text!) as Record<string, unknown>;
}

const tmp = mkdtempSync(join(tmpdir(), 'vs-shapes-quickwins-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Fresh doc with a body + child leg, two texture keys. */
async function rigDoc(call: Awaited<ReturnType<typeof connect>>['call']): Promise<string> {
  const created = payload(await call('shape_create', { textureWidth: 32, textureHeight: 32 }));
  const docId = created['docId'] as string;
  await call('doc_patch_json', {
    docId,
    patch: [
      { op: 'add', path: '/textures/skin', value: 'entity/test/skin' },
      { op: 'add', path: '/textures/dark', value: 'entity/test/dark' },
    ],
  });
  payload(await call('element_add', { docId, name: 'body', from: [4, 4, 6], to: [8, 8, 10] }));
  payload(await call('element_add', { docId, parent: 'body', name: 'leg', from: [0, -4, 0], to: [1, 0, 1] }));
  return docId;
}

describe('face_set', () => {
  it('bulk-retextures a subtree and sets glow, end to end', async () => {
    const { client, call } = await connect();
    try {
      const docId = await rigDoc(call);
      const result = payload(
        await call('face_set', { docId, elements: ['body'], subtree: true, texture: 'dark', glow: 120 }),
      );
      expect(result['facesUpdated']).toBe(12); // body 6 + leg 6 (auto-uv faces)
      const leg = payload(await call('shape_describe', { docId, level: 'element', element: 'leg' }))[
        'element'
      ] as Record<string, { texture?: string; glow?: number }>;
      const faces = (leg as unknown as { faces: Record<string, { texture: string; glow?: number }> }).faces;
      expect(faces['north']!.texture).toBe('#dark');
      expect(faces['north']!.glow).toBe(120);
    } finally {
      await client.close();
    }
  });

  it('selects elements by name glob, setting a field across every match in one call', async () => {
    const { client, call } = await connect();
    try {
      const docId = await rigDoc(call);
      // two more legs so a glob spans several elements (rigDoc already has 'leg')
      payload(await call('element_add', { docId, parent: 'body', name: 'legFrontLeft', from: [0, -4, 0], to: [1, 0, 1] }));
      payload(await call('element_add', { docId, parent: 'body', name: 'legFrontRight', from: [2, -4, 0], to: [3, 0, 1] }));

      // 'leg*' is case-insensitive and matches leg, legFrontLeft, legFrontRight — not body.
      const result = payload(await call('face_set', { docId, elements: ['leg*'], faces: ['north'], glow: 255 }));
      expect(result['facesUpdated']).toBe(3);
      expect(Object.keys(result['updated'] as object).sort()).toEqual([
        'leg',
        'legFrontLeft',
        'legFrontRight',
      ]);

      // A glob matching nothing is an error naming the glob (not a silent no-op).
      const miss = await call('face_set', { docId, elements: ['zzz*'], glow: 10 });
      expect(miss.isError).toBe(true);
      expect(miss.content.find((c) => c.type === 'text')?.text).toMatch(/glob 'zzz\*' matched no elements/);
    } finally {
      await client.close();
    }
  });
});

describe('render savePath export', () => {
  it('writes the PNG to disk and returns text-only (no inline image)', async () => {
    const { client, call } = await connect();
    try {
      const docId = await rigDoc(call);
      const out = join(tmp, 'export', 'rig-views.png');
      const res = await call('render_views', { docId, views: ['sw'], size: 64, savePath: out });
      expect(res.isError ?? false).toBe(false);
      expect(res.content.some((c) => c.type === 'image')).toBe(false);
      expect(res.content[0]!.text).toMatch(/Saved render to/);
      expect(existsSync(out)).toBe(true);
      // PNG magic bytes
      const head = readFileSync(out).subarray(0, 4);
      expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      await client.close();
    }
  });
});

describe('render_gif', () => {
  it('returns an inline GIF, and writes one to disk via savePath', async () => {
    const { client, call } = await connect();
    try {
      const docId = await rigDoc(call);
      await call('anim_create', { docId, code: 'spin', quantityFrames: 8, anchorElements: ['body'] });
      await call('anim_set_keyframe', { docId, code: 'spin', frame: 4, element: 'body', rotation: [0, 90, 0] });

      const inline = await call('render_gif', { docId, anim: 'spin', frames: 6, size: 48 });
      expect(inline.isError ?? false).toBe(false);
      const img = inline.content.find((c) => c.type === 'image');
      expect(img?.mimeType).toBe('image/gif');
      expect(Buffer.from(img!.data!, 'base64').subarray(0, 6).toString('latin1')).toBe('GIF89a');

      const out = join(tmp, 'spin.gif');
      const saved = await call('render_gif', { docId, anim: 'spin', frames: 6, size: 48, savePath: out });
      expect(saved.content.some((c) => c.type === 'image')).toBe(false);
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out).subarray(0, 6).toString('latin1')).toBe('GIF89a');
    } finally {
      await client.close();
    }
  });
});

describe('grouped validation in mutate responses', () => {
  it('collapses repeated same-code findings into one counted entry', async () => {
    const { client, call } = await connect();
    try {
      const docId = await rigDoc(call);
      // 4 empty animations → 4 anim/no-keyframes errors → grouped into one entry with count 4
      for (const code of ['a1', 'a2', 'a3']) {
        await call('anim_create', { docId, code, quantityFrames: 10 });
      }
      const result = payload(await call('anim_create', { docId, code: 'a4', quantityFrames: 10 }));
      const errors = result['validation'] as { errors: { code: string; count?: number }[] };
      const grouped = errors.errors.filter((e) => e.code === 'anim/no-keyframes');
      expect(grouped).toHaveLength(1);
      expect(grouped[0]!.count).toBe(4);
    } finally {
      await client.close();
    }
  });
});

describe('anim_create anchorElements + anim_set_keyframe flags + anim_mirror_phase axis', () => {
  it('seeds frame-0 anchors, writes rotShortestDistance, conjugates the mirrored half', async () => {
    const { client, call } = await connect();
    try {
      const docId = await rigDoc(call);
      const created = payload(
        await call('anim_create', { docId, code: 'walk', quantityFrames: 20, anchorElements: ['body', 'leg'] }),
      );
      expect(created['anchoredAtFrame0']).toEqual(['body', 'leg']);

      payload(
        await call('anim_set_keyframe', {
          docId,
          code: 'walk',
          frame: 5,
          element: 'leg',
          rotation: [10, 20, 30],
          rotShortestDistance: { z: true },
        }),
      );
      payload(await call('anim_mirror_phase', { docId, code: 'walk', pairs: [] }));

      const anim = payload(await call('anim_describe', { docId, code: 'walk' }));
      const kfs = anim['keyframes'] as {
        frame: number;
        elements: Record<string, Record<string, number | boolean>>;
      }[];
      expect(kfs.map((k) => k.frame)).toEqual([0, 5, 10, 15]);
      const f0 = kfs[0]!.elements['leg']!;
      expect([f0['rotationX'], f0['rotationY'], f0['rotationZ']]).toEqual([0, 0, 0]); // the anchor
      expect(f0['offsetY']).toBe(0);
      const f5 = kfs[1]!.elements['leg']!;
      expect(f5['rotShortestDistanceZ']).toBe(true);
      // f15 = conjugated copy of f5: rotX/rotY negate, rotZ holds; flags travel.
      const f15 = kfs[3]!.elements['leg']!;
      expect([f15['rotationX'], f15['rotationY'], f15['rotationZ']]).toEqual([-10, -20, 30]);
      expect(f15['rotShortestDistanceZ']).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('uv_auto summary mode', () => {
  it('returns per-texture counts by default and full rects with detail: true', async () => {
    const { client, call } = await connect();
    try {
      const docId = await rigDoc(call);
      const summary = payload(await call('uv_auto', { docId }));
      expect(summary['packed']).toBe(12);
      expect(summary['faces']).toBeUndefined();
      expect(summary['perTexture']).toHaveProperty('skin');
      const detail = payload(await call('uv_auto', { docId, detail: true }));
      expect((detail['faces'] as unknown[]).length).toBe(12);
    } finally {
      await client.close();
    }
  });
});
