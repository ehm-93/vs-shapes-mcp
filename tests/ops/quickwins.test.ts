/**
 * Pins for the dogfooding quick-wins batch: setFaceProps, setKeyframe
 * rotShortestDistance, editElement scale fields, incremental autoUv,
 * planAutoUvFit, and the shape/detached-child lint.
 */
import { describe, expect, it } from 'vitest';

import { ShapeDocument } from '../../src/vs/document.js';
import { addElement, editElement } from '../../src/vs/elements.js';
import { createAnimation, setKeyframe } from '../../src/vs/animation.js';
import { autoUv, planAutoUvFit, setFaceProps, uvReport } from '../../src/vs/uv.js';
import { validateDocument } from '../../src/vs/validate.js';

const docOf = (shape: unknown): ShapeDocument => ShapeDocument.parse(JSON.stringify(shape));

const face = (uv: number[] = [0, 0, 4, 4]): unknown => ({ texture: '#skin', uv });

const rig = (): unknown => ({
  textureWidth: 32,
  textureHeight: 32,
  textures: { skin: 'entity/test/skin', dark: 'entity/test/dark' },
  elements: [
    {
      name: 'body',
      from: [4, 4, 6],
      to: [8, 8, 10],
      faces: { north: face(), down: face() },
      children: [
        { name: 'leg', from: [0, -4, 0], to: [1, 0, 1], faces: { north: face([0, 8, 1, 12]), east: face([2, 8, 3, 12]) } },
        { name: 'eye', from: [-0.5, 1, 1], to: [0, 2, 2], faces: { north: face([10, 10, 10.5, 11]) } },
      ],
    },
  ],
});

describe('setFaceProps', () => {
  it('retextures and glows selected faces, subtree-recursive, without touching UVs', () => {
    const doc = docOf(rig());
    const before = doc.getElement('leg')!.faces!.north!.uv.map((v) => v.value);
    const result = setFaceProps(doc, ['body'], { texture: 'dark', glow: 200 }, { subtree: true });
    expect(result.facesUpdated).toBe(5); // body 2 + leg 2 + eye 1
    expect(Object.keys(result.updated).sort()).toEqual(['body', 'eye', 'leg']);
    expect(doc.getElement('leg')!.faces!.north!.texture).toBe('#dark');
    expect(doc.getElement('leg')!.faces!.north!.glow!.value).toBe(200);
    expect(doc.getElement('leg')!.faces!.north!.uv.map((v) => v.value)).toEqual(before);
  });

  it('face filter, enabled false, and glow null removal', () => {
    const doc = docOf(rig());
    setFaceProps(doc, ['leg'], { glow: 255, enabled: false }, { faces: ['north'] });
    const north = doc.getElement('leg')!.faces!.north!;
    expect(north.glow!.value).toBe(255);
    expect(north.enabled).toBe(false);
    expect(doc.getElement('leg')!.faces!.east!.glow).toBeUndefined(); // filtered out
    setFaceProps(doc, ['leg'], { glow: null, enabled: true }, { faces: ['north'] });
    expect(north.glow).toBeUndefined();
    expect(north.enabled).toBeUndefined();
  });

  it('actionable errors: nothing to change, no matching faces, bad glow', () => {
    const doc = docOf(rig());
    expect(() => setFaceProps(doc, ['body'], {})).toThrow(/nothing to change/);
    expect(() => setFaceProps(doc, ['body'], { glow: 300 })).toThrow(/0–255/);
    expect(() => setFaceProps(doc, ['eye'], { texture: 'dark' }, { faces: ['down'] })).toThrow(
      /no matching faces/,
    );
  });
});

describe('setKeyframe rotShortestDistance', () => {
  it('sets, merges, and clears per-axis flags alongside the rotation channel', () => {
    const doc = docOf(rig());
    createAnimation(doc, { code: 'spin', quantityFrames: 20 });
    const entry = setKeyframe(doc, 'spin', 0, 'body', {
      rotation: [0, 0, 120],
      rotShortestDistance: { z: true },
    })!;
    expect(entry.rotShortestDistanceZ).toBe(true);
    expect(entry.rotShortestDistanceX).toBeUndefined();
    setKeyframe(doc, 'spin', 0, 'body', { rotShortestDistance: { x: true, z: false } });
    expect(entry.rotShortestDistanceX).toBe(true);
    expect(entry.rotShortestDistanceZ).toBeUndefined();
    expect(entry.rotationZ!.value).toBe(120); // rotation untouched by a flags-only call
    setKeyframe(doc, 'spin', 0, 'body', { rotShortestDistance: null });
    expect(entry.rotShortestDistanceX).toBeUndefined();
  });
});

