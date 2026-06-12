/**
 * Pins for vs/elements.ts: add / edit / rename / delete / duplicate / import, including
 * the rename → keyframe cascade and the force-delete keyframe strip.
 */
import { describe, expect, it } from 'vitest';

import { ShapeDocument } from '../../src/vs/document.js';
import {
  addElement,
  deleteElement,
  duplicateElement,
  editElement,
  importElement,
  renameElement,
  reparentElement,
} from '../../src/vs/elements.js';
import type { FaceName } from '../../src/vs/types.js';

const docOf = (shape: unknown): ShapeDocument => ShapeDocument.parse(JSON.stringify(shape));

const face = (uv: number[] = [0, 0, 4, 4]): unknown => ({ texture: '#skin', uv });
const allFaces = (): Record<string, unknown> =>
  Object.fromEntries(['north', 'east', 'south', 'west', 'up', 'down'].map((f) => [f, face()]));

/** Body + two legs, one walk animation keying the left leg at frames 0 and 10. */
const rig = (): unknown => ({
  textureWidth: 32,
  textureHeight: 32,
  textures: { skin: 'entity/test/skin' },
  elements: [
    {
      name: 'body',
      from: [4, 4, 6],
      to: [8, 8, 10],
      faces: { north: face() },
      children: [
        { name: 'LegFrontLeft', from: [0, -4, 0], to: [1, 0, 1], faces: { north: face() } },
        { name: 'LegFrontRight', from: [3, -4, 0], to: [4, 0, 1], faces: { north: face() } },
      ],
    },
    { name: 'tail', from: [5, 5, 10], to: [7, 7, 14], faces: { north: face() } },
  ],
  animations: [
    {
      name: 'Walk',
      code: 'walk',
      quantityframes: 30,
      onActivityStopped: 'EaseOut',
      onAnimationEnd: 'Repeat',
      keyframes: [
        {
          frame: 0,
          elements: {
            LegFrontLeft: { rotationX: 30.0, rotationY: 0.0, rotationZ: 0.0 },
            tail: { rotationX: -5.0, rotationY: 0.0, rotationZ: 0.0 },
          },
        },
        {
          frame: 10,
          elements: { LegFrontLeft: { rotationX: -30.0, rotationY: 0.0, rotationZ: 0.0 } },
        },
      ],
    },
  ],
});

describe('addElement', () => {
  it("default 'auto-uv' creates 6 faces with the first texture key and [0,0,w,h] rects", () => {
    const doc = docOf(rig());
    const el = addElement(doc, { name: 'box', from: [0, 0, 0], to: [4, 3, 2] });
    expect(doc.getElement('box')).toBe(el);
    const faces = el.faces!;
    expect(Object.keys(faces)).toEqual(['north', 'east', 'south', 'west', 'up', 'down']);
    const rect = (f: FaceName): number[] => faces[f]!.uv.map((v) => v.value);
    expect(faces.north!.texture).toBe('#skin');
    expect(rect('north')).toEqual([0, 0, 4, 3]); // sizeX × sizeY
    expect(rect('east')).toEqual([0, 0, 2, 3]); // sizeZ × sizeY
    expect(rect('up')).toEqual([0, 0, 4, 2]); // sizeX × sizeZ
  });

  it("'{ all }' applies one texture/glow/rotation to all six auto-UV faces", () => {
    const doc = docOf(rig());
    const el = addElement(doc, {
      name: 'box',
      from: [0, 0, 0],
      to: [4, 3, 2],
      faces: { all: { texture: 'fur', glow: 200, rotation: 90 } },
    });
    const faces = el.faces!;
    expect(Object.keys(faces)).toEqual(['north', 'east', 'south', 'west', 'up', 'down']);
    for (const f of Object.keys(faces) as FaceName[]) {
      expect(faces[f]!.texture).toBe('#fur'); // '#' prepended, same key on every face
      expect(faces[f]!.glow!.value).toBe(200);
      expect(faces[f]!.rotation!.value).toBe(90);
    }
    // UVs are still auto-computed per face (same rects as 'auto-uv').
    expect(faces.east!.uv.map((v) => v.value)).toEqual([0, 0, 2, 3]); // sizeZ × sizeY
  });

  it("'{ all }' can disable every face and rejects an invalid uv rotation", () => {
    const doc = docOf(rig());
    const el = addElement(doc, {
      name: 'hidden',
      from: [0, 0, 0],
      to: [2, 2, 2],
      faces: { all: { enabled: false } },
    });
    for (const f of Object.values(el.faces!)) expect(f!.enabled).toBe(false);
    expect(() =>
      addElement(doc, { name: 'bad', from: [0, 0, 0], to: [1, 1, 1], faces: { all: { rotation: 45 } } }),
    ).toThrow(/rotation must be 0, 90, 180 or 270/);
  });

  it("'none' adds no faces; parent nests the element; rotation fields are written", () => {
    const doc = docOf(rig());
    const el = addElement(doc, {
      parent: 'body',
      name: 'ear',
      from: [0, 0, 0],
      to: [1, 1, 1],
      rotationOrigin: [0.5, 0, 0.5],
      rotation: { z: -15 },
      faces: 'none',
    });
    expect(el.faces).toBeUndefined();
    expect(el.rotationZ!.value).toBe(-15);
    expect(doc.getElement('body')!.children!.at(-1)).toBe(el);
  });

  it('refuses duplicate names naming the holder and unknown parents with near-misses', () => {
    const doc = docOf(rig());
    expect(() => addElement(doc, { name: 'tail', from: [0, 0, 0], to: [1, 1, 1] })).toThrow(
      /'tail' already exists \(at root level\)/,
    );
    expect(() =>
      addElement(doc, { parent: 'bodi', name: 'x', from: [0, 0, 0], to: [1, 1, 1] }),
    ).toThrow(/did you mean 'body'/);
  });

  it("'skin' fallback applies when the shape has no textures", () => {
    const doc = ShapeDocument.create({ textureWidth: 16, textureHeight: 16 });
    const el = addElement(doc, { name: 'a', from: [0, 0, 0], to: [1, 1, 1] });
    expect(el.faces!.north!.texture).toBe('#skin');
  });
});

