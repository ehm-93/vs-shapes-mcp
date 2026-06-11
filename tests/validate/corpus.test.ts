/**
 * Corpus spot test: real vanilla shapes must produce ZERO errors at full level (warnings
 * and notes are allowed — they are printed for the log). Skips cleanly when the game
 * install is absent.
 *
 * Note on "wolf-male": in VS 1.22 the wolf entity model was renamed to
 * entity/animal/mammal/wolf/eurasian-adult.json; the only file literally named
 * wolf-male.json is the lead-rope shape entity/animal/lead/wolf-male.json. Both are
 * validated here.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateDocument } from '../../src/vs/validate.js';
import { VsNum, type Finding, type ShapeJson } from '../../src/vs/types.js';

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
const shapesDir = path.join(gameDir, 'assets', 'survival', 'shapes', 'entity');
const haveGame = existsSync(shapesDir);
if (!haveGame) {
  console.error(
    `tests/validate/corpus.test.ts: Vintage Story install not found at ${gameDir} — skipping corpus tests`,
  );
}

const load = (rel: string): ShapeJson =>
  wrapNums(JSON.parse(readFileSync(path.join(shapesDir, rel), 'utf8'))) as ShapeJson;

const printNonErrors = (label: string, findings: Finding[]): void => {
  for (const f of findings.filter((x) => x.severity !== 'error')) {
    console.log(`[${label}] ${f.severity} ${f.code}: ${f.message}`);
  }
};

const runFull = (doc: ShapeJson): Finding[] => validateDocument(doc, { level: 'full' });

const expectZeroErrors = (label: string, findings: Finding[]): void => {
  printNonErrors(label, findings);
  const errors = findings.filter((f) => f.severity === 'error');
  expect(errors, `${label} should have zero errors:\n${JSON.stringify(errors, null, 2)}`).toEqual(
    [],
  );
};

describe.skipIf(!haveGame)('corpus spot checks (full level, zero errors)', () => {
  it('fox-male.json validates clean, including foot-slide on its four feet', () => {
    const fox = load('animal/mammal/fox/fox-male.json');
    const findings = validateDocument(fox, {
      level: 'full',
      footElements: ['left front feet', 'right front feet', 'L back feet', 'R back feet'],
    });
    expectZeroErrors('fox-male', findings);
  });

  it('the wolf model (eurasian-adult.json, wolf-male before 1.22) validates clean', () => {
    const wolf = load('animal/mammal/wolf/eurasian-adult.json');
    const findings = validateDocument(wolf, { level: 'full' });
    expectZeroErrors('wolf/eurasian-adult', findings);
    // 44 distinct animated elements: the joint-cap warn is expected on this model and is
    // exactly the case the engine's "raise maxAnimatedElements to 46" error talks about.
    expect(findings.some((f) => f.code === 'anim/joint-cap')).toBe(true);
  });

  it('the literal wolf-male.json (lead-rope shape) validates clean', () => {
    const lead = load('animal/lead/wolf-male.json');
    expectZeroErrors('lead/wolf-male', runFull(lead));
  });

  it('a bird (chicken-hen.json) validates clean', () => {
    const hen = load('animal/bird/chicken/chicken-hen.json');
    expectZeroErrors('chicken-hen', runFull(hen));
  });

  it('hawk.json validates clean (its #null textures sit on disabled faces)', () => {
    const hawk = load('animal/bird/raptor/hawk/hawk.json');
    expectZeroErrors('hawk', runFull(hawk));
  });
});