describe('editElement scale fields', () => {
  it('sets and clears scaleX/Y/Z, rejecting non-positive values', () => {
    const doc = docOf(rig());
    const el = editElement(doc, 'body', { scaleZ: 1.25, scaleY: 2 });
    expect(el.scaleZ!.value).toBe(1.25);
    expect(el.scaleY!.value).toBe(2);
    editElement(doc, 'body', { scaleY: null });
    expect(el.scaleY).toBeUndefined();
    expect(() => editElement(doc, 'body', { scaleX: 0 })).toThrow(/> 0/);
    expect(() => editElement(doc, 'body', { scaleX: -1 })).toThrow(/element_mirror/);
  });
});

describe('autoUv incremental + planAutoUvFit', () => {
  it('packs only the listed elements, into space no other face occupies', () => {
    const doc = docOf(rig());
    autoUv(doc); // full pack first
    const legBefore = doc.getElement('leg')!.faces!.north!.uv.map((v) => v.value);
    addElement(doc, { parent: 'body', name: 'horn', from: [0, 4, 1], to: [1, 7, 2] });
    const result = autoUv(doc, ['horn']);
    // Existing layout untouched.
    expect(doc.getElement('leg')!.faces!.north!.uv.map((v) => v.value)).toEqual(legBefore);
    // New rects overlap nothing (same-key faces) — uvReport must show zero overlaps.
    const report = uvReport(doc).find((r) => r.textureKey === 'skin')!;
    expect(report.overlaps).toEqual([]);
    expect(result.faces.length).toBe(6);
    for (const f of result.faces) {
      expect(f.rect[2]).toBeLessThanOrEqual(32);
      expect(f.rect[3]).toBeLessThanOrEqual(32);
    }
  });

  it('errors helpfully when no free space remains', () => {
    const doc = docOf({
      textureWidth: 4,
      textureHeight: 4,
      textures: { skin: 't' },
      elements: [
        { name: 'a', from: [0, 0, 0], to: [4, 4, 4], faces: { north: { texture: '#skin', uv: [0, 0, 4, 4] } } },
        { name: 'b', from: [0, 0, 0], to: [4, 4, 4], faces: { north: { texture: '#skin', uv: [0, 0, 4, 4] } } },
      ],
    });
    expect(() => autoUv(doc, ['b'])).toThrow(/no free space/);
  });

  it('planAutoUvFit reports the doubled sheet a full repack would need', () => {
    const doc = docOf(rig());
    expect(planAutoUvFit(doc).fits).toBe(true);
    const tiny = docOf({
      textureWidth: 4,
      textureHeight: 4,
      textures: { skin: 't' },
      elements: [{ name: 'big', from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: '#skin', uv: [0, 0, 4, 4] } } }],
    });
    const plan = planAutoUvFit(tiny);
    expect(plan.fits).toBe(false);
    expect(plan.neededWidth).toBeGreaterThanOrEqual(16);
    expect(plan.neededHeight).toBeGreaterThanOrEqual(16);
  });
});

describe('shape/detached-child', () => {
  it('fires on a child box fully disjoint from its parent (the floating-arms bug)', () => {
    const doc = docOf(rig());
    // anchored 11.8 units in FRONT of the parent's from corner, like the tyrant arms bug
    addElement(doc, { parent: 'body', name: 'arm', from: [-11.8, 0.5, 1], to: [-9.8, 1.7, 2] });
    const findings = validateDocument(doc).filter((f) => f.code === 'shape/detached-child');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.element).toBe('arm');
    expect(findings[0]!.severity).toBe('note');
    expect(findings[0]!.message).toMatch(/X gap 9\.8/);
  });

  it('stays silent for overlapping children and face-touching surface decor', () => {
    const doc = docOf(rig());
    // touches the parent's +y face exactly (growth/quill pattern)
    addElement(doc, { parent: 'body', name: 'quill', from: [1, 4, 1], to: [1.5, 7, 1.5] });
    const findings = validateDocument(doc).filter((f) => f.code === 'shape/detached-child');
    expect(findings).toEqual([]);
  });
});
