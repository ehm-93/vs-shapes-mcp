/**
 * ShapeDocument behavior pins: tree access, transactions (rollback + nesting), undo/redo
 * byte round-trips, history ordering/bounding, create() round-trip, and the fox corpus
 * cases from ARCHITECTURE. Corpus-dependent tests skip cleanly when the game is absent.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ShapeDocument } from '../../src/vs/document.js';
import { VsNum } from '../../src/vs/types.js';
import type { ElementJson } from '../../src/vs/types.js';

// --- synthetic fixture (no game install required) ----------------------------

const FIXTURE = `{
	"textureWidth": 16,
	"textureHeight": 16,
	"textureSizes": {
	},
	"textures": {
		"skin": "entity/test/skin"
	},
	"elements": [
		{
			"name": "root1",
			"from": [ 0.0, 0.0, 0.0 ],
			"to": [ 4.0, 4.0, 4.0 ],
			"faces": {
				"north": { "texture": "#skin", "uv": [ 0.0, 0.0, 4.0, 4.0 ] }
			},
			"children": [
				{
					"name": "child1",
					"from": [ 0.0, 4.0, 0.0 ],
					"to": [ 2.0, 6.0, 2.0 ],
					"children": [
						{
							"name": "grand1",
							"from": [ 0.0, 6.0, 0.0 ],
							"to": [ 1.0, 7.0, 1.0 ]
						}
					]
				},
				{
					"name": "child2",
					"from": [ 2.0, 4.0, 2.0 ],
					"to": [ 4.0, 6.0, 4.0 ]
				}
			]
		},
		{
			"name": "root2",
			"from": [ 8.0, 0.0, 8.0 ],
			"to": [ 12.0, 4.0, 12.0 ]
		}
	],
	"animations": [
		{
			"name": "Wiggle",
			"code": "wiggle",
			"quantityframes": 30,
			"onAnimationEnd": "Repeat",
			"keyframes": [
				{
					"frame": 0,
					"elements": {
						"child1": { "rotationX": 0.0, "rotationY": 0.0, "rotationZ": 10.0 }
					}
				}
			]
		},
		{
			"name": "NoCode",
			"quantityframes": 10,
			"keyframes": []
		}
	]
}`;

/** Count elements the dumb way, independent of walk(). */
function manualCount(els: ElementJson[] | undefined): number {
  let n = 0;
  for (const el of els ?? []) n += 1 + manualCount(el.children);
  return n;
}

describe('ShapeDocument.parse + tree access', () => {
  it('parses and finds elements by name at any depth', () => {
    const doc = ShapeDocument.parse(FIXTURE);
    expect(doc.getElement('root1')?.name).toBe('root1');
    expect(doc.getElement('grand1')?.name).toBe('grand1');
    expect(doc.getElement('nope')).toBeUndefined();
    // live node: mutating the returned element is visible in serialize()
    expect(doc.getElement('child2')).toBe(doc.root.elements[0]!.children![1]);
  });

  it('walk visits every element exactly once, pre-order, with ancestor paths', () => {
    const doc = ShapeDocument.parse(FIXTURE);
    const visited: string[] = [];
    const paths = new Map<string, string[]>();
    doc.walk((el, path) => {
      visited.push(el.name);
      paths.set(
        el.name,
        path.map((p) => p.name),
      );
    });
    expect(visited).toEqual(['root1', 'child1', 'grand1', 'child2', 'root2']);
    expect(visited.length).toBe(manualCount(doc.root.elements));
    expect(new Set(visited).size).toBe(visited.length); // exactly once
    expect(paths.get('root1')).toEqual([]);
    expect(paths.get('grand1')).toEqual(['root1', 'child1']);
    expect(paths.get('child2')).toEqual(['root1']);
  });

  it('parentOf returns the parent element, null at root level, throws on unknown names', () => {
    const doc = ShapeDocument.parse(FIXTURE);
    expect(doc.parentOf('child1')).toBe(doc.getElement('root1'));
    expect(doc.parentOf('grand1')).toBe(doc.getElement('child1'));
    expect(doc.parentOf('root1')).toBeNull();
    expect(doc.parentOf('root2')).toBeNull();
    expect(() => doc.parentOf('missing-leg')).toThrowError(/missing-leg/);
  });

  it('rejects non-object roots and non-array elements/animations with named errors', () => {
    expect(() => ShapeDocument.parse('[ 1, 2 ]')).toThrowError(/top-level JSON object.*an array/);
    expect(() => ShapeDocument.parse('"hi"')).toThrowError(/a string/);
    expect(() => ShapeDocument.parse('{ "elements": 5 }')).toThrowError(/"elements" must be an array/);
    expect(() => ShapeDocument.parse('{ "elements": [], "animations": {} }')).toThrowError(
      /"animations" must be an array/,
    );
    expect(() => ShapeDocument.parse('{ "elements": 5 }', { path: 'mod/broken.json' })).toThrowError(
      /mod\/broken\.json/,
    );
    // parse errors carry the path too
    expect(() => ShapeDocument.parse('{ oops', { path: 'mod/trunc.json' })).toThrowError(/mod\/trunc\.json/);
  });

  it('tolerates shapes without an elements key (vanilla block/basic/invisible.json style)', () => {
    const doc = ShapeDocument.parse('{ "textureWidth": 16 }');
    let n = 0;
    doc.walk(() => n++);
    expect(n).toBe(0);
    expect(doc.getElement('anything')).toBeUndefined();
    expect(doc.listAnimations()).toEqual([]);
  });
});

