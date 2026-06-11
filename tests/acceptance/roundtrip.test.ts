/**
 * Acceptance gate: serializeVsJson(parseVsJson(text)) must be byte-identical to the source
 * for ≥ 99% of all vanilla shape files and 100% of shapes/entity/**. On failures, the
 * failing paths + first-divergence context are written to roundtrip-failures.txt next to
 * this file. Skips (with a console note) when no Vintage Story install is present.
 *
 * Known expected failures: 18 block/metal/furnacesection/*.json files contain `//`
 * comments, which the parser rejects by contract (ARCHITECTURE §vs/json.ts). 18/6115 =
 * 0.29%, within the 1% budget; none are under entity/.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVsJson, serializeVsJson } from '../../src/vs/json.js';

const gamePath =
  process.env['VINTAGE_STORY'] ??
  (process.env['APPDATA'] ? join(process.env['APPDATA'], 'Vintagestory') : undefined);
const shapesRoot = gamePath ? join(gamePath, 'assets', 'survival', 'shapes') : undefined;
const available = shapesRoot !== undefined && existsSync(shapesRoot);
if (!available) {
  console.log(
    `[roundtrip] SKIPPED: Vintage Story shapes not found at ${shapesRoot ?? '<no APPDATA/VINTAGE_STORY>'} — install the game or set VINTAGE_STORY`,
  );
}

const failuresFile = fileURLToPath(new URL('./roundtrip-failures.txt', import.meta.url));

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.json')) out.push(p);
  }
  return out;
}

describe.skipIf(!available)('corpus round-trip acceptance', () => {
  it('round-trips the vanilla shape corpus byte-identically (≥99% overall, 100% entity)', () => {
    const root = shapesRoot!;
    const files = walk(root, []);
    expect(files.length).toBeGreaterThan(0);

    let pass = 0;
    let entityPass = 0;
    let entityTotal = 0;
    const failures: string[] = [];
    const entityFailures: string[] = [];

    for (const file of files) {
      const rel = file.slice(root.length + 1).replace(/\\/g, '/');
      const isEntity = rel.startsWith('entity/');
      if (isEntity) entityTotal++;
      const text = readFileSync(file, 'utf8');
      let failure: string | undefined;
      try {
        const out = serializeVsJson(parseVsJson(text));
        if (out === text) {
          pass++;
          if (isEntity) entityPass++;
        } else {
          let i = 0;
          const max = Math.min(out.length, text.length);
          while (i < max && out.charCodeAt(i) === text.charCodeAt(i)) i++;
          failure =
            `${rel}\n  first divergence at offset ${i}\n` +
            `  expected ...${JSON.stringify(text.slice(Math.max(0, i - 40), i + 40))}...\n` +
            `  actual   ...${JSON.stringify(out.slice(Math.max(0, i - 40), i + 40))}...`;
        }
      } catch (e) {
        failure = `${rel}\n  parse error: ${(e as Error).message}`;
      }
      if (failure !== undefined) {
        failures.push(failure);
        if (isEntity) entityFailures.push(failure);
      }
    }

    const overallRate = pass / files.length;
    const entityRate = entityTotal === 0 ? 1 : entityPass / entityTotal;
    console.log(
      `[roundtrip] overall: ${pass}/${files.length} byte-identical (${(overallRate * 100).toFixed(3)}%)`,
    );
    console.log(
      `[roundtrip] entity/: ${entityPass}/${entityTotal} byte-identical (${(entityRate * 100).toFixed(3)}%)`,
    );

    if (failures.length > 0) {
      writeFileSync(
        failuresFile,
        `round-trip failures: ${failures.length}/${files.length} ` +
          `(overall ${(overallRate * 100).toFixed(3)}%, entity ${(entityRate * 100).toFixed(3)}%)\n\n` +
          failures.join('\n\n') +
          '\n',
      );
      console.log(`[roundtrip] wrote ${failures.length} failures to ${failuresFile}`);
    } else if (existsSync(failuresFile)) {
      rmSync(failuresFile);
    }

    expect(entityFailures, 'every shapes/entity/** file must round-trip byte-identically').toEqual([]);
    expect(overallRate, 'at least 99% of all shape files must round-trip byte-identically').toBeGreaterThanOrEqual(0.99);
  });
});