describe('editElement', () => {
  it('patches fields and deletes them via null', () => {
    const doc = docOf(rig());
    const el = editElement(doc, 'tail', { to: [8, 8, 15], rotationX: 12 });
    expect(el.to.map((v) => v.value)).toEqual([8, 8, 15]);
    expect(el.rotationX!.value).toBe(12);
    editElement(doc, 'tail', { rotationX: null });
    expect(el.rotationX).toBeUndefined();
  });

  it('unknown elements get near-miss candidates', () => {
    const doc = docOf(rig());
    expect(() => editElement(doc, 'tial', {})).toThrow(/did you mean 'tail'/);
  });
});

describe('renameElement — keyframe cascade', () => {
  it('renames the element inside EVERY animation keyframe elements map', () => {
    const doc = docOf(rig());
    const result = renameElement(doc, 'LegFrontLeft', 'FL');
    expect(result).toEqual({ keyframesUpdated: 2, animationsUpdated: ['walk'] });
    expect(doc.getElement('FL')).toBeDefined();
    expect(doc.getElement('LegFrontLeft')).toBeUndefined();
    const anim = doc.getAnimation('walk')!;
    for (const kf of anim.keyframes) {
      expect(Object.keys(kf.elements)).not.toContain('LegFrontLeft');
    }
    expect(anim.keyframes[0]!.elements['FL']!.rotationX!.value).toBe(30);
    expect(anim.keyframes[1]!.elements['FL']!.rotationX!.value).toBe(-30);
    // The untouched sibling entry survives.
    expect(anim.keyframes[0]!.elements['tail']!.rotationX!.value).toBe(-5);
  });

  it('refuses a collision naming the holder', () => {
    const doc = docOf(rig());
    expect(() => renameElement(doc, 'LegFrontLeft', 'tail')).toThrow(
      /'tail' already exists \(at root level\)/,
    );
    expect(() => renameElement(doc, 'tail', 'LegFrontRight')).toThrow(/child of 'body'/);
  });

  it('refuses to rename onto a stale keyframe reference, naming the animation and frame', () => {
    const doc = docOf(rig());
    const anim = doc.getAnimation('walk')!;
    anim.keyframes[0]!.elements['ghost'] = anim.keyframes[0]!.elements['tail']!;
    expect(() => renameElement(doc, 'LegFrontLeft', 'ghost')).toThrow(
      /animation 'walk' keyframe at frame 0 already contains an entry named 'ghost'/,
    );
  });

  it('unknown source names get near-miss candidates', () => {
    const doc = docOf(rig());
    expect(() => renameElement(doc, 'LegFrontLfet', 'x')).toThrow(/did you mean 'LegFrontLeft'/);
  });
});

