/**
 * End-to-end acceptance over the real MCP wire (InMemoryTransport + SDK Client) against
 * the real game install: open the fox from the corpus, inspect, rename with keyframe
 * cascade, key a pose, render, undo back to pristine, and save byte-identically.
 *
 * Skips cleanly when no Vintage Story install is present.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { resolveGamePath } from '../../src/corpus/corpus.js';
import { buildServer } from '../../src/server.js';

const FOX = 'entity/animal/mammal/fox/fox-male';

let gamePath: string | null = null;
try {
  gamePath = resolveGamePath();
} catch {
  gamePath = null;
}
const foxAbs =
  gamePath === null ? null : join(gamePath, 'assets', 'survival', 'shapes', ...FOX.split('/')) + '.json';
const hasInstall = foxAbs !== null && existsSync(foxAbs);
if (!hasInstall) {
  console.error('tests/acceptance/mcp.test.ts: no Vintage Story install found — skipping.');
}

interface ContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}
interface ToolResult {
  content: ContentItem[];
  isError?: boolean;
}

describe.skipIf(!hasInstall)('MCP end-to-end: fox from the corpus', () => {
  let server: ReturnType<typeof buildServer>;
  let client: Client;
  let tmp: string;
  let docId: string;
  /** The exact text shape_open parsed (the fox file has no BOM; stripped if it had one). */
  let originalText: string;

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as unknown as ToolResult;

  const payload = (res: ToolResult): Record<string, unknown> => {
    expect(res.isError ?? false, res.content.find((c) => c.type === 'text')?.text).toBe(false);
    return JSON.parse(res.content.find((c) => c.type === 'text')!.text!) as Record<string, unknown>;
  };

  beforeAll(async () => {
    // Software renderer: deterministic, no GPU requirement in CI.
    server = buildServer({ renderer: 'software' });
    client = new Client({ name: 'acceptance-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    tmp = mkdtempSync(join(tmpdir(), 'vs-shapes-mcp-acceptance-'));
    const raw = readFileSync(foxAbs!, 'utf8');
    originalText = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('corpus_search finds the fox; corpus_describe reports its stats', async () => {
    const search = payload(await call('corpus_search', { query: 'fox male' }));
    const hits = search['hits'] as { path: string; domain: string }[];
    expect(hits.map((h) => h.path)).toContain(FOX);

    const stats = payload(await call('corpus_describe', { path: FOX }));
    expect(stats['elements']).toBeGreaterThan(10);
    expect((stats['textures'] as Record<string, string>)['skin']).toBe(
      'entity/animal/mammal/fox/red-male',
    );
    const anims = stats['animations'] as { code: string; quantityFrames: number }[];
    expect(anims).toContainEqual({ code: 'walk', quantityFrames: 40 });
  });

  it('shape_open via corpus: prefix', async () => {
    const opened = payload(await call('shape_open', { path: `corpus:${FOX}` }));
    docId = opened['docId'] as string;
    expect(docId).toMatch(/^d\d+$/);
    expect(opened['source']).toBe(`corpus:${FOX}`);
    expect(opened['savePath']).toBeNull(); // corpus shapes are read-only sources
    expect(opened['rootElements']).toEqual(['body']);
    const validation = opened['validation'] as { errors: unknown[] };
    expect(validation.errors).toEqual([]); // vanilla must validate clean
  });

  it('shape_describe(tree) shows the rig', async () => {
    const tree = payload(await call('shape_describe', { docId, level: 'tree' }));
    const roots = tree['elements'] as { name: string; children?: unknown[] }[];
    expect(roots[0]!.name).toBe('body');
    expect(roots[0]!.children!.length).toBeGreaterThan(0);
    expect(JSON.stringify(roots)).toContain('"name":"head"');
  });

  it('element_rename body → torso cascades into every animation keyframe', async () => {
    const renamed = payload(
      await call('element_rename', { docId, oldName: 'body', newName: 'torso' }),
    );
    // Every fox animation keys 'body' at least once (12 animations in 1.22).
    expect(renamed['keyframesUpdated']).toBeGreaterThanOrEqual(12);
    expect(renamed['animationsUpdated']).toContain('walk');
    expect((renamed['validation'] as { errors: unknown[] }).errors).toEqual([]);

    // Verify the cascade on the raw JSON: the walk keyframe now keys 'torso', not 'body'.
    const kfElements = payload(
      await call('doc_get_json', { docId, jsonPointer: '/animations/0/keyframes/0/elements' }),
    );
    expect(Object.keys(kfElements)).toContain('torso');
    expect(Object.keys(kfElements)).not.toContain('body');
  });

  it('anim_set_keyframe poses the renamed element', async () => {
    const res = payload(
      await call('anim_set_keyframe', {
        docId,
        code: 'walk',
        frame: 1,
        element: 'torso',
        rotation: [0, 0, 5],
      }),
    );
    expect(res['entry']).toEqual({ rotationX: 0, rotationY: 0, rotationZ: 5 });
    expect((res['validation'] as { errors: unknown[] }).errors).toEqual([]);
  });

  it('render_views returns an image content item', async () => {
    const res = await call('render_views', {
      docId,
      views: ['e', 'top'],
      anim: 'walk',
      frame: 1,
      size: 160,
    });
    expect(res.isError ?? false).toBe(false);
    const image = res.content.find((c) => c.type === 'image');
    expect(image).toBeDefined();
    expect(image!.mimeType).toBe('image/png');
    const png = Buffer.from(image!.data!, 'base64');
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBeGreaterThan(1000);

    const caption = res.content.find((c) => c.type === 'text')!.text!;
    expect(caption).toContain("anim 'walk'");
    expect(caption).toContain('backend software');
    // The real install resolves the fox skin — no missing-texture footnote.
    expect(caption).not.toMatch(/missing/i);
  });

  it('doc_undo twice restores the pristine document', async () => {
    const first = payload(await call('doc_undo', { docId }));
    expect(first['undone']).toBe("anim_set_keyframe 'walk' f1 'torso'");
    const second = payload(await call('doc_undo', { docId }));
    expect(second['undone']).toBe("element_rename 'body' -> 'torso'");

    const kfElements = payload(
      await call('doc_get_json', { docId, jsonPointer: '/animations/0/keyframes/0/elements' }),
    );
    expect(Object.keys(kfElements)).toContain('body');

    const list = payload(await call('shape_list_open', {}));
    const entry = (list['open'] as { docId: string; dirty: boolean }[]).find((o) => o.docId === docId);
    expect(entry!.dirty).toBe(false); // undo restored the byte-identical state
  });

  it('shape_save writes the original corpus text byte-identically', async () => {
    const target = join(tmp, 'fox-male.json');
    const saved = payload(await call('shape_save', { docId, path: target }));
    expect(saved['savedTo']).toBe(target);

    const savedText = readFileSync(target, 'utf8');
    // THE acceptance gate: parse → rename → keyframe → undo ×2 → serialize is the identity.
    expect(savedText.length).toBe(originalText.length);
    expect(savedText === originalText, 'saved fox-male.json must equal the corpus file byte-for-byte').toBe(
      true,
    );
  });
});