describe('animations', () => {
  it('lists animations and resolves by code ?? name', () => {
    const doc = ShapeDocument.parse(FIXTURE);
    expect(doc.listAnimations().map((a) => a.name)).toEqual(['Wiggle', 'NoCode']);
    expect(doc.getAnimation('wiggle')?.name).toBe('Wiggle');
    // when code is present it takes over completely — the display name no longer matches
    expect(doc.getAnimation('Wiggle')).toBeUndefined();
    // absent code falls back to the name
    expect(doc.getAnimation('NoCode')?.quantityframes.value).toBe(10);
    expect(doc.getAnimation('ghost')).toBeUndefined();
  });
});

describe('transactions', () => {
  it('returns the fn value and pushes a {summary, at} history entry', () => {
    const doc = ShapeDocument.parse(FIXTURE);
    const out = doc.transact('rename root1', () => {
      doc.getElement('root1')!.name = 'torso';
      return 42;
    });
    expect(out).toBe(42);
    expect(doc.getElement('torso')).toBeDefined();
    expect(doc.history()).toEqual([{ summary: 'rename root1', at: 1 }]);
  });

  it('rollback on throw restores byte-identical serialize() output and pushes no history', () => {
    const doc = ShapeDocument.parse(FIXTURE);
    const before = doc.serialize();
    const boom = new Error('deliberate failure');
    expect(() =>
      doc.transact('doomed edit', () => {
        doc.getElement('root1')!.name = 'mangled';
        doc.root.elements.push({ ...doc.root.elements[1]!, name: 'extra' });
        delete doc.root.textures!['skin'];
        throw boom;
      }),
    ).toThrow(boom);
    expect(doc.serialize()).toBe(before);
    expect(doc.getElement('mangled')).toBeUndefined();
    expect(doc.history()).toEqual([]);
    expect(doc.undo()).toBeNull();
  });

  it('nested transact folds into the outer one: a single undo entry covering both', () => {
    const doc = ShapeDocument.parse(FIXTURE);
    const s0 = doc.serialize();
    doc.transact('outer edit', () => {
      doc.getElement('root1')!.name = 'torso';
      doc.transact('inner edit', () => {
        doc.getElement('child2')!.name = 'hip';
      });
    });
    expect(doc.history()).toEqual([{ summary: 'outer edit', at: 1 }]);
    expect(doc.getElement('torso')).toBeDefined();
    expect(doc.getElement('hip')).toBeDefined();
    expect(doc.undo()).toBe('outer edit'); // one undo reverts both levels
    expect(doc.serialize()).toBe(s0);
  });

  it('an inner transact failure caught by the outer fn rolls back only the inner edits', () => {
    const doc = ShapeDocument.parse(FIXTURE);
    doc.transact('outer keeps going', () => {
      doc.getElement('root1')!.name = 'torso';
      expect(() =>
        doc.transact('inner fails', () => {
          doc.getElement('child1')!.name = 'broken';
          throw new Error('inner boom');
        }),
      ).toThrowError('inner boom');
      // NB: the rollback swapped the tree — re-fetch nodes instead of using stale refs
      expect(doc.getElement('broken')).toBeUndefined();
      expect(doc.getElement('torso')).toBeDefined(); // outer edit predates inner snapshot
    });
    expect(doc.history()).toEqual([{ summary: 'outer keeps going', at: 1 }]);
    expect(doc.getElement('torso')).toBeDefined();
    expect(doc.getElement('child1')).toBeDefined();
  });
});