describe('deleteElement', () => {
  it('without force, throws listing every referencing animation code and frames', () => {
    const doc = docOf(rig());
    expect(() => deleteElement(doc, 'body')).toThrow(/'walk' \(frames 0, 10\)/);
    // Subtree names appear in the message (the reference is via the child).
    expect(() => deleteElement(doc, 'body')).toThrow(/LegFrontLeft/);
    expect(doc.getElement('body')).toBeDefined(); // nothing was mutated
  });

  it('with force, strips the keyframe entries, prunes emptied keyframes, and reports', () => {
    const doc = docOf(rig());
    const result = deleteElement(doc, 'body', { force: true });
    expect(result.strippedFrom).toEqual([{ animation: 'walk', frames: [0, 10] }]);
    expect(doc.getElement('body')).toBeUndefined();
    expect(doc.getElement('LegFrontLeft')).toBeUndefined();
    const anim = doc.getAnimation('walk')!;
    // Frame 0 keeps the unrelated 'tail' entry; frame 10 became empty and was pruned.
    expect(anim.keyframes.map((kf) => kf.frame.value)).toEqual([0]);
    expect(Object.keys(anim.keyframes[0]!.elements)).toEqual(['tail']);
  });

  it('deletes unreferenced elements without force and returns an empty report', () => {
    const doc = docOf(rig());
    const result = deleteElement(doc, 'LegFrontRight');
    expect(result.strippedFrom).toEqual([]);
    expect(doc.getElement('LegFrontRight')).toBeUndefined();
  });
});

describe('duplicateElement', () => {
  it("deep-copies the subtree, unique-ifying every name with the '2', '3', … suffix", () => {
    const doc = docOf(rig());
    const map = duplicateElement(doc, 'body');
    expect(map).toEqual({
      body: 'body2',
      LegFrontLeft: 'LegFrontLeft2',
      LegFrontRight: 'LegFrontRight2',
    });
    const copy = doc.getElement('body2')!;
    expect(copy.children!.map((c) => c.name)).toEqual(['LegFrontLeft2', 'LegFrontRight2']);
    // Deep independence: no node (or VsNum) is shared with the original.
    const orig = doc.getElement('body')!;
    expect(copy.from[0]).not.toBe(orig.from[0]);
    expect(copy.children![0]).not.toBe(orig.children![0]);
    const again = duplicateElement(doc, 'body');
    expect(again['body']).toBe('body3');
  });

  it('uses an explicit newName for the root and throws when it collides', () => {
    const doc = docOf(rig());
    const map = duplicateElement(doc, 'tail', 'tail-copy');
    expect(map).toEqual({ tail: 'tail-copy' });
    expect(() => duplicateElement(doc, 'tail', 'body')).toThrow(/'body' is already used/);
  });

  it('inserts the copy right after the original among its siblings', () => {
    const doc = docOf(rig());
    duplicateElement(doc, 'LegFrontLeft');
    expect(doc.getElement('body')!.children!.map((c) => c.name)).toEqual([
      'LegFrontLeft',
      'LegFrontLeft2',
      'LegFrontRight',
    ]);
  });
});

