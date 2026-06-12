/**
 * Stateless (path-addressed) document mode over the real MCP wire: every docId param
 * also accepts a shape .json file path — opened on demand, every mutation auto-saved
 * back to the file, the file re-read when its on-disk text changed — or a read-only
 * 'corpus:' ref. Self-contained calls are what parallel subagent workflows need: no
 * shape_open/docId/shape_save handshake to thread through.
 *
 * Core tests need no game install; the corpus-ref tests skip cleanly without one.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { resolveGamePath } from '../src/corpus/corpus.js';
import { buildServer } from '../src/server.js';

interface ContentItem {
  type: string;
  text?: string;
}
interface ToolResult {
  content: ContentItem[];
  isError?: boolean;
}

interface Harness {
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  payload: (res: ToolResult) => Record<string, unknown>;
  errorText: (res: ToolResult) => string;
  tmp: string;
  teardown: () => Promise<void>;
}

async function setup(prefix: string): Promise<Harness> {
  const server = buildServer({ renderer: 'software' });
  const client = new Client({ name: 'stateless-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  return {
    call: async (name, args = {}) =>
      (await client.callTool({ name, arguments: args })) as unknown as ToolResult,
    payload: (res) => {
      expect(res.isError ?? false, res.content.find((c) => c.type === 'text')?.text).toBe(false);
      return JSON.parse(res.content.find((c) => c.type === 'text')!.text!) as Record<
        string,
        unknown
      >;
    },
    errorText: (res) => {
      expect(res.isError).toBe(true);
      return res.content.find((c) => c.type === 'text')!.text!;
    },
    tmp,
    teardown: async () => {
      await client.close();
      await server.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe('stateless mode: path-addressed documents', () => {
  let h: Harness;
  let basePath: string;
  let baseText: string;
  let aPath: string;
  /** Disk text right after the first path-addressed mutation (undo must restore it). */
  let afterFirstEdit: string;

  beforeAll(async () => {
    h = await setup('vs-shapes-mcp-stateless-');
    // Fixture built through the classic session flow (also proves the modes coexist).
    basePath = join(h.tmp, 'base.json');
    const created = h.payload(await h.call('shape_create', {}));
    const docId = created['docId'] as string;
    h.payload(
      await h.call('element_add', { docId, name: 'body', from: [0, 0, 0], to: [16, 8, 8] }),
    );
    h.payload(await h.call('shape_save', { docId, path: basePath }));
    h.payload(await h.call('shape_close', { docId }));
    baseText = readFileSync(basePath, 'utf8');
    aPath = join(h.tmp, 'a.json');
    copyFileSync(basePath, aPath);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it('a mutation addressed by file path needs no shape_open and auto-saves', async () => {
    const res = h.payload(
      await h.call('element_add', { docId: aPath, name: 'leg', from: [2, -4, 2], to: [4, 0, 4] }),
    );
    expect(res['savedTo']).toBe(aPath);
    expect(res['added']).toBe('leg');
    afterFirstEdit = readFileSync(aPath, 'utf8');
    expect(afterFirstEdit).toContain('"leg"');

    // Read-only tools resolve paths too.
    const validation = h.payload(await h.call('validate_run', { docId: aPath }));
    expect((validation['counts'] as { errors: number }).errors).toBe(0);
  });

  it('repeated path calls share one cached doc: history accumulates, undo restores the file byte-identically', async () => {
    h.payload(
      await h.call('element_add', { docId: aPath, name: 'leg2', from: [12, -4, 2], to: [14, 0, 4] }),
    );
    expect(readFileSync(aPath, 'utf8')).toContain('"leg2"');

    const history = h.payload(await h.call('doc_history', { docId: aPath }));
    expect((history['history'] as unknown[]).length).toBe(2);

    const undone = h.payload(await h.call('doc_undo', { docId: aPath }));
    expect(undone['undone']).toBe("element_add 'leg2'");
    expect(undone['savedTo']).toBe(aPath);
    expect(readFileSync(aPath, 'utf8')).toBe(afterFirstEdit);
  });

  it('an external on-disk change is picked up and clears the cached history', async () => {
    writeFileSync(aPath, baseText, 'utf8'); // another process rewrote the file
    const described = h.payload(await h.call('shape_describe', { docId: aPath }));
    expect(described['elements']).toBe(1); // 'leg' is gone — the doc was re-read from disk
    const history = h.payload(await h.call('doc_history', { docId: aPath }));
    expect((history['history'] as unknown[]).length).toBe(0);
  });

  it('session ids keep their strict errors; missing files get an actionable one', async () => {
    expect(h.errorText(await h.call('shape_describe', { docId: 'd99' }))).toMatch(
      /No open document with id 'd99'/,
    );
    expect(h.errorText(await h.call('shape_describe', { docId: join(h.tmp, 'nope.json') }))).toMatch(
      /cannot read .*nope\.json/,
    );
  });

  it('a path matching an open session doc resolves to that live doc (edits compose, auto-save cleans it)', async () => {
    const opened = h.payload(await h.call('shape_open', { path: aPath }));
    const docId = opened['docId'] as string;

    const res = h.payload(
      await h.call('element_add', { docId: aPath, name: 'tail', from: [7, 4, 8], to: [9, 6, 14] }),
    );
    expect(res['savedTo']).toBe(aPath);

    // The session doc saw the path-addressed edit — same live document, no fork.
    const described = h.payload(await h.call('shape_describe', { docId }));
    expect(described['rootElements']).toEqual(['body', 'tail']);
    expect(readFileSync(aPath, 'utf8')).toContain('"tail"');

    // Auto-save marked the session doc clean.
    const list = h.payload(await h.call('shape_list_open', {}));
    const entry = (list['open'] as { docId: string; dirty: boolean }[]).find(
      (o) => o.docId === docId,
    );
    expect(entry!.dirty).toBe(false);

    h.payload(await h.call('shape_close', { docId }));
  });

  it('shape_list_open shows the stateless cache; shape_close evicts entries', async () => {
    const list = h.payload(await h.call('shape_list_open', {}));
    const refs = (list['statelessCache'] as { ref: string }[]).map((e) => e.ref);
    expect(refs).toContain(aPath);

    const closed = h.payload(await h.call('shape_close', { docId: aPath }));
    expect(closed['note']).toMatch(/evicted/);
    const again = h.payload(await h.call('shape_close', { docId: aPath }));
    expect(again['note']).toMatch(/nothing was cached/);
  });
});