describe('undo / redo', () => {
  it('round-trips serialize() bytes across undo and redo', () => {
    const doc = ShapeDocument.parse(FIXTURE);
    const s0 = doc.serialize();
    doc.transact('edit A', () => {
      doc.getElement('root1')!.name = 'torso';
    });
    const s1 = doc.serialize();
    doc.transact('edit B', () => {
      doc.root.textures!['fur'] = 'entity/test/fur';
    });
    const s2 = doc.serialize();
    expect(s0).not.toBe(s1);
    expect(s1).not.toBe(s2);

    expect(doc.undo()).toBe('edit B');
    expect(doc.serialize()).toBe(s1);
    expect(doc.undo()).toBe('edit A');
    expect(doc.serialize()).toBe(s0);
    expect(doc.undo()).toBeNull();

    expect(doc.redo()).toBe('edit A');
    expect(doc.serialize()).toBe(s1);
    expect(doc.redo()).toBe('edit B');
    expect(doc.serialize()).toBe(s2);
    expect(doc.redo()).toBeNull();
  });

  it('preserves VsNum identity and raw literals through snapshot/undo (no structuredClone)', () => {
    const doc = ShapeDocument.parse(FIXTURE);
    doc.transact('move root1', () => {
      const from = doc.getElement('root1')!.from;
      from[0] = new VsNum(1.5);
    });
    doc.undo();
    const restored = doc.getElement('root1')!.from[0];
    expect(restored).toBeInstanceOf(VsNum);
    expect(restored.value).toBe(0);
    expect(restored.raw).toBe('0.0'); // original literal survives the clone round-trip
  });

  it('clears the redo stack when a new transaction commits', () => {
    const doc = ShapeDocument.parse(FIXTURE);
    doc.transact('edit A', () => {
      doc.getElement('root1')!.name = 'torso';
    });
    expect(doc.undo()).toBe('edit A');
    doc.transact('edit C', () => {
      doc.getElement('root2')!.name = 'tail';
    });
    expect(doc.redo()).toBeNull(); // 'edit A' is no longer reachable
    expect(doc.history()).toEqual([{ summary: 'edit C', at: 2 }]);
  });

  it('keeps the redo stack when a transaction rolls back (nothing changed)', () => {
    const doc = ShapeDocument.parse(FIXTURE);
    doc.transact('edit A', () => {
      doc.getElement('root1')!.name = 'torso';
    });
    const s1 = doc.serialize();
    doc.undo();
    expect(() =>
      doc.transact('fails', () => {
        throw new Error('nope');
      }),
    ).toThrowError('nope');
    expect(doc.redo()).toBe('edit A');
    expect(doc.serialize()).toBe(s1);
  });

  it('refuses undo/redo inside an open transaction', () => {
    const doc = ShapeDocument.parse(FIXTURE);
    doc.transact('edit A', () => {
      doc.getElement('root1')!.name = 'torso';
    });
    doc.transact('outer', () => {
      expect(() => doc.undo()).toThrowError(/open transaction/);
      expect(() => doc.redo()).toThrowError(/open transaction/);
    });
  });
});

describe('history', () => {
  it('orders entries oldest-first with strictly increasing monotonic sequence numbers', () => {
    const doc = ShapeDocument.parse(FIXTURE);
    // Transactions must actually change the document — no-op transactions push no history.
    doc.transact('one', () => void (doc.root.textureWidth = new VsNum(17)));
    doc.transact('two', () => void (doc.root.textureWidth = new VsNum(18)));
    doc.transact('three', () => void (doc.root.textureWidth = new VsNum(19)));
    const h = doc.history();
    expect(h.map((e) => e.summary)).toEqual(['one', 'two', 'three']);
    for (let i = 1; i < h.length; i++) expect(h[i]!.at).toBeGreaterThan(h[i - 1]!.at);

    doc.undo();
    expect(doc.history().map((e) => e.summary)).toEqual(['one', 'two']);
    doc.redo();
    expect(doc.history().map((e) => e.summary)).toEqual(['one', 'two', 'three']);
    // sequence numbers keep increasing across undo — no reuse
    doc.undo();
    doc.transact('four', () => void (doc.root.textureWidth = new VsNum(20)));
    const ats = doc.history().map((e) => e.at);
    expect(doc.history().map((e) => e.summary)).toEqual(['one', 'two', 'four']);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    expect(new Set(ats).size).toBe(ats.length);
  });

  it('bounds undo depth at 200, evicting the oldest entries', () => {
    const doc = ShapeDocument.create({ textureWidth: 16, textureHeight: 16 });
    for (let i = 0; i < 205; i++) {
      doc.transact(`t${i}`, () => {
        doc.root.textures![`k${i}`] = `entity/test/${i}`;
      });
    }
    const h = doc.history();
    expect(h.length).toBe(200);
    expect(h[0]).toEqual({ summary: 't5', at: 6 });
    expect(h[199]).toEqual({ summary: 't204', at: 205 });

    let undone = 0;
    while (doc.undo() !== null) undone++;
    expect(undone).toBe(200);
    // the five evicted transactions' effects are baked in and not undoable
    expect(Object.keys(doc.root.textures!)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
  });
});

describe('ShapeDocument.create', () => {
  it('builds a minimal model-creator-style document that round-trips byte-identically', () => {
    const doc = ShapeDocument.create({ textureWidth: 32, textureHeight: 64 });
    expect(doc.root.textureWidth?.value).toBe(32);
    expect(doc.root.textureHeight?.value).toBe(64);
    expect(doc.root.editor).toBeDefined();
    expect(doc.root.textureSizes).toEqual({});
    expect(doc.root.textures).toEqual({});
    expect(doc.root.elements).toEqual([]);
    expect(doc.path).toBeUndefined();

    const text = doc.serialize();
    expect(text).toContain('\r\n'); // model-creator style: CRLF
    expect(text).toContain('\t"textureWidth": 32'); // tabs + int formatting
    // GROUND-TRUTH §8 top-level key order
    const order = ['editor', 'textureWidth', 'textureHeight', 'textureSizes', 'textures', 'elements'];
    const idx = order.map((k) => text.indexOf(`"${k}"`));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));

    const reparsed = ShapeDocument.parse(text);
    expect(reparsed.serialize()).toBe(text); // byte-stable round trip
    expect(reparsed.root.textureWidth?.value).toBe(32);
    expect(reparsed.root.elements).toEqual([]);
  });

  it('rejects non-positive or non-integer texture dimensions by name', () => {
    expect(() => ShapeDocument.create({ textureWidth: 0, textureHeight: 32 })).toThrowError(
      /textureWidth must be a positive integer/,
    );
    expect(() => ShapeDocument.create({ textureWidth: 32, textureHeight: 16.5 })).toThrowError(
      /textureHeight must be a positive integer/,
    );
  });
});

