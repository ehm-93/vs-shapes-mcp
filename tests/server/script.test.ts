/**
 * End-to-end pins for the doc_script tool through the MCP client: a procedural script runs
 * as ONE transaction (single undo step), an uncaught error rolls every mutation back, and
 * the response carries ops/log/returned plus full validation.
 */
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
  const client = new Client({ name: 'script-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  return { client, call };
}

const text = (r: ToolResult): string => r.content.find((c) => c.type === 'text')?.text ?? '';
function payload(res: ToolResult): Record<string, unknown> {
  expect(res.isError ?? false, text(res)).toBe(false);
  return JSON.parse(text(res)) as Record<string, unknown>;
}

afterAll(() => {});

describe('doc_script (e2e)', () => {
  it('runs a procedural script and reports ops/returned/log + validation', async () => {
    const { client, call } = await connect();
    try {
      const docId = payload(await call('shape_create', {}))['docId'] as string;
      const res = payload(
        await call('doc_script', {
          docId,
          script: `for (let i = 0; i < 6; i++) {
                     const a = (i / 6) * 360;
                     addElement({ name: 'spike' + i, from: [0, 0, 0], to: [1, 6, 1],
                                  rotationOrigin: [0, 0, 0], rotation: { y: a }, faces: 'none' });
                   }
                   log('done');
                   return count();`,
        }),
      );
      expect(res['ops']).toBe(6);
      expect(res['elements']).toBe(6);
      expect(res['returned']).toBe(6);
      expect(res['log']).toEqual(['done']);
      expect(res['validation']).toBeDefined();

      // It is ONE transaction: a single undo removes all six.
      payload(await call('doc_undo', { docId }));
      const summary = payload(await call('shape_describe', { docId }));
      expect(summary['elements']).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('rolls the whole script back on an uncaught error', async () => {
    const { client, call } = await connect();
    try {
      const docId = payload(await call('shape_create', {}))['docId'] as string;
      const res = await call('doc_script', {
        docId,
        script: `addElement({ name: 'a', from: [0,0,0], to: [1,1,1], faces: 'none' });
                 addElement({ name: 'b', from: [0,0,0], to: [1,1,1], faces: 'none' });
                 throw 'stop here';`,
      });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/stop here/);
      // Neither element survived — the transaction rolled back.
      const summary = payload(await call('shape_describe', { docId }));
      expect(summary['elements']).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('surfaces a sandbox violation as an actionable tool error', async () => {
    const { client, call } = await connect();
    try {
      const docId = payload(await call('shape_create', {}))['docId'] as string;
      const res = await call('doc_script', { docId, script: 'return require("fs")' });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/'require' is not defined/);
    } finally {
      await client.close();
    }
  });
});
