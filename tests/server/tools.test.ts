/**
 * MCP server wiring tests through InMemoryTransport + the SDK Client: tool registry,
 * lifecycle flows, validation surfacing in mutate responses, the JSON escape hatch
 * (incl. test-op rollback), error texts, and the no-game-install corpus path.
 *
 * Render determinism is pinned elsewhere; here the renderer is forced to 'software' so
 * the suite never depends on a GPU.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer, type BuildServerOpts } from '../../src/server.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

async function connect(opts: BuildServerOpts = { renderer: 'software' }) {
  const server = buildServer(opts);
  const client = new Client({ name: 'tools-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  return { server, client, call };
}

/** Asserts success and parses the (single) JSON text content item. */
function payload(res: ToolResult): Record<string, unknown> {
  expect(res.isError ?? false).toBe(false);
  const item = res.content.find((c) => c.type === 'text');
  expect(item?.text).toBeTypeOf('string');
  return JSON.parse(item!.text!) as Record<string, unknown>;
}

/** Asserts failure and returns the error text. */
function errorText(res: ToolResult): string {
  expect(res.isError).toBe(true);
  const item = res.content.find((c) => c.type === 'text');
  return item?.text ?? '';
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const EXPECTED_TOOLS = [
  'shape_open', 'shape_create', 'shape_save', 'shape_close', 'shape_list_open',
  'doc_undo', 'doc_redo', 'doc_history',
  'shape_describe', 'shape_measure', 'shape_find',
  'element_add', 'element_edit', 'element_rename', 'element_reparent', 'element_mirror',
  'element_scale', 'element_delete', 'element_duplicate', 'element_import',
  'anim_list', 'anim_describe',
  'anim_create', 'anim_delete', 'anim_edit_meta', 'anim_set_keyframe', 'anim_delete_keyframe',
  'anim_adjust', 'anim_retime', 'anim_mirror_phase',
  'uv_report', 'uv_set_face', 'uv_auto', 'face_set',
  'render_views', 'render_filmstrip', 'render_gif',
  'palette_extract',
  'validate_run',
  'corpus_search', 'corpus_describe',
  'doc_get_json', 'doc_patch_json', 'doc_script',
] as const;

describe('tools/list', () => {
  it('exposes the full tool set, every tool described, schemas carrying units/conventions', async () => {
    const { server, client } = await connect();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([...EXPECTED_TOOLS].sort());
      for (const tool of tools) {
        expect(tool.description, `tool ${tool.name} has no description`).toBeTypeOf('string');
        expect(tool.description!.length, `tool ${tool.name} description is empty`).toBeGreaterThan(20);
      }
      // The schema is the agent docs: units and conventions must be in the field descriptions.
      const schemaOf = (name: string): string =>
        JSON.stringify(tools.find((t) => t.name === name)!.inputSchema);
      expect(schemaOf('element_add')).toContain('1/16-block');
      expect(schemaOf('anim_set_keyframe')).toContain('1/16-block');
      expect(schemaOf('anim_set_keyframe')).toContain('degrees');
      expect(schemaOf('render_views')).toMatch(/north = .Z/); // north = −Z convention
      expect(schemaOf('render_views')).toContain('looks AT');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle + edit flows (one connected pair for the whole suite, like a real session)
// ---------------------------------------------------------------------------

describe('server flows', () => {
  let server: Awaited<ReturnType<typeof connect>>['server'];
  let client: Client;
  let call: Awaited<ReturnType<typeof connect>>['call'];
  let tmp: string;

  beforeAll(async () => {
    ({ server, client, call } = await connect());
    tmp = mkdtempSync(join(tmpdir(), 'vs-shapes-mcp-test-'));
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('shape_create → element_add → shape_describe', async () => {
    const created = payload(await call('shape_create', {}));
    expect(created['docId']).toBe('d1');
    expect(created['textureWidth']).toBe(32);
    expect(created['elements']).toBe(0);

    const added = payload(
      await call('element_add', {
        docId: 'd1',
        name: 'body',
        from: [0, 0, 0],
        to: [4, 4, 4],
        faces: 'none',
      }),
    );
    expect(added['summary']).toBe("element_add 'body'");
    expect(added['added']).toBe('body');
    const validation = added['validation'] as { errors: unknown[]; warnings: unknown[] };
    expect(validation.errors).toEqual([]);

    payload(
      await call('element_add', {
        docId: 'd1',
        name: 'leg',
        parent: 'body',
        from: [1, -4, 1],
        to: [2, 0, 2],
        faces: 'none',
      }),
    );

    const summary = payload(await call('shape_describe', { docId: 'd1' }));
    expect(summary['elements']).toBe(2);
    expect(summary['rootElements']).toEqual(['body']);

    const tree = payload(await call('shape_describe', { docId: 'd1', level: 'tree' }));
    const roots = tree['elements'] as { name: string; children?: { name: string }[] }[];
    expect(roots[0]!.name).toBe('body');
    expect(roots[0]!.children![0]!.name).toBe('leg');

    const detail = payload(
      await call('shape_describe', { docId: 'd1', level: 'element', element: 'leg' }),
    );
    expect(detail['parent']).toBe('body');
  });

  it('dangling texture keys on an empty map are notes, surfaced by validate_run', async () => {
    // auto-uv faces default to '#skin', which is missing from the EMPTY textures map.
    // The engine resolves face keys against the consuming type's texture source and never
    // throws for a map miss, so this is a NOTE (empty map = type-supplied pattern) — it
    // must NOT flood the mutating response's errors/warnings.
    const res = payload(
      await call('element_add', {
        docId: 'd1',
        name: 'untextured',
        from: [0, 8, 0],
        to: [4, 12, 4],
        faces: 'auto-uv',
      }),
    );
    const validation = res['validation'] as {
      errors: { code: string }[];
      warnings: { code: string }[];
    };
    expect(validation.errors.some((e) => e.code === 'tex/dangling-key')).toBe(false);
    expect(validation.warnings.some((e) => e.code === 'tex/dangling-key')).toBe(false);
    const report = payload(await call('validate_run', { docId: 'd1' }));
    const findings = report['findings'] as { code: string; severity: string; message: string }[];
    const note = findings.find((f) => f.code === 'tex/dangling-key');
    expect(note?.severity).toBe('note');
    expect(note?.message).toContain('untextured');

    // Fix it through the escape hatch, then re-validate clean.
    payload(
      await call('doc_patch_json', {
        docId: 'd1',
        patch: [{ op: 'add', path: '/textures/skin', value: 'entity/test/skin' }],
      }),
    );
    const clean = payload(await call('validate_run', { docId: 'd1' }));
    expect((clean['counts'] as { errors: number }).errors).toBe(0);
    expect(
      (payload(await call('validate_run', { docId: 'd1' }))['findings'] as { code: string }[]).some(
        (f) => f.code === 'tex/dangling-key',
      ),
    ).toBe(false);
  });

  it('shape_measure reports blocks and 1/16 units', async () => {
    const res = payload(await call('shape_measure', { docId: 'd1', elements: ['untextured'] }));
    const per = res['perElement'] as Record<string, { blocks: { size: number[] }; units16: { size: number[] } }>;
    expect(per['untextured']!.blocks.size).toEqual([0.25, 0.25, 0.25]);
    expect(per['untextured']!.units16.size).toEqual([4, 4, 4]);
  });

  it('shape_find matches name globs case-insensitively', async () => {
    const res = payload(await call('shape_find', { docId: 'd1', glob: 'B?dy' }));
    expect((res['matches'] as { name: string }[]).map((m) => m.name)).toEqual(['body']);
    const all = payload(await call('shape_find', { docId: 'd1', glob: '*' }));
    expect(all['count']).toBe(3);
  });

  it('anim_create → anim_set_keyframe → element_rename cascades into keyframes', async () => {
    payload(await call('anim_create', { docId: 'd1', code: 'walk', quantityFrames: 10 }));
    const kf = payload(
      await call('anim_set_keyframe', {
        docId: 'd1',
        code: 'walk',
        frame: 0,
        element: 'body',
        rotation: [0, 0, 10],
      }),
    );
    expect(kf['entry']).toEqual({ rotationX: 0, rotationY: 0, rotationZ: 10 });

    const renamed = payload(
      await call('element_rename', { docId: 'd1', oldName: 'body', newName: 'torso' }),
    );
    expect(renamed['keyframesUpdated']).toBe(1);
    expect(renamed['animationsUpdated']).toEqual(['walk']);

    const elements = payload(
      await call('doc_get_json', { docId: 'd1', jsonPointer: '/animations/0/keyframes/0/elements' }),
    );
    expect(Object.keys(elements)).toEqual(['torso']);
  });

  it('doc_undo / doc_redo round-trip the rename (keyframes included)', async () => {
    const undone = payload(await call('doc_undo', { docId: 'd1' }));
    expect(undone['undone']).toBe("element_rename 'body' -> 'torso'");
    const elements = payload(
      await call('doc_get_json', { docId: 'd1', jsonPointer: '/animations/0/keyframes/0/elements' }),
    );
    expect(Object.keys(elements)).toEqual(['body']);

    const redone = payload(await call('doc_redo', { docId: 'd1' }));
    expect(redone['redone']).toBe("element_rename 'body' -> 'torso'");
    const again = payload(
      await call('doc_get_json', { docId: 'd1', jsonPointer: '/animations/0/keyframes/0/elements' }),
    );
    expect(Object.keys(again)).toEqual(['torso']);
  });

  it('doc_history lists each tool call as one transaction', async () => {
    const res = payload(await call('doc_history', { docId: 'd1' }));
    const history = res['history'] as { summary: string; at: number }[];
    const summaries = history.map((h) => h.summary);
    expect(summaries).toContain("element_add 'body'");
    expect(summaries).toContain("anim_create 'walk'");
    expect(summaries.at(-1)).toBe("element_rename 'body' -> 'torso'");
    // monotonic sequence numbers
    for (let i = 1; i < history.length; i++) expect(history[i]!.at).toBeGreaterThan(history[i - 1]!.at);
  });

  it('doc_patch_json: a failed test op rolls the whole patch back atomically', async () => {
    const before = payload(await call('doc_history', { docId: 'd1' }));
    const res = await call('doc_patch_json', {
      docId: 'd1',
      patch: [
        { op: 'replace', path: '/elements/0/name', value: 'zzz' },
        { op: 'test', path: '/elements/0/name', value: 'NOT-THE-NAME' },
      ],
    });
    const text = errorText(res);
    expect(text).toMatch(/\(test\).*failed at '\/elements\/0\/name'/);
    expect(text).toContain('rolled back');
    // RFC-6902: a test op sees the effect of PRIOR ops in the same patch — the error
    // names 'zzz' (the just-replaced value), and then the whole patch rolls back.
    expect(text).toContain('zzz');

    // The earlier replace op must have been rolled back with the failing test.
    const name = payload(await call('doc_get_json', { docId: 'd1', jsonPointer: '/elements/0/name' }));
    expect(name).toBe('torso');
    // …and the failed patch must not appear in history.
    const after = payload(await call('doc_history', { docId: 'd1' }));
    expect((after['history'] as unknown[]).length).toBe((before['history'] as unknown[]).length);
  });

  it('doc_patch_json: add/move/copy/test with array indices and "-" append', async () => {
    // Root elements at this point: [torso, untextured].
    const res = payload(
      await call('doc_patch_json', {
        docId: 'd1',
        patch: [
          { op: 'test', path: '/elements/0/name', value: 'torso' },
          { op: 'add', path: '/elements/-', value: { name: 'tail', from: [0, 0, 4], to: [1, 1, 8] } },
          { op: 'copy', from: '/elements/2/from', path: '/elements/2/rotationOrigin' },
          { op: 'replace', path: '/elements/2/from/0', value: 2.5 },
          { op: 'move', from: '/elements/2', path: '/elements/0' },
        ],
      }),
    );
    expect(res['opsApplied']).toBe(5);
    expect(res['summary']).toBe('doc_patch_json (5 ops)');
    expect(res['validation']).toBeDefined();

    const roots = payload(await call('doc_get_json', { docId: 'd1', jsonPointer: '/elements' })) as unknown as {
      name: string;
      from: number[];
      rotationOrigin?: number[];
    }[];
    expect(roots.map((r) => r.name)).toEqual(['tail', 'torso', 'untextured']);
    expect(roots[0]!.from).toEqual([2.5, 0, 4]); // fresh number landed as a plain 2.5
    expect(roots[0]!.rotationOrigin).toEqual([0, 0, 4]); // copied BEFORE the replace touched from[0]

    // One transaction: a single undo removes the whole 5-op patch.
    payload(await call('doc_undo', { docId: 'd1' }));
    const undone = payload(await call('doc_get_json', { docId: 'd1', jsonPointer: '/elements' })) as unknown as {
      name: string;
    }[];
    expect(undone.map((r) => r.name)).toEqual(['torso', 'untextured']);
    payload(await call('doc_redo', { docId: 'd1' }));
  });

  it('doc_patch_json rejects bad pointers with errors naming the spot', async () => {
    const res = await call('doc_patch_json', {
      docId: 'd1',
      patch: [{ op: 'replace', path: '/elements/99/name', value: 'x' }],
    });
    expect(errorText(res)).toMatch(/index 99 is out of range.*valid indices 0\.\.2/);

    const res2 = await call('doc_patch_json', {
      docId: 'd1',
      patch: [{ op: 'remove', path: 'elements/0' }],
    });
    expect(errorText(res2)).toContain("must start with '/'");

    const res3 = await call('doc_patch_json', {
      docId: 'd1',
      patch: [{ op: 'replace', path: '', value: {} }],
    });
    expect(errorText(res3)).toContain("cannot be written to");
  });

  it('doc_get_json returns plain JSON (VsNum unwrapped) for any pointer', async () => {
    const whole = payload(await call('doc_get_json', { docId: 'd1' }));
    expect(whole['textureWidth']).toBe(32); // a number, not a VsNum wrapper object
    const frame = payload(
      await call('doc_get_json', { docId: 'd1', jsonPointer: '/animations/0/quantityframes' }),
    );
    expect(frame).toBe(10);
  });

  it('uv_set_face + uv_report', async () => {
    const set = payload(
      await call('uv_set_face', { docId: 'd1', element: 'torso', face: 'north', uv: [0, 0, 4, 4], rotation: 90 }),
    );
    expect((set['faceJson'] as { uv: number[]; rotation: number }).rotation).toBe(90);
    const report = payload(await call('uv_report', { docId: 'd1' }));
    const sheets = report['report'] as { textureKey: string; faces: unknown[] }[];
    expect(sheets.some((s) => s.faces.length > 0)).toBe(true);
  });

  it('element_delete refuses keyframed elements without force, then strips with force', async () => {
    const refuse = await call('element_delete', { docId: 'd1', name: 'torso' });
    expect(errorText(refuse)).toContain("'walk'");
    expect(errorText(refuse)).toContain('force');

    const forced = payload(await call('element_delete', { docId: 'd1', name: 'torso', force: true }));
    expect(forced['strippedFrom']).toEqual([{ animation: 'walk', frames: [0] }]);
    payload(await call('doc_undo', { docId: 'd1' })); // put it back for later tests
  });

  it('anim_retime moves keyframes proportionally', async () => {
    payload(await call('anim_set_keyframe', { docId: 'd1', code: 'walk', frame: 5, element: 'torso', offset: [0, 1, 0] }));
    const res = payload(await call('anim_retime', { docId: 'd1', code: 'walk', quantityFrames: 20 }));
    expect(res['mapping']).toEqual([
      { from: 0, to: 0 },
      { from: 5, to: 10 },
    ]);
  });

  it('shape_save → shape_open round-trips through a real file', async () => {
    const target = join(tmp, 'sub', 'created.json');
    const saved = payload(await call('shape_save', { docId: 'd1', path: target }));
    expect(saved['savedTo']).toBe(target);
    expect(readFileSync(target, 'utf8')).toContain('"torso"');

    const reopened = payload(await call('shape_open', { path: target }));
    const docId2 = reopened['docId'] as string;
    expect(docId2).not.toBe('d1');
    const tree = payload(await call('doc_get_json', { docId: docId2, jsonPointer: '/elements/1/name' }));
    expect(tree).toBe('torso');

    const list = payload(await call('shape_list_open', {}));
    const open = list['open'] as { docId: string; dirty: boolean; savePath: string | null }[];
    expect(open.map((o) => o.docId)).toContain(docId2);
    for (const o of open) expect(o.dirty).toBe(false); // d1 just saved, d2 just opened

    const closed = payload(await call('shape_close', { docId: docId2 }));
    expect(closed['hadUnsavedChanges']).toBe(false);
    const res = await call('shape_describe', { docId: docId2 });
    expect(errorText(res)).toContain(`No open document with id '${docId2}'`);
  });

  it('element_import kitbashes between two open documents (textures travel along)', async () => {
    const other = payload(await call('shape_create', {})) as { docId: string };
    payload(
      await call('element_add', {
        docId: other.docId,
        name: 'hat',
        from: [0, 0, 0],
        to: [4, 2, 4],
        faces: { up: { texture: 'wool', uv: [0, 0, 4, 4] } },
      }),
    );
    payload(
      await call('doc_patch_json', {
        docId: other.docId,
        patch: [{ op: 'add', path: '/textures/wool', value: 'block/wool' }],
      }),
    );
    const imported = payload(
      await call('element_import', { docId: 'd1', fromDocId: other.docId, name: 'hat', parent: 'torso' }),
    );
    expect(imported['texturesCopied']).toEqual(['wool']);
    const textures = payload(await call('doc_get_json', { docId: 'd1', jsonPointer: '/textures' }));
    expect(textures).toMatchObject({ wool: 'block/wool' });
    payload(await call('shape_close', { docId: other.docId }));
  });

  it('render_views renders without any textures (flat fallback + footnote)', async () => {
    const res = await call('render_views', { docId: 'd1', views: ['n'], size: 64 });
    expect(res.isError ?? false).toBe(false);
    const image = res.content.find((c) => c.type === 'image');
    expect(image).toBeDefined();
    expect(image!.mimeType).toBe('image/png');
    const png = Buffer.from(image!.data!, 'base64');
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const caption = res.content.find((c) => c.type === 'text')!.text!;
    expect(caption).toContain('views n');
    expect(caption).toContain('backend software');
    // '#skin' / '#wool' have no PNG on disk → the footnote must say so.
    expect(caption).toMatch(/no texture PNG found/i);
  });

  it('unknown docId errors are actionable', async () => {
    // d-shaped refs hit the session registry and list the known ids…
    const unknownId = errorText(await call('shape_describe', { docId: 'd99' }));
    expect(unknownId).toContain("No open document with id 'd99'");
    expect(unknownId).toContain('d1'); // lists the known ids
    expect(unknownId).toContain('shape_open');
    // …anything else is a stateless file ref; a missing file names the alternatives.
    const missingFile = errorText(await call('shape_describe', { docId: 'nope' }));
    expect(missingFile).toContain('cannot read');
    expect(missingFile).toContain("'corpus:<path>'");
  });

  it('unknown element errors carry near-miss suggestions', async () => {
    const res = await call('element_edit', { docId: 'd1', name: 'torsoo', from: [0, 0, 0] });
    const text = errorText(res);
    expect(text).toContain("'torsoo'");
    expect(text).toContain("'torso'"); // did-you-mean
  });
});

// ---------------------------------------------------------------------------
// Hardening pins (confirmed review findings)
// ---------------------------------------------------------------------------

describe('server hardening', () => {
  let server: Awaited<ReturnType<typeof connect>>['server'];
  let client: Client;
  let call: Awaited<ReturnType<typeof connect>>['call'];
  let tmp: string;

  beforeAll(async () => {
    ({ server, client, call } = await connect());
    tmp = mkdtempSync(join(tmpdir(), 'vs-shapes-mcp-hardening-'));
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('tool errors carry the plain actionable message — no protocol-level "MCP error" prefix', async () => {
    const res = await call('shape_describe', { docId: 'd99' });
    const text = errorText(res);
    expect(text.startsWith('MCP error')).toBe(false);
    expect(text).toContain("No open document with id 'd99'");
  });

  it('doc_patch_json cannot break the parse-time structural invariants: the patch rolls back', async () => {
    const created = payload(await call('shape_create', {}));
    const docId = created['docId'] as string;
    payload(
      await call('element_add', { docId, name: 'body', from: [0, 0, 0], to: [4, 4, 4], faces: 'none' }),
    );

    for (const value of ['oops', [42]]) {
      const res = await call('doc_patch_json', {
        docId,
        patch: [{ op: 'replace', path: '/elements', value }],
      });
      expect(errorText(res)).toContain('rolled back');
      // The document is intact: every traversing tool still works…
      const summary = payload(await call('shape_describe', { docId }));
      expect(summary['elements']).toBe(1);
      // …and so does the session-wide registry listing (no bricked session).
      payload(await call('shape_list_open', {}));
    }

    const anims = await call('doc_patch_json', {
      docId,
      patch: [{ op: 'add', path: '/animations', value: 'nope' }],
    });
    expect(errorText(anims)).toContain('"animations"');
    expect(payload(await call('anim_list', { docId }))['animations']).toEqual([]);
    payload(await call('shape_close', { docId }));
  });

  it('a failed shape_open never leaks a zombie registration (registry keeps working)', async () => {
    const before = (payload(await call('shape_list_open', {}))['open'] as unknown[]).length;
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, '{ "elements": [ 42 ] }', 'utf8');
    const res = await call('shape_open', { path: bad });
    expect(res.isError).toBe(true);
    const after = payload(await call('shape_list_open', {}))['open'] as unknown[];
    expect(after.length).toBe(before); // no zombie doc registered
  });

  it('shape_open preserves a leading BOM: unedited save is byte-identical (lossless contract)', async () => {
    const file = join(tmp, 'bom.json');
    const original = '﻿{\r\n\t"textureWidth": 16,\r\n\t"elements": []\r\n}';
    writeFileSync(file, original, 'utf8');
    const opened = payload(await call('shape_open', { path: file }));
    const docId = opened['docId'] as string;
    const saved = join(tmp, 'bom-saved.json');
    payload(await call('shape_save', { docId, path: saved }));
    expect(readFileSync(saved, 'utf8')).toBe(original);
    payload(await call('shape_close', { docId }));
  });

  it('doc_get_json caps oversized responses with an actionable per-child size error', async () => {
    const created = payload(await call('shape_create', {}));
    const docId = created['docId'] as string;
    payload(
      await call('doc_patch_json', {
        docId,
        patch: [{ op: 'add', path: '/editor/blob', value: 'x'.repeat(120_000) }],
      }),
    );
    const res = await call('doc_get_json', { docId });
    const text = errorText(res);
    expect(text).toContain('response cap');
    expect(text).toContain("'/editor'"); // names the oversized child with its size
    // Narrow pointers still work.
    const w = payload(await call('doc_get_json', { docId, jsonPointer: '/textureWidth' }));
    expect(w).toBe(32);
    payload(await call('shape_close', { docId }));
  });

  it('read-only operations do not commit transactions: the redo chain survives a verify step', async () => {
    const created = payload(await call('shape_create', {}));
    const docId = created['docId'] as string;
    payload(
      await call('element_add', { docId, name: 'body', from: [0, 0, 0], to: [4, 4, 4], faces: 'none' }),
    );
    payload(await call('doc_undo', { docId }));
    // Natural agent pattern: verify state with a pure 'test' op after the undo…
    payload(
      await call('doc_patch_json', { docId, patch: [{ op: 'test', path: '/textureWidth', value: 32 }] }),
    );
    // …and a field-less element_edit-style no-op must not clear the redo stack either.
    const redone = payload(await call('doc_redo', { docId }));
    expect(redone['redone']).toBe("element_add 'body'");
    expect(payload(await call('shape_describe', { docId }))['elements']).toBe(1);
    // doc_history is not littered with the no-op entry.
    const history = payload(await call('doc_history', { docId }))['history'] as { summary: string }[];
    expect(history.map((h) => h.summary)).toEqual(["element_add 'body'"]);
    payload(await call('shape_close', { docId }));
  });

  it('uv_report summary mode returns counts + capped problem lists', async () => {
    const created = payload(await call('shape_create', {}));
    const docId = created['docId'] as string;
    payload(
      await call('element_add', { docId, name: 'a', from: [0, 0, 0], to: [4, 4, 4], faces: 'auto-uv' }),
    );
    payload(
      await call('element_add', { docId, name: 'b', from: [0, 0, 0], to: [4, 4, 4], faces: 'auto-uv' }),
    );
    const full = payload(await call('uv_report', { docId }));
    const fullSheets = full['report'] as { faces: unknown[] }[];
    expect(Array.isArray(fullSheets[0]!.faces)).toBe(true);
    const sum = payload(await call('uv_report', { docId, summary: true }));
    const sheets = sum['report'] as { faces: number; overlapsCount: number }[];
    expect(sheets[0]!.faces).toBe(12);
    expect(sheets[0]!.overlapsCount).toBeGreaterThan(0); // identical auto-uv rects overlap
    const filtered = payload(await call('uv_report', { docId, elements: ['a'], summary: true }));
    expect((filtered['report'] as { faces: number }[])[0]!.faces).toBe(6);
    payload(await call('shape_close', { docId }));
  });
});

// ---------------------------------------------------------------------------
// Corpus tools without a game install
// ---------------------------------------------------------------------------

describe('corpus tools with no game install', () => {
  const saved = {
    appdata: process.env['APPDATA'],
    vintageStory: process.env['VINTAGE_STORY'],
  };
  let emptyDir: string;

  beforeAll(() => {
    emptyDir = mkdtempSync(join(tmpdir(), 'vs-shapes-mcp-noinstall-'));
    process.env['APPDATA'] = emptyDir; // %APPDATA%/Vintagestory will not exist
    delete process.env['VINTAGE_STORY'];
  });

  afterEach(() => {
    // (re)stub in case a test body re-set them
    process.env['APPDATA'] = emptyDir;
    delete process.env['VINTAGE_STORY'];
  });

  afterAll(() => {
    if (saved.appdata === undefined) delete process.env['APPDATA'];
    else process.env['APPDATA'] = saved.appdata;
    if (saved.vintageStory === undefined) delete process.env['VINTAGE_STORY'];
    else process.env['VINTAGE_STORY'] = saved.vintageStory;
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('pure editing works, corpus tools fail clearly naming --game-path', async () => {
    const { server, client, call } = await connect({ renderer: 'software' });
    try {
      // The server runs fine for editing with no install at all.
      const created = payload(await call('shape_create', {}));
      expect(created['docId']).toBe('d1');

      const search = await call('corpus_search', { query: 'fox' });
      const text = errorText(search);
      expect(text).toContain('--game-path');
      expect(text).toContain('no game install was found');

      const describeRes = await call('corpus_describe', { path: 'entity/animal/mammal/fox/fox-male' });
      expect(errorText(describeRes)).toContain('--game-path');

      const openRes = await call('shape_open', { path: 'corpus:entity/animal/mammal/fox/fox-male' });
      expect(errorText(openRes)).toContain('--game-path');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
