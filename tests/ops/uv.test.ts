/**
 * Pins for vs/uv.ts: uvReport (bounds / shared / overlap / fractional / occupancy),
 * setFaceUv, and the shelf-packing autoUv (including the round-trip through uvReport).
 */
import { describe, expect, it } from 'vitest';

import { ShapeDocument } from '../../src/vs/document.js';
import { autoUv, setFaceUv, uvReport, UV_REPORT_MAX_OVERLAPS } from '../../src/vs/uv.js';

const docOf = (shape: unknown): ShapeDocument => ShapeDocument.parse(JSON.stringify(shape));

const el = (name: string, faces: Record<string, unknown>, dims: number[] = [4, 4, 4]): unknown => ({
  name,
  from: [0, 0, 0],
  to: dims,
  faces,
});

describe('uvReport', () => {
  it('flags out-of-bounds rects, fractional coords, shared rects and partial overlaps', () => {
    const doc = docOf({
      textureWidth: 16,
      textureHeight: 16,
      textures: { skin: 's' },
      elements: [
        el('A', { north: { texture: '#skin', uv: [0, 0, 4, 4] } }),
        el('B', {
          north: { texture: '#skin', uv: [2, 2, 6, 6] }, // partial overlap with A.north
          east: { texture: '#skin', uv: [0, 0, 4, 4] }, // identical to A.north → shared
        }),
        el('C', {
          north: { texture: '#skin', uv: [14, 0, 18, 4] }, // out of bounds (u2 = 18 > 16)
          west: { texture: '#skin', uv: [0.5, 8, 4.5, 12] }, // fractional coords
        }),
      ],
    });
    const reports = uvReport(doc);
    expect(reports).toHaveLength(1);
    const r = reports[0]!;
    expect(r.textureKey).toBe('skin');
    expect(r.textureWidth).toBe(16);
    expect(r.faces).toHaveLength(5);

    expect(r.outOfBounds.map((f) => `${f.element}/${f.face}`)).toEqual(['C/north']);
    expect(r.fractional.map((f) => `${f.element}/${f.face}`)).toEqual(['C/west']);

    const byKind = (kind: string): string[] =>
      r.overlaps
        .filter((o) => o.kind === kind)
        .map((o) => `${o.a.element}/${o.a.face}+${o.b.element}/${o.b.face}`);
    expect(byKind('shared')).toEqual(['A/north+B/east']);
    expect(byKind('overlap')).toEqual(['A/north+B/north']);
    const partial = r.overlaps.find((o) => o.kind === 'overlap')!;
    expect(partial.rect).toEqual([2, 2, 4, 4]); // the intersection

    // Union area: A∪B.north = 28, B.east shares A's cells, C.north clamps to 2×4 = 8,
    // C.west = 16 → 52 of 256 units² = 20.3125%.
    expect(r.occupancyPercent).toBeCloseTo(20.3125, 6);
  });

  it('same-element faces never count as overlaps; missing uv falls back to the engine auto rect', () => {
    const doc = docOf({
      textureWidth: 16,
      textureHeight: 16,
      textures: { skin: 's' },
      elements: [
        el('solo', {
          north: { texture: '#skin', uv: [0, 0, 8, 8] },
          south: { texture: '#skin', uv: [0, 0, 8, 8] }, // identical, same element → fine
          up: { texture: '#skin' }, // no uv → engine auto [0, 0, sizeX, sizeZ]
        }),
      ],
    });
    const r = uvReport(doc)[0]!;
    expect(r.overlaps).toEqual([]);
    const auto = r.faces.find((f) => f.face === 'up')!;
    expect(auto.autoUv).toBe(true);
    expect(auto.rect).toEqual([0, 0, 4, 4]);
    // Single 8×8 rect dominates the union: (64 + 0 extra from the contained 4×4)/256.
    expect(r.occupancyPercent).toBeCloseTo(25, 6);
  });

  it('groups faces per texture key and skips disabled faces', () => {
    const doc = docOf({
      textureWidth: 16,
      textureHeight: 16,
      textures: { skin: 's', fur: 'f' },
      elements: [
        el('A', {
          north: { texture: '#skin', uv: [0, 0, 4, 4] },
          south: { texture: '#fur', uv: [0, 0, 4, 4] },
          up: { texture: '#skin', uv: [0, 0, 4, 4], enabled: false },
        }),
      ],
    });
    const reports = uvReport(doc);
    expect(reports.map((r) => r.textureKey).sort()).toEqual(['fur', 'skin']);
    expect(reports.find((r) => r.textureKey === 'skin')!.faces).toHaveLength(1); // up skipped
  });
});