describe('importElement', () => {
  const sourceShape = (): unknown => ({
    textureWidth: 32,
    textureHeight: 32,
    textureSizes: { fur: [64, 64] },
    textures: { skin: 'entity/other/skin', fur: 'entity/other/fur' },
    elements: [
      {
        name: 'tail',
        from: [0, 0, 0],
        to: [2, 2, 6],
        faces: { north: { texture: '#skin', uv: [0, 0, 2, 2] }, up: { texture: '#fur', uv: [0, 0, 2, 6] } },
        children: [{ name: 'tuft', from: [0, 0, 0], to: [1, 1, 1], faces: { north: { texture: '#fur', uv: [4, 4, 5, 5] } } }],
      },
    ],
  });

  it('copies the subtree, unique-ifies names, copies missing texture keys, remaps colliding ones', () => {
    const doc = docOf(rig());
    const fromDoc = docOf(sourceShape());
    const result = importElement(doc, fromDoc, 'tail', { parent: 'body' });
    // 'tail' exists in the target → tail2; 'tuft' is free but still unique-ified to itself.
    expect(result.names).toEqual({ tail: 'tail2', tuft: 'tuft' });
    // 'fur' was missing → copied (with its textureSizes entry); 'skin' differs → remapped.
    expect(result.texturesCopied).toEqual(['fur']);
    expect(result.texturesRemapped).toEqual({ skin: 'skin2' });
    expect(doc.root.textures!['fur']).toBe('entity/other/fur');
    expect(doc.root.textures!['skin2']).toBe('entity/other/skin');
    expect(doc.root.textures!['skin']).toBe('entity/test/skin'); // untouched
    expect(doc.root.textureSizes!['fur']!.map((v) => v.value)).toEqual([64, 64]);
    const copy = doc.getElement('tail2')!;
    expect(copy.faces!.north!.texture).toBe('#skin2'); // remapped ref
    expect(copy.faces!.up!.texture).toBe('#fur'); // copied ref untouched
    expect(doc.getElement('body')!.children!.at(-1)!.name).toBe('tail2');
    // Source document untouched.
    expect(fromDoc.getElement('tail')!.faces!.north!.texture).toBe('#skin');
    expect(Object.keys(fromDoc.root.textures!)).toEqual(['skin', 'fur']);
  });

  it('identical texture paths in an identical UV space are left alone (no copy, no remap)', () => {
    const doc = docOf(rig());
    const fromDoc = docOf({
      textureWidth: 32,
      textureHeight: 32,
      textures: { skin: 'entity/test/skin' },
      elements: [{ name: 'fin', from: [0, 0, 0], to: [1, 1, 1], faces: { north: { texture: '#skin', uv: [0, 0, 1, 1] } } }],
    });
    const result = importElement(doc, fromDoc, 'fin');
    expect(result.texturesCopied).toEqual([]);
    expect(result.texturesRemapped).toEqual({});
    expect(result.textureSizesAdded).toEqual({});
    expect(doc.getElement('fin')!.faces!.north!.texture).toBe('#skin');
  });

  it('synthesizes a textureSizes override when the source shape-wide UV space differs', () => {
    const doc = docOf(rig()); // 32×32
    const fromDoc = docOf({
      textureWidth: 60,
      textureHeight: 76,
      textures: { antler: 'entity/deer/antlers' },
      elements: [
        {
          name: 'horn',
          from: [0, 0, 0],
          to: [1, 2, 1],
          faces: { north: { texture: '#antler', uv: [44, 74, 45, 75] } },
        },
      ],
    });
    const result = importElement(doc, fromDoc, 'horn', { parent: 'body' });
    expect(result.texturesCopied).toEqual(['antler']);
    expect(result.textureSizesAdded).toEqual({ antler: [60, 76] });
    expect(doc.root.textureSizes!['antler']!.map((v) => v.value)).toEqual([60, 76]);
  });

  it('same path authored against a different UV space is remapped to a fresh key with its own size', () => {
    const doc = docOf(rig()); // skin: entity/test/skin in 32×32
    const fromDoc = docOf({
      textureWidth: 64,
      textureHeight: 64,
      textures: { skin: 'entity/test/skin' }, // same path, different UV space
      elements: [
        {
          name: 'fin',
          from: [0, 0, 0],
          to: [1, 1, 1],
          faces: { north: { texture: '#skin', uv: [40, 40, 42, 42] } },
        },
      ],
    });
    const result = importElement(doc, fromDoc, 'fin', { parent: 'body' });
    expect(result.texturesRemapped).toEqual({ skin: 'skin2' });
    expect(result.textureSizesAdded).toEqual({ skin2: [64, 64] });
    expect(doc.root.textures!['skin2']).toBe('entity/test/skin');
    expect(doc.getElement('fin')!.faces!.north!.texture).toBe('#skin2');
  });

  it('strips stepParentName when importing under a parent, keeps it for root-level imports', () => {
    const overlay = (): unknown => ({
      textureWidth: 32,
      textureHeight: 32,
      textures: { skin: 'entity/test/skin' },
      elements: [
        {
          name: 'mount',
          stepParentName: 'head',
          from: [0, 0, 0],
          to: [1, 1, 1],
          children: [{ name: 'spike', stepParentName: 'other', from: [0, 0, 0], to: [1, 1, 1] }],
        },
      ],
    });
    const under = docOf(rig());
    const r1 = importElement(under, docOf(overlay()), 'mount', { parent: 'body' });
    expect(r1.stepParentsStripped).toEqual(['mount', 'spike']);
    expect(under.getElement('mount')!.stepParentName).toBeUndefined();
    expect(under.getElement('spike')!.stepParentName).toBeUndefined();

    const atRoot = docOf(rig());
    const r2 = importElement(atRoot, docOf(overlay()), 'mount');
    expect(r2.stepParentsStripped).toEqual([]);
    expect(atRoot.getElement('mount')!.stepParentName).toBe('head');
  });

  it('names unknown source elements against the SOURCE document', () => {
    const doc = docOf(rig());
    const fromDoc = docOf(sourceShape());
    expect(() => importElement(doc, fromDoc, 'tial')).toThrow(/did you mean 'tail'/);
    expect(() => importElement(doc, fromDoc, 'tial')).toThrow(/source document/);
  });
});