// ---------------------------------------------------------------------------------------
// corpus: refs (need a real game install; skip cleanly without one)
// ---------------------------------------------------------------------------------------

const FOX = 'entity/animal/mammal/fox/fox-male';
let gamePath: string | null = null;
try {
  gamePath = resolveGamePath();
} catch {
  gamePath = null;
}
const hasInstall =
  gamePath !== null &&
  existsSync(join(gamePath, 'assets', 'survival', 'shapes', ...FOX.split('/')) + '.json');
if (!hasInstall) {
  console.error('tests/stateless.test.ts: no Vintage Story install found — corpus-ref tests skipped.');
}

describe.skipIf(!hasInstall)('stateless mode: corpus refs', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await setup('vs-shapes-mcp-stateless-corpus-');
  });

  afterAll(async () => {
    await h.teardown();
  });

  it('corpus refs read everywhere; mutations are refused with a copy-first recipe', async () => {
    const described = h.payload(await h.call('shape_describe', { docId: `corpus:${FOX}` }));
    expect(described['rootElements']).toEqual(['body']);

    const err = h.errorText(
      await h.call('element_edit', { docId: `corpus:${FOX}`, name: 'body', rotationX: 5 }),
    );
    expect(err).toMatch(/read-only corpus reference/);
    expect(err).toMatch(/shape_save/);
  });

  it('shape_save exports a corpus ref to a file, which is then editable by path', async () => {
    const foxCopy = join(h.tmp, 'my-fox.json');
    const saved = h.payload(await h.call('shape_save', { docId: `corpus:${FOX}`, path: foxCopy }));
    expect(saved['savedTo']).toBe(foxCopy);

    const renamed = h.payload(
      await h.call('element_rename', { docId: foxCopy, oldName: 'body', newName: 'torso' }),
    );
    expect(renamed['savedTo']).toBe(foxCopy);
    expect(readFileSync(foxCopy, 'utf8')).toContain('"torso"');

    // The corpus ref itself stayed pristine.
    const described = h.payload(await h.call('shape_describe', { docId: `corpus:${FOX}` }));
    expect(described['rootElements']).toEqual(['body']);
  });

  it('element_import kitbashes from a corpus ref without opening it', async () => {
    const target = join(h.tmp, 'kitbash.json');
    const created = h.payload(await h.call('shape_create', {}));
    const docId = created['docId'] as string;
    h.payload(await h.call('shape_save', { docId, path: target }));
    h.payload(await h.call('shape_close', { docId }));

    const res = h.payload(
      await h.call('element_import', { docId: target, fromDocId: `corpus:${FOX}`, name: 'head' }),
    );
    expect(res['imported']).toBe('head');
    expect(res['savedTo']).toBe(target);
    expect(readFileSync(target, 'utf8')).toContain('"head"');
  });
});