// --- fox corpus cases (skip cleanly without a game install) -------------------

const gamePath =
  process.env['VINTAGE_STORY'] ??
  (process.env['APPDATA'] ? join(process.env['APPDATA'], 'Vintagestory') : undefined);
const foxPath = gamePath
  ? join(gamePath, 'assets', 'survival', 'shapes', 'entity', 'animal', 'mammal', 'fox', 'fox-male.json')
  : undefined;
const foxAvailable = foxPath !== undefined && existsSync(foxPath);
if (!foxAvailable) {
  console.log(
    `[document] fox corpus tests SKIPPED: ${foxPath ?? '<no APPDATA/VINTAGE_STORY>'} not found`,
  );
}

describe.skipIf(!foxAvailable)('fox-male.json from the corpus', () => {
  const loadFox = () => {
    const text = readFileSync(foxPath!, 'utf8');
    return { text, doc: ShapeDocument.parse(text, { path: 'entity/animal/mammal/fox/fox-male.json' }) };
  };

  it('getElement/parentOf/walk work on the real tree', () => {
    const { doc } = loadFox();
    const body = doc.getElement('body');
    expect(body).toBeDefined();
    expect(body!.from.map((v) => v.value)).toEqual([4, 4, 6]);
    expect(doc.parentOf('body')).toBeNull();
    expect(doc.parentOf('neck')).toBe(body);

    let walked = 0;
    const names = new Set<string>();
    doc.walk((el) => {
      walked++;
      names.add(el.name);
    });
    expect(walked).toBe(manualCount(doc.root.elements)); // every element exactly once
    expect(names.size).toBe(walked); // fox names are unique
    expect(walked).toBe(19); // 1.22 fox-male has 19 elements
  });

  it('lists and resolves animations by code', () => {
    const { doc } = loadFox();
    const anims = doc.listAnimations();
    expect(anims.length).toBe(12);
    expect(doc.getAnimation('walk')?.name).toBe('Walk');
    expect(doc.getAnimation('walk')?.quantityframes.value).toBeGreaterThan(0);
    expect(doc.getAnimation('no-such-anim')).toBeUndefined();
  });

  it('serializes byte-identically, and transaction rollback/undo preserve the exact bytes', () => {
    const { text, doc } = loadFox();
    expect(doc.serialize()).toBe(text); // entity corpus is 100% byte-stable

    expect(() =>
      doc.transact('break the fox', () => {
        doc.getElement('tail')!.name = 'detached tail';
        doc.getAnimation('walk')!.keyframes.length = 0;
        throw new Error('abort');
      }),
    ).toThrowError('abort');
    expect(doc.serialize()).toBe(text);

    doc.transact('rename tail', () => {
      doc.getElement('tail')!.name = 'brush';
    });
    const edited = doc.serialize();
    expect(edited).not.toBe(text);
    expect(doc.undo()).toBe('rename tail');
    expect(doc.serialize()).toBe(text);
    expect(doc.redo()).toBe('rename tail');
    expect(doc.serialize()).toBe(edited);
  });
});
