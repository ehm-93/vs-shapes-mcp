/**
 * Corpus tests against a synthetic game install built in a temp directory.
 * These run everywhere (no Vintage Story install required).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initCorpus, resolveGamePath, type Corpus } from '../../src/corpus/corpus.js';

let root: string;
let corpus: Corpus;

const GOOD_SURVIVAL = `{
	"textureWidth": 64,
	"textureHeight": 48,
	"textures": {
		"skin": "test/skin"
	},
	"elements": [
		{
			"name": "body",
			"from": [ 2.0, 2.0, 2.0 ],
			"to": [ 4.0, 4.0, 4.0 ],
			"children": [
				{ "name": "arm", "from": [ 1.0, 0.0, 0.0 ], "to": [ 3.0, 1.0, 1.0 ] }
			]
		}
	],
	"animations": [
		{ "name": "Walk", "code": "walk", "quantityframes": 30, "keyframes": [] },
		{ "name": "idle", "quantityframes": 10, "keyframes": [] }
	]
}`;

// BOM + line/block comments + trailing commas: must parse via the lenient fallback.
const COMMENTED =
  String.fromCharCode(0xfeff) +
  '{\n' +
  '\t// line comment\n' +
  '\t"textureWidth": 32, /* block comment, with "quotes, and a // inside" */\n' +
  '\t"textures": { "main": "has // slashes /* in string */ kept" },\n' +
  '\t"elements": [\n' +
  '\t\t{ "name": "a", "from": [ 0, 0, 0 ], "to": [ 1, 1, 1 ], },\n' +
  '\t],\n' +
  '}\n';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'vs-corpus-test-'));
  const sShapes = join(root, 'assets', 'survival', 'shapes', 'test');
  const gShapes = join(root, 'assets', 'game', 'shapes');
  mkdirSync(sShapes, { recursive: true });
  mkdirSync(join(gShapes, 'test'), { recursive: true });
  mkdirSync(join(gShapes, 'gameonly'), { recursive: true });

  writeFileSync(join(sShapes, 'good.json'), GOOD_SURVIVAL);
  writeFileSync(join(sShapes, 'commented.json'), COMMENTED);
  writeFileSync(join(sShapes, 'broken.json'), '{ "elements": [ {');
  writeFileSync(join(sShapes, 'nodefaults.json'), '{ "elements": [] }');
  // Same relative path in the game domain — survival must win unprefixed lookups.
  writeFileSync(join(gShapes, 'test', 'good.json'), '{ "textureWidth": 99, "elements": [] }');
  writeFileSync(join(gShapes, 'gameonly', 'thing.json'), '{ "elements": [] }');

  const sTex = join(root, 'assets', 'survival', 'textures', 'test');
  const gTex = join(root, 'assets', 'game', 'textures', 'gametex');
  mkdirSync(sTex, { recursive: true });
  mkdirSync(gTex, { recursive: true });
  // Only existence is checked — PNG magic bytes are enough.
  writeFileSync(join(sTex, 'skin.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  writeFileSync(join(gTex, 'foo.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

  corpus = initCorpus(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveGamePath', () => {
  it('accepts an explicit valid path', () => {
    expect(resolveGamePath(root)).toBe(root);
  });

  it('falls back from an invalid explicit path to a valid VINTAGE_STORY env var', () => {
    const prev = process.env['VINTAGE_STORY'];
    try {
      process.env['VINTAGE_STORY'] = root;
      expect(resolveGamePath(join(root, 'does-not-exist'))).toBe(root);
    } finally {
      if (prev === undefined) delete process.env['VINTAGE_STORY'];
      else process.env['VINTAGE_STORY'] = prev;
    }
  });

  it('rejects a directory without an assets subfolder, naming every location tried', () => {
    const noAssets = join(root, 'empty-install');
    mkdirSync(noAssets, { recursive: true });
    const prevVs = process.env['VINTAGE_STORY'];
    const prevAppData = process.env['APPDATA'];
    try {
      process.env['VINTAGE_STORY'] = join(root, 'missing-env-dir');
      process.env['APPDATA'] = join(root, 'missing-appdata');
      let err: Error | undefined;
      try {
        resolveGamePath(noAssets);
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeDefined();
      const msg = err!.message;
      // All three sources named, each with its reason.
      expect(msg).toContain('explicit gamePath argument');
      expect(msg).toContain(noAssets);
      expect(msg).toContain('no "assets" subdirectory');
      expect(msg).toContain('VINTAGE_STORY');
      expect(msg).toContain(join(root, 'missing-env-dir'));
      expect(msg).toContain('%APPDATA%/Vintagestory');
      expect(msg).toContain('Fix:');
    } finally {
      if (prevVs === undefined) delete process.env['VINTAGE_STORY'];
      else process.env['VINTAGE_STORY'] = prevVs;
      if (prevAppData === undefined) delete process.env['APPDATA'];
      else process.env['APPDATA'] = prevAppData;
    }
  });
});

describe('list', () => {
  it('indexes both domains', () => {
    const all = corpus.list();
    expect(all).toHaveLength(6);
    expect(all.filter((e) => e.domain === 'survival')).toHaveLength(4);
    expect(all.filter((e) => e.domain === 'game')).toHaveLength(2);
    expect(all.map((e) => e.path)).toContain('test/good');
    expect(all.map((e) => e.path)).toContain('gameonly/thing');
  });

  it('filters by glob, basename glob, and domain prefix', () => {
    expect(corpus.list('test/*').map((e) => `${e.domain}:${e.path}`).sort()).toEqual([
      'game:test/good',
      'survival:test/broken',
      'survival:test/commented',
      'survival:test/good',
      'survival:test/nodefaults',
    ]);
    // '**' crosses segments, '**/' also matches zero directories
    expect(corpus.list('**/thing').map((e) => e.path)).toEqual(['gameonly/thing']);
    // glob without '/' matches the basename too
    expect(corpus.list('good').map((e) => `${e.domain}:${e.path}`).sort()).toEqual([
      'game:test/good',
      'survival:test/good',
    ]);
    expect(corpus.list('game:test/*').map((e) => `${e.domain}:${e.path}`)).toEqual([
      'game:test/good',
    ]);
    expect(corpus.list('?ood').map((e) => e.path).sort()).toEqual(['test/good', 'test/good']);
  });

  it('returns everything for an empty glob and never throws', () => {
    expect(corpus.list('')).toHaveLength(6);
    expect(corpus.list('[[[')).toEqual([]); // regex specials are escaped, not parsed
  });
});

describe('search', () => {
  it('ranks multi-token matches above single-token matches', () => {
    const hits = corpus.search('gameonly thing');
    expect(hits[0]!.path).toBe('gameonly/thing');
    expect(hits[0]!.score).toBeGreaterThanOrEqual(2000); // both tokens matched
  });

  it('returns empty for an empty query', () => {
    expect(corpus.search('')).toEqual([]);
    expect(corpus.search('   ')).toEqual([]);
  });
});

describe('read', () => {
  it('prefers survival over game for unprefixed paths', () => {
    expect(JSON.parse(corpus.read('test/good')).textureWidth).toBe(64);
    expect(JSON.parse(corpus.read('game:test/good')).textureWidth).toBe(99);
  });

  it('tolerates shapes/ prefix, .json suffix, and backslashes', () => {
    expect(JSON.parse(corpus.read('shapes\\test\\good.json')).textureWidth).toBe(64);
  });

  it('strips the BOM', () => {
    expect(corpus.read('test/commented').charCodeAt(0)).not.toBe(0xfeff);
  });

  it('throws a descriptive error naming both locations tried and suggesting near matches', () => {
    let err: Error | undefined;
    try {
      corpus.read('test/goood');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('test/goood');
    expect(err!.message).toContain(join(root, 'assets', 'survival', 'shapes', 'test', 'goood.json'));
    expect(err!.message).toContain(join(root, 'assets', 'game', 'shapes', 'test', 'goood.json'));
    expect(err!.message).toContain('search()');
  });

  it('rejects unknown domain prefixes with the supported list', () => {
    expect(() => corpus.read('creative:test/good')).toThrow(/survival.*game/s);
  });
});

describe('stats', () => {
  it('computes elements, depth, cumulative-from bounds, animations, and textures', () => {
    const s = corpus.stats('test/good');
    expect(s.elements).toBe(2);
    expect(s.depth).toBe(2);
    // arm world corners = body.from + arm.from/to = [3,2,2] and [5,3,3]
    expect(s.bounds.min).toEqual([2, 2, 2]);
    expect(s.bounds.max).toEqual([5, 4, 4]);
    expect(s.bounds.rotationsIgnored).toBe(true);
    expect(s.bounds.units).toBe('1/16 block');
    expect(s.animations).toEqual([
      { code: 'walk', quantityFrames: 30 },
      { code: 'idle', quantityFrames: 10 }, // code defaults to name
    ]);
    expect(s.textureWidth).toBe(64);
    expect(s.textureHeight).toBe(48);
    expect(s.textures).toEqual({ skin: 'test/skin' });
  });

  it('defaults textureWidth/Height to 16 and returns zero bounds for empty shapes', () => {
    const s = corpus.stats('test/nodefaults');
    expect(s.textureWidth).toBe(16);
    expect(s.textureHeight).toBe(16);
    expect(s.elements).toBe(0);
    expect(s.depth).toBe(0);
    expect(s.bounds.min).toEqual([0, 0, 0]);
    expect(s.bounds.max).toEqual([0, 0, 0]);
  });

  it('parses files with BOM, comments, and trailing commas via the lenient fallback', () => {
    const s = corpus.stats('test/commented');
    expect(s.elements).toBe(1);
    expect(s.textureWidth).toBe(32);
    expect(s.textures['main']).toBe('has // slashes /* in string */ kept'); // strings untouched
  });

  it('reports unparseable files with a warning and excludes them from search', () => {
    expect(corpus.search('broken').some((h) => h.path === 'test/broken')).toBe(true);
    expect(() => corpus.stats('test/broken')).toThrow(/test\/broken.*not valid JSON/s);
    const warning = corpus.warnings().find((w) => w.path === 'test/broken');
    expect(warning).toBeDefined();
    expect(warning!.domain).toBe('survival');
    // now excluded from search, but still listed
    expect(corpus.search('broken').some((h) => h.path === 'test/broken')).toBe(false);
    expect(corpus.list().some((e) => e.path === 'test/broken')).toBe(true);
  });
});

describe('resolveTexturePng', () => {
  it('resolves survival textures and honors domain prefixes', () => {
    const skin = corpus.resolveTexturePng('test/skin');
    expect(skin).toBe(join(root, 'assets', 'survival', 'textures', 'test', 'skin.png'));
    expect(existsSync(skin!)).toBe(true);
    expect(corpus.resolveTexturePng('game:gametex/foo')).toBe(
      join(root, 'assets', 'game', 'textures', 'gametex', 'foo.png'),
    );
    // game-domain texture found without a prefix via the survival → game fallback
    expect(corpus.resolveTexturePng('gametex/foo')).toContain(join('game', 'textures'));
  });

  it('tolerates .png suffix and textures/ prefix', () => {
    expect(corpus.resolveTexturePng('textures/test/skin.png')).toContain('skin.png');
  });

  it('returns null for missing textures (no throw)', () => {
    expect(corpus.resolveTexturePng('nope/missing')).toBeNull();
    expect(corpus.resolveTexturePng('survival:gametex/foo')).toBeNull(); // wrong domain
    expect(corpus.resolveTexturePng('')).toBeNull();
  });

  it('game: prefers the game folder but falls back to survival (the split base-game domain)', () => {
    // 'gametex/foo' exists only under game/ — the game: prefix still finds it.
    expect(corpus.resolveTexturePng('game:gametex/foo')).toBe(
      join(root, 'assets', 'game', 'textures', 'gametex', 'foo.png'),
    );
    // 'test/skin' exists only under survival/ — a shipped game:-prefixed ref now resolves it
    // (vanilla assets ship referenced as game: but physically live under survival/).
    expect(corpus.resolveTexturePng('game:test/skin')).toBe(
      join(root, 'assets', 'survival', 'textures', 'test', 'skin.png'),
    );
    // survival: stays restricted — no fallback into game/.
    expect(corpus.resolveTexturePng('survival:gametex/foo')).toBeNull();
  });
});