describe('setFaceUv', () => {
  it('sets the rect and rotation; rotation 0 removes the key (vanilla convention)', () => {
    const doc = docOf({
      textureWidth: 16,
      textureHeight: 16,
      textures: { skin: 's' },
      elements: [el('A', { north: { texture: '#skin', uv: [0, 0, 4, 4], rotation: 90 } })],
    });
    const f = setFaceUv(doc, 'A', 'north', [4, 4, 8, 8], 270);
    expect(f.uv.map((v) => v.value)).toEqual([4, 4, 8, 8]);
    expect(f.rotation!.value).toBe(270);
    setFaceUv(doc, 'A', 'north', [4, 4, 8, 8], 0);
    expect(f.rotation).toBeUndefined();
  });

  it('creates a missing face with the first texture key', () => {
    const doc = docOf({
      textureWidth: 16,
      textureHeight: 16,
      textures: { skin: 's' },
      elements: [el('A', { north: { texture: '#skin', uv: [0, 0, 4, 4] } })],
    });
    const f = setFaceUv(doc, 'A', 'up', [0, 8, 4, 12]);
    expect(f.texture).toBe('#skin');
    expect(doc.getElement('A')!.faces!.up).toBe(f);
  });

  it('validates element, face name, rect and rotation', () => {
    const doc = docOf({
      textures: { skin: 's' },
      elements: [el('A', { north: { texture: '#skin', uv: [0, 0, 4, 4] } })],
    });
    expect(() => setFaceUv(doc, 'B', 'north', [0, 0, 1, 1])).toThrow(/did you mean 'A'/);
    expect(() => setFaceUv(doc, 'A', 'nort' as 'north', [0, 0, 1, 1])).toThrow(
      /did you mean 'north'/,
    );
    expect(() => setFaceUv(doc, 'A', 'north', [0, 0, 1] as never)).toThrow(/u1, v1, u2, v2/);
    expect(() => setFaceUv(doc, 'A', 'north', [0, 0, 1, 1], -90)).toThrow(/0, 90, 180 or 270/);
  });
});

describe('autoUv', () => {
  const allFaces = (): Record<string, unknown> =>
    Object.fromEntries(
      ['north', 'east', 'south', 'west', 'up', 'down'].map((f) => [
        f,
        { texture: '#skin', uv: [0, 0, 1, 1], rotation: 90 }, // deliberately overlapping junk
      ]),
    );

  it('packs every face without overlap or out-of-bounds — clean uvReport round-trip', () => {
    const doc = docOf({
      textureWidth: 16,
      textureHeight: 16,
      textures: { skin: 's' },
      elements: [el('cube', allFaces(), [4, 4, 4]), el('slab', allFaces(), [2, 3, 5])],
    });
    // Before: heavy overlap between the two elements.
    expect(uvReport(doc)[0]!.overlaps.length).toBeGreaterThan(0);

    const result = autoUv(doc);
    expect(result.faces).toHaveLength(12);

    const r = uvReport(doc)[0]!;
    expect(r.overlaps).toEqual([]);
    expect(r.outOfBounds).toEqual([]);
    // Rects carry the exact face dims: cube faces 4×4; slab north 2×3, east 5×3, up 2×5.
    const rect = (element: string, face: string): number[] =>
      r.faces.find((f) => f.element === element && f.face === face)!.rect;
    const dims = (rc: number[]): number[] => [rc[2]! - rc[0]!, rc[3]! - rc[1]!];
    expect(dims(rect('cube', 'north'))).toEqual([4, 4]);
    expect(dims(rect('slab', 'north'))).toEqual([2, 3]);
    expect(dims(rect('slab', 'east'))).toEqual([5, 3]);
    expect(dims(rect('slab', 'up'))).toEqual([2, 5]);
    // Rotations were cleared (the packed rect assumes the unrotated corner mapping).
    expect(r.faces.every((f) => f.rotation === 0)).toBe(true);
  });

  it('is deterministic and only touches the listed elements when a list is given', () => {
    const make = (): ShapeDocument =>
      docOf({
        textureWidth: 32,
        textureHeight: 32,
        textures: { skin: 's' },
        elements: [el('a', allFaces(), [4, 4, 4]), el('b', allFaces(), [2, 2, 2])],
      });
    const d1 = make();
    const d2 = make();
    expect(autoUv(d1)).toEqual(autoUv(d2));

    const d3 = make();
    autoUv(d3, ['b']);
    // 'a' untouched: still the junk rect.
    expect(d3.getElement('a')!.faces!.north!.uv.map((v) => v.value)).toEqual([0, 0, 1, 1]);
    expect(d3.getElement('b')!.faces!.north!.uv.map((v) => v.value)).not.toEqual([0, 0, 1, 1]);
    expect(() => autoUv(d3, ['c'])).toThrow(/did you mean/);
  });

  it('packs each texture key onto its own sheet (they may share UV space)', () => {
    const doc = docOf({
      textureWidth: 8,
      textureHeight: 8,
      textures: { skin: 's', fur: 'f' },
      elements: [
        el('a', { north: { texture: '#skin', uv: [0, 0, 1, 1] } }, [8, 8, 1]),
        el('b', { north: { texture: '#fur', uv: [0, 0, 1, 1] } }, [8, 8, 1]),
      ],
    });
    // Each face is 8×8 = a full sheet; both fit only because the textures are independent.
    autoUv(doc);
    expect(doc.getElement('a')!.faces!.north!.uv.map((v) => v.value)).toEqual([0, 0, 8, 8]);
    expect(doc.getElement('b')!.faces!.north!.uv.map((v) => v.value)).toEqual([0, 0, 8, 8]);
    expect(uvReport(doc).every((r) => r.overlaps.length === 0)).toBe(true);
  });

  it('throws naming the minimal sheet size when the faces do not fit', () => {
    const doc = docOf({
      textureWidth: 16,
      textureHeight: 16,
      textures: { skin: 's' },
      elements: [el('beam', allFaces(), [20, 4, 4])], // n/s/u/d faces are 20 wide
    });
    expect(() => autoUv(doc)).toThrow(/do not fit on the 16x16 sheet/);
    expect(() => autoUv(doc)).toThrow(/32x16/); // the minimal doubling that fits
    // Nothing was written by the failed pack.
    expect(doc.getElement('beam')!.faces!.north!.uv.map((v) => v.value)).toEqual([0, 0, 1, 1]);
  });

  it('half-unit face dims pack cleanly and survive the 0.5-granularity occupancy raster', () => {
    const doc = docOf({
      textureWidth: 16,
      textureHeight: 16,
      textures: { skin: 's' },
      elements: [
        el('a', { north: { texture: '#skin', uv: [0, 0, 1, 1] } }, [2.5, 3.5, 1]),
        el('b', { north: { texture: '#skin', uv: [0, 0, 1, 1] } }, [2.5, 3.5, 1]),
      ],
    });
    autoUv(doc);
    const r = uvReport(doc)[0]!;
    expect(r.overlaps).toEqual([]);
    expect(r.outOfBounds).toEqual([]);
    // Two 2.5×3.5 rects = 17.5 units² of 256 — exactly representable on the 0.5 grid.
    expect(r.occupancyPercent).toBeCloseTo((17.5 / 256) * 100, 6);
  });
});

