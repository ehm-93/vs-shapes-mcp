/**
 * Server-level pin for palette_extract: the tool resolves a model's textures through the
 * render resolver chain (texturesRoot here) and returns the coverage-ranked palette, plus
 * an actionable note when nothing resolves.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../../src/server.js';

interface ContentItem {
  type: string;
  text?: string;
}
interface ToolResult {
  content: ContentItem[];
  isError?: boolean;
}

async function connect() {
  const server = buildServer({ renderer: 'software' });
  const client = new Client({ name: 'palette-test', version: '0.0.0' });
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

const tmp = mkdtempSync(join(tmpdir(), 'vs-shapes-palette-server-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Write a 1-row PNG (under tmp/<name>.png) and return the texturesRoot-relative ref. */
function writeTex(name: string, pixels: [number, number, number, number][]): string {
  const png = new PNG({ width: pixels.length, height: 1 });
  pixels.forEach((p, x) => png.data.set(p, x * 4));
  writeFileSync(join(tmp, `${name}.png`), PNG.sync.write(png));
  return name;
}

describe('palette_extract', () => {
  it('returns the coverage-ranked palette of an open model', async () => {
    const { client, call } = await connect();
    try {
      const docId = payload(await call('shape_create', {}))['docId'] as string;
      const ref = writeTex('skin', [
        [255, 0, 0, 255],
        [255, 0, 0, 255],
        [0, 0, 255, 255],
      ]);
      await call('doc_patch_json', {
        docId,
        patch: [{ op: 'add', path: '/textures/skin', value: ref }],
      });

      const r = payload(await call('palette_extract', { docId, texturesRoot: tmp, perTexture: true }));
      expect(r['mode']).toBe('representative');
      expect(r['resolvedTextures']).toEqual(['skin']);
      expect(r['missingTextures']).toEqual([]);
      expect(r['opaquePixels']).toBe(3);
      expect(r['colors']).toEqual([
        { hex: '#ff0000', rgb: [255, 0, 0], count: 2, fraction: 0.6667 },
        { hex: '#0000ff', rgb: [0, 0, 255], count: 1, fraction: 0.3333 },
      ]);
      expect((r['perTexture'] as unknown[])).toHaveLength(1);
      expect(r['note']).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('notes when a model declares no textures', async () => {
    const { client, call } = await connect();
    try {
      const docId = payload(await call('shape_create', {}))['docId'] as string;
      const r = payload(await call('palette_extract', { docId }));
      expect(r['colors']).toEqual([]);
      expect(r['resolvedTextures']).toEqual([]);
      expect(String(r['note'])).toMatch(/no textures/i);
    } finally {
      await client.close();
    }
  });
});