describe('moved subtrees re-indent at their new depth', () => {
  // Model-creator-style text with known tab depths: element items at 2 tabs (props 3),
  // body>head children items at 4 tabs (props 5). A subtree imported/reparented under
  // 'head' must emit its props at 7 tabs — not at the depth its SOURCE file had.
  const targetText = [
    '{',
    '\t"textureWidth": 32,',
    '\t"textureHeight": 32,',
    '\t"textures": {',
    '\t\t"skin": "entity/test/skin"',
    '\t},',
    '\t"elements": [',
    '\t\t{',
    '\t\t\t"name": "body",',
    '\t\t\t"from": [ 0.0, 0.0, 0.0 ],',
    '\t\t\t"to": [ 4.0, 4.0, 4.0 ],',
    '\t\t\t"children": [',
    '\t\t\t\t{',
    '\t\t\t\t\t"name": "head",',
    '\t\t\t\t\t"from": [ 0.0, 0.0, 0.0 ],',
    '\t\t\t\t\t"to": [ 2.0, 2.0, 2.0 ]',
    '\t\t\t\t}',
    '\t\t\t]',
    '\t\t},',
    '\t\t{',
    '\t\t\t"name": "tail",',
    '\t\t\t"from": [ 0.0, 0.0, 4.0 ],',
    '\t\t\t"to": [ 1.0, 1.0, 8.0 ]',
    '\t\t},',
    '\t\t{',
    '\t\t\t"name": "base",',
    '\t\t\t"from": [ 8.0, 0.0, 0.0 ],',
    '\t\t\t"to": [ 9.0, 1.0, 1.0 ]',
    '\t\t}',
    '\t]',
    '}',
  ].join('\r\n');
  const sourceText = [
    '{',
    '\t"textureWidth": 32,',
    '\t"textureHeight": 32,',
    '\t"textures": {',
    '\t\t"skin": "entity/test/skin"',
    '\t},',
    '\t"elements": [',
    '\t\t{',
    '\t\t\t"name": "horn",',
    '\t\t\t"from": [ 0.0, 0.0, 0.0 ],',
    '\t\t\t"to": [ 1.0, 2.0, 1.0 ],',
    '\t\t\t"children": [',
    '\t\t\t\t{',
    '\t\t\t\t\t"name": "tip",',
    '\t\t\t\t\t"from": [ 0.0, 2.0, 0.0 ],',
    '\t\t\t\t\t"to": [ 1.0, 3.0, 1.0 ]',
    '\t\t\t\t}',
    '\t\t\t]',
    '\t\t}',
    '\t]',
    '}',
  ].join('\r\n');

  it('importElement emits the copy at the target depth, not the source-file depth', () => {
    const doc = ShapeDocument.parse(targetText);
    const fromDoc = ShapeDocument.parse(sourceText);
    importElement(doc, fromDoc, 'horn', { parent: 'head' });
    const out = doc.serialize();
    // horn props live under elements[0].children[0].children[0] → 7 tabs; tip → 9 tabs.
    expect(out).toMatch(/\r\n\t{7}"name": "horn"/);
    expect(out).toMatch(/\r\n\t{9}"name": "tip"/);
    // The source file authored them at 3 and 5 tabs — the old mis-indent must be gone.
    expect(out).not.toMatch(/\r\n\t{3}"name": "horn"/);
  });

  it('reparentElement re-indents on depth change and keeps bytes on same-depth moves', () => {
    const doc = ShapeDocument.parse(targetText);
    reparentElement(doc, 'tail', 'head'); // root level (3-tab props) → under head (7-tab props)
    const out = doc.serialize();
    expect(out).toMatch(/\r\n\t{7}"name": "tail"/);
    expect(out).not.toMatch(/\r\n\t{3}"name": "tail"/);

    const doc2 = ShapeDocument.parse(targetText);
    reparentElement(doc2, 'head', 'base'); // depth 1 → depth 1: preserved layout keeps its bytes
    expect(doc2.serialize()).toContain('\t\t\t\t\t"name": "head",');
  });
});