describe('uvReport bounds and filters', () => {
  it(`caps the overlap list at UV_REPORT_MAX_OVERLAPS and counts the rest (windmill/thunderlord pattern)`, () => {
    // 22 elements sharing one identical rect → C(22,2) = 231 'shared' pairs; unbounded,
    // vanilla shapes of this style produced hundreds of MB of JSON.
    const doc = docOf({
      textureWidth: 16,
      textureHeight: 16,
      textures: { skin: 'x' },
      elements: Array.from({ length: 22 }, (_, i) =>
        el(`blade${i}`, { north: { texture: '#skin', uv: [0, 0, 4, 4] } }),
      ),
    });
    const r = uvReport(doc)[0]!;
    expect(r.overlaps.length).toBe(UV_REPORT_MAX_OVERLAPS);
    expect(r.overlapsTruncated).toBe(231 - UV_REPORT_MAX_OVERLAPS);
  });

  it('filters to the requested elements and validates their names', () => {
    const doc = docOf({
      textureWidth: 16,
      textureHeight: 16,
      textures: { skin: 'x' },
      elements: [
        el('a', { north: { texture: '#skin', uv: [0, 0, 4, 4] } }),
        el('b', { north: { texture: '#skin', uv: [0, 0, 4, 4] } }),
      ],
    });
    const r = uvReport(doc, { elements: ['a'] })[0]!;
    expect(r.faces).toHaveLength(1);
    expect(r.overlaps).toHaveLength(0);
    expect(() => uvReport(doc, { elements: ['nope'] })).toThrowError(/'nope'/);
  });

  it('honors per-key textureSizes for bounds and reported sheet size (engine per-key UV space)', () => {
    const doc = docOf({
      textureWidth: 16,
      textureHeight: 8,
      textureSizes: { charred: [16, 16] },
      textures: { charred: 'x' },
      elements: [el('tool', { north: { texture: '#charred', uv: [0, 10.5, 6, 12] } })],
    });
    const r = uvReport(doc)[0]!;
    expect(r.textureHeight).toBe(16);
    expect(r.outOfBounds).toHaveLength(0); // valid in the overridden 16×16 space
  });
});
