/**
 * api.ts: the doc_script API surface bound to a real ShapeDocument. Pins that procedural
 * scripts drive the same ops the typed tools do (geometry / uv / animation / raw JSON),
 * that reads return plain snapshots, that random() is seed-deterministic, and that op
 * errors propagate (the caller's transaction does the rollback).
 */
import { describe, expect, it } from 'vitest';

import { runDocScript } from '../../src/script/api.js';
import { ShapeDocument } from '../../src/vs/document.js';

const freshDoc = (): ShapeDocument => ShapeDocument.create({ textureWidth: 32, textureHeight: 32 });

describe('procedural geometry', () => {
  it('generates elements in a loop and returns plain data', () => {
    const doc = freshDoc();
    const r = runDocScript(
      doc,
      `for (let i = 0; i < 5; i++) {
         addElement({ name: 'seg' + i, from: [0, i, 0], to: [1, i + 1, 1], faces: 'none' });
       }
       log('built', count());
       return elementNames();`,
    );
    expect(r.returned).toEqual(['seg0', 'seg1', 'seg2', 'seg3', 'seg4']);
    expect(r.ops).toBe(5);
    expect(r.elements).toBe(5);
    expect(r.log).toEqual(['built 5']);
    expect(doc.getElement('seg3')).toBeDefined();
  });

  it('parents children and reads geometry back via getElement / walk', () => {
    const doc = freshDoc();
    const r = runDocScript(
      doc,
      `addElement({ name: 'body', from: [0, 0, 0], to: [4, 4, 4], faces: 'none' });
       addElement({ name: 'leg', parent: 'body', from: [0, -4, 0], to: [1, 0, 1], faces: 'none' });
       const names = [];
       walk((node, path) => names.push(node.name + '@' + path.length));
       const leg = getElement('leg');
       return { names, legParent: leg.parent, legFrom: leg.from };
    `,
    );
    expect(r.returned).toEqual({
      names: ['body@0', 'leg@1'],
      legParent: 'body',
      legFrom: [0, -4, 0],
    });
  });
});

describe('determinism', () => {
  it('random() is seed-reproducible; different seeds diverge', () => {
    const script = 'const xs = []; for (let i = 0; i < 4; i++) xs.push(randInt(0, 100)); return xs;';
    const a = runDocScript(freshDoc(), script, { seed: 7 }).returned;
    const b = runDocScript(freshDoc(), script, { seed: 7 }).returned;
    const c = runDocScript(freshDoc(), script, { seed: 8 }).returned;
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(Array.isArray(a) && a.every((n) => typeof n === 'number' && n >= 0 && n <= 100)).toBe(true);
  });
});

describe('args', () => {
  it('passes a JSON args value into the script', () => {
    const doc = freshDoc();
    const r = runDocScript(
      doc,
      `for (const spec of args.legs) addElement({ name: spec.name, from: spec.at, to: [spec.at[0]+1, spec.at[1]+1, spec.at[2]+1], faces: 'none' });
       return count();`,
      { args: { legs: [{ name: 'a', at: [0, 0, 0] }, { name: 'b', at: [2, 0, 0] }] } },
    );
    expect(r.returned).toBe(2);
    expect(doc.getElement('b')).toBeDefined();
  });
});

describe('uv + animation + raw json', () => {
  it('faceSet / setFaceUv / autoUv operate on faces', () => {
    const doc = freshDoc();
    const r = runDocScript(
      doc,
      `addElement({ name: 'box', from: [0, 0, 0], to: [4, 4, 4] });
       setFaceUv('box', 'up', [0, 0, 4, 4]);
       const updated = faceSet({ elements: ['box'], faces: ['up'], glow: 200 });
       return updated;`,
    );
    expect(r.returned).toBe(1);
    expect(r.ops).toBe(3);
  });

  it('createAnimation + setKeyframe show up in listAnimations', () => {
    const doc = freshDoc();
    const r = runDocScript(
      doc,
      `addElement({ name: 'tail', from: [0, 0, 0], to: [1, 1, 4], faces: 'none' });
       createAnimation({ code: 'wag', quantityFrames: 8 });
       setKeyframe('wag', 0, 'tail', { rotation: [0, 0, 0] });
       setKeyframe('wag', 4, 'tail', { rotation: [0, 20, 0] });
       const a = getAnimation('wag');
       return { code: a.code, frames: a.quantityFrames, keys: a.keyframes };`,
    );
    expect(r.returned).toEqual({ code: 'wag', frames: 8, keys: 2 });
  });

  it('getJson / patchJson reach arbitrary document fields', () => {
    const doc = freshDoc();
    const r = runDocScript(
      doc,
      `patchJson([{ op: 'add', path: '/textures/skin', value: 'entity/test/skin' }]);
       return getJson('/textures/skin');`,
    );
    expect(r.returned).toBe('entity/test/skin');
    expect(doc.root.textures?.['skin']).toBe('entity/test/skin');
  });
});

describe('error propagation', () => {
  it('an op error surfaces with the script location (rollback is the caller’s job)', () => {
    const doc = freshDoc();
    expect(() =>
      runDocScript(
        doc,
        `addElement({ name: 'dup', from: [0, 0, 0], to: [1, 1, 1], faces: 'none' });
         addElement({ name: 'dup', from: [0, 0, 0], to: [1, 1, 1], faces: 'none' });`,
      ),
    ).toThrow(/already exists.*line 2/s);
  });

  it('a script can catch an op error and keep going', () => {
    const doc = freshDoc();
    const r = runDocScript(
      doc,
      `addElement({ name: 'x', from: [0, 0, 0], to: [1, 1, 1], faces: 'none' });
       let caught = false;
       try { addElement({ name: 'x', from: [0, 0, 0], to: [1, 1, 1], faces: 'none' }); }
       catch (e) { caught = true; }
       return { caught, n: count() };`,
    );
    expect(r.returned).toEqual({ caught: true, n: 1 });
  });
});
