/**
 * Corpus integration tests against a real Vintage Story install (resolved via the standard
 * chain: VINTAGE_STORY env var, then %APPDATA%/Vintagestory). Skipped with a console note
 * when no install is present so CI without the game still passes.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { initCorpus, resolveGamePath, type Corpus } from '../../src/corpus/corpus.js';

let gamePath: string | null = null;
try {
  gamePath = resolveGamePath();
} catch {
  gamePath = null;
}
if (gamePath === null) {
  console.warn(
    '[corpus.install.test] No Vintage Story install found (VINTAGE_STORY unset and no ' +
      '%APPDATA%/Vintagestory) — skipping corpus integration tests.',
  );
}

let corpus: Corpus | null = null;
const getCorpus = (): Corpus => (corpus ??= initCorpus(gamePath!));

describe.skipIf(gamePath === null)('corpus against the real game install', () => {
  it('list() indexes the full vanilla corpus (> 5000 shapes, both domains)', () => {
    const all = getCorpus().list();
    expect(all.length).toBeGreaterThan(5000);
    expect(all.some((e) => e.domain === 'survival')).toBe(true);
    expect(all.some((e) => e.domain === 'game')).toBe(true);
    // every entry follows the documented convention: no .json, no shapes/ prefix
    expect(all.every((e) => !e.path.endsWith('.json') && !e.path.startsWith('shapes/'))).toBe(true);
  });

  it('list(glob) narrows to the fox directory', () => {
    const foxes = getCorpus().list('entity/animal/mammal/fox/*');
    expect(foxes.length).toBeGreaterThanOrEqual(3); // fox-male, fox-female, fox-baby
    expect(foxes.every((e) => e.path.startsWith('entity/animal/mammal/fox/'))).toBe(true);
  });

  it("search('fox') ranks fox shapes on top", () => {
    const hits = getCorpus().search('fox');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toContain('/fox/');
  });

  it("search('fox male') ranks the two-token match first", () => {
    const hits = getCorpus().search('fox male');
    expect(hits[0]!.path).toBe('entity/animal/mammal/fox/fox-male');
    expect(hits[0]!.score).toBeGreaterThanOrEqual(2000);
  });

  it('stats(fox-male) matches the 1.22 file', () => {
    const s = getCorpus().stats('entity/animal/mammal/fox/fox-male');
    // NOTE: the task brief said "> 30 elements" but fox-male.json in 1.22.3 has exactly 19
    // elements (19 "from" fields; verified by hand). Pinned to the real file.
    expect(s.elements).toBe(19);
    expect(s.elements).toBeGreaterThan(15);
    expect(s.depth).toBeGreaterThanOrEqual(4);
    const walk = s.animations.find((a) => a.code.toLowerCase().includes('walk'));
    expect(walk).toBeDefined();
    expect(walk!.quantityFrames).toBeGreaterThan(0);
    expect(s.textureWidth).toBe(32);
    expect(s.textureHeight).toBe(32);
    expect(s.textures['skin']).toBe('entity/animal/mammal/fox/red-male');
    // static bounds sane and in 1/16-block units (fox is roughly a block long)
    expect(s.bounds.rotationsIgnored).toBe(true);
    for (let a = 0; a < 3; a++) {
      expect(s.bounds.max[a]!).toBeGreaterThan(s.bounds.min[a]!);
      expect(s.bounds.max[a]! - s.bounds.min[a]!).toBeLessThan(64);
    }
  });

  it('read() returns parseable raw text, with domain prefix support', () => {
    const text = getCorpus().read('survival:entity/animal/mammal/fox/fox-male');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.elements)).toBe(true);
  });

  it('resolveTexturePng finds the fox skin texture on disk', () => {
    const png = getCorpus().resolveTexturePng('entity/animal/mammal/fox/red-male');
    expect(png).not.toBeNull();
    expect(png!).toMatch(/red-male\.png$/);
    expect(existsSync(png!)).toBe(true);
  });

  it('resolveTexturePng returns null for a nonexistent texture', () => {
    expect(getCorpus().resolveTexturePng('entity/animal/mammal/fox/no-such-skin')).toBeNull();
  });

  it('stats() of a missing shape names both locations tried', () => {
    expect(() => getCorpus().stats('entity/animal/mammal/fox/fox-adult')).toThrow(
      /fox-adult.*survival.*game/s,
    );
  });

  it('indexing the vanilla corpus produces no warnings', () => {
    getCorpus().list();
    expect(getCorpus().warnings()).toEqual([]);
  });
});
