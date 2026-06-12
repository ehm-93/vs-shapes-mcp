/**
 * UV inspection and editing: per-texture UV report (bounds, overlaps, fractional coords,
 * occupancy), single-face UV assignment, and a simple per-face shelf-packing auto-UV.
 *
 * Transactions: ops here do NOT call doc.transact — the MCP server wraps each tool call
 * in exactly one transaction. uvReport is read-only.
 *
 * All rects are [u1, v1, u2, v2] in shape UV units, bounded per face texture key by the
 * textureSizes[key] override else textureWidth/Height (tesselator.md §5; both default to
 * 16 when absent).
 */

import type { ShapeDocument } from './document.js';
import { vsnum } from './json.js';
import {
  FACE_NAMES,
  type ElementJson,
  type FaceJson,
  type FaceName,
} from './types.js';
import { defaultTextureRef, describeUnknown, docLabel, requireElement, listElementNames } from './elements.js';

export type UvRect = [number, number, number, number];

// ---------------------------------------------------------------------------
// Shared face math
// ---------------------------------------------------------------------------

/** Face width/height in shape UV units per facing (engine auto-UV dims). */
function faceDims(el: ElementJson, facing: FaceName): [number, number] {
  const sx = Math.abs(el.to[0]!.value - el.from[0]!.value);
  const sy = Math.abs(el.to[1]!.value - el.from[1]!.value);
  const sz = Math.abs(el.to[2]!.value - el.from[2]!.value);
  switch (facing) {
    case 'up':
    case 'down':
      return [sx, sz];
    case 'east':
    case 'west':
      return [sz, sy];
    default:
      return [sx, sy];
  }
}

const stripHash = (texture: string): string =>
  texture.startsWith('#') ? texture.slice(1) : texture;

interface CollectedFace {
  element: string;
  facing: FaceName;
  face: FaceJson;
  el: ElementJson;
  textureKey: string;
  /** Raw rect; [0, 0, w, h] (engine behavior) when uv is absent. */
  rect: UvRect;
  autoUv: boolean;
}

/** Every enabled face in document order (disabled faces are dropped by the engine at load). */
function collectFaces(doc: ShapeDocument): CollectedFace[] {
  const out: CollectedFace[] = [];
  doc.walk((el) => {
    for (const facing of FACE_NAMES) {
      const face = el.faces?.[facing];
      if (face === undefined || face.enabled === false) continue;
      const uv = face.uv;
      let rect: UvRect;
      let autoUv = false;
      if (uv === undefined || uv.length !== 4) {
        const [w, h] = faceDims(el, facing);
        rect = [0, 0, w, h];
        autoUv = true;
      } else {
        rect = [uv[0]!.value, uv[1]!.value, uv[2]!.value, uv[3]!.value];
      }
      out.push({ element: el.name, facing, face, el, textureKey: stripHash(face.texture), rect, autoUv });
    }
  });
  return out;
}

const texDims = (doc: ShapeDocument): [number, number] => [
  doc.root.textureWidth?.value ?? 16,
  doc.root.textureHeight?.value ?? 16,
];

// ---------------------------------------------------------------------------
// uvReport
// ---------------------------------------------------------------------------

export interface UvFaceInfo {
  element: string;
  face: FaceName;
  rect: UvRect;
  rotation: number;
  /** True when the face has no uv array and the engine auto-UVs it to [0, 0, w, h]. */
  autoUv: boolean;
}

export interface UvOverlap {
  /** 'shared' = identical rects (often intentional, e.g. mirrored limbs); 'overlap' = partial. */
  kind: 'shared' | 'overlap';
  a: { element: string; face: FaceName };
  b: { element: string; face: FaceName };
  /** The shared rect, or the intersection for partial overlaps. */
  rect: UvRect;
}

export interface UvTextureReport {
  textureKey: string;
  /** Effective UV-space width for this key: textureSizes override else the shape default. */
  textureWidth: number;
  textureHeight: number;
  faces: UvFaceInfo[];
  /** Faces whose rect leaves [0, width] × [0, height]. */
  outOfBounds: UvFaceInfo[];
  /** Faces with non-integer coordinates (legal, but easy to misalign on the pixel grid). */
  fractional: UvFaceInfo[];
  /**
   * Overlaps between faces of DIFFERENT elements (same-element faces overlap by design),
   * capped at {@link UV_REPORT_MAX_OVERLAPS} entries.
   */
  overlaps: UvOverlap[];
  /** How many further overlaps exist beyond the reported cap (0 = the list is complete). */
  overlapsTruncated: number;
  /** % of the sheet covered by at least one rect, rasterized at 0.5-unit granularity. */
  occupancyPercent: number;
}

/**
 * Cap on reported overlap pairs per texture. The pairwise scan is quadratic in faces:
 * vanilla shapes that tile one rect across hundreds of faces (windmill blades,
 * thunderlord) produce hundreds of thousands of 'shared' pairs — hundreds of MB of JSON —
 * with no information beyond the first few.
 */
export const UV_REPORT_MAX_OVERLAPS = 200;

export interface UvReportOpts {
  /** Exact element names to report on (no subtree recursion). Omit for every element. */
  elements?: string[];
}

const normRect = (r: UvRect): UvRect => [
  Math.min(r[0], r[2]),
  Math.min(r[1], r[3]),
  Math.max(r[0], r[2]),
  Math.max(r[1], r[3]),
];

const rectArea = (r: UvRect): number => {
  const n = normRect(r);
  return (n[2] - n[0]) * (n[3] - n[1]);
};

/** Strictly-positive-area intersection of two (normalized) rects, or null. */
function intersect(a: UvRect, b: UvRect): UvRect | null {
  const u1 = Math.max(a[0], b[0]);
  const v1 = Math.max(a[1], b[1]);
  const u2 = Math.min(a[2], b[2]);
  const v2 = Math.min(a[3], b[3]);
  if (u2 - u1 <= 0 || v2 - v1 <= 0) return null;
  return [u1, v1, u2, v2];
}

export function uvReport(doc: ShapeDocument, opts: UvReportOpts = {}): UvTextureReport[] {
  const [defWidth, defHeight] = texDims(doc);
  let only: Set<string> | undefined;
  if (opts.elements !== undefined) {
    const known = listElementNames(doc);
    for (const name of opts.elements) {
      if (!known.includes(name)) {
        throw new Error(`uvReport: ${describeUnknown('element', name, known, docLabel(doc))}`);
      }
    }
    only = new Set(opts.elements);
  }
  // The engine picks the UV-space size per face texture key: textureSizes[key] else the
  // shape default (Lib:155033-155036, tesselator.md §5).
  const sizeFor = (key: string): [number, number] => {
    const o = doc.root.textureSizes?.[key];
    const w = o?.[0]?.value ?? 0;
    const h = o?.[1]?.value ?? 0;
    return [w > 0 ? w : defWidth, h > 0 ? h : defHeight];
  };
  const byTexture = new Map<string, CollectedFace[]>();
  for (const cf of collectFaces(doc)) {
    if (only !== undefined && !only.has(cf.element)) continue;
    const list = byTexture.get(cf.textureKey) ?? [];
    list.push(cf);
    byTexture.set(cf.textureKey, list);
  }

  const reports: UvTextureReport[] = [];
  for (const [textureKey, faces] of byTexture) {
    const [width, height] = sizeFor(textureKey);
    const infos: UvFaceInfo[] = faces.map((cf) => ({
      element: cf.element,
      face: cf.facing,
      rect: cf.rect,
      rotation: cf.face.rotation?.value ?? 0,
      autoUv: cf.autoUv,
    }));

    const outOfBounds: UvFaceInfo[] = [];
    const fractional: UvFaceInfo[] = [];
    for (const info of infos) {
      const n = normRect(info.rect);
      if (n[0] < 0 || n[1] < 0 || n[2] > width || n[3] > height) outOfBounds.push(info);
      if (info.rect.some((c) => !Number.isInteger(c))) fractional.push(info);
    }

    const overlaps: UvOverlap[] = [];
    let overlapsTruncated = 0;
    const record = (o: UvOverlap): void => {
      if (overlaps.length < UV_REPORT_MAX_OVERLAPS) overlaps.push(o);
      else overlapsTruncated++;
    };
    for (let i = 0; i < infos.length; i++) {
      for (let k = i + 1; k < infos.length; k++) {
        const a = infos[i]!;
        const b = infos[k]!;
        if (a.element === b.element) continue;
        const identical = a.rect.every((c, idx) => c === b.rect[idx]);
        if (identical) {
          if (rectArea(a.rect) > 0) {
            record({ kind: 'shared', a: { element: a.element, face: a.face }, b: { element: b.element, face: b.face }, rect: a.rect });
          }
          continue;
        }
        const inter = intersect(normRect(a.rect), normRect(b.rect));
        if (inter !== null) {
          record({ kind: 'overlap', a: { element: a.element, face: a.face }, b: { element: b.element, face: b.face }, rect: inter });
        }
      }
    }

    // Occupancy: 0.5-unit grid (catches half-unit coords); a cell counts as covered when
    // a rect overlaps any part of it, so fractional rects round outward slightly.
    const gw = Math.max(1, Math.round(width * 2));
    const gh = Math.max(1, Math.round(height * 2));
    const grid = new Uint8Array(gw * gh);
    for (const info of infos) {
      const n = normRect(info.rect);
      const x0 = Math.max(0, Math.floor(n[0] * 2));
      const y0 = Math.max(0, Math.floor(n[1] * 2));
      const x1 = Math.min(gw, Math.ceil(n[2] * 2));
      const y1 = Math.min(gh, Math.ceil(n[3] * 2));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) grid[y * gw + x] = 1;
      }
    }
    let covered = 0;
    for (let i = 0; i < grid.length; i++) covered += grid[i]!;
    const occupancyPercent = (covered / (gw * gh)) * 100;

    reports.push({
      textureKey,
      textureWidth: width,
      textureHeight: height,
      faces: infos,
      outOfBounds,
      fractional,
      overlaps,
      overlapsTruncated,
      occupancyPercent,
    });
  }
  return reports;
}

// ---------------------------------------------------------------------------
// setFaceUv
// ---------------------------------------------------------------------------

const VALID_UV_ROTATIONS = new Set([0, 90, 180, 270]);

/**
 * Sets one face's uv rect (and optional rotation). The face is created — textured with
 * the shape's first texture key — when the element does not have it yet. rotation 0
 * removes the rotation key (the vanilla convention is to omit it).
 */
export function setFaceUv(
  doc: ShapeDocument,
  element: string,
  face: FaceName,
  rect: UvRect,
  rotation?: number,
): FaceJson {
  const op = 'setFaceUv';
  const el = requireElement(doc, element, op);
  if (!FACE_NAMES.includes(face)) {
    throw new Error(
      `${op}: ${describeUnknown('face', String(face), [...FACE_NAMES], `element '${element}'`)}`,
    );
  }
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some((c) => typeof c !== 'number' || !Number.isFinite(c))) {
    throw new Error(`${op}: rect must be [u1, v1, u2, v2] finite numbers in shape UV units, got ${JSON.stringify(rect)}`);
  }
  if (rotation !== undefined && !VALID_UV_ROTATIONS.has(rotation)) {
    throw new Error(
      `${op}: rotation must be 0, 90, 180 or 270 (the engine indexes a 4-entry UV corner ` +
        `table with rotation/90 — negative values crash it), got ${rotation}`,
    );
  }
  el.faces ??= {};
  let f = el.faces[face];
  if (f === undefined) {
    f = { texture: defaultTextureRef(doc.root), uv: [vsnum(rect[0]), vsnum(rect[1]), vsnum(rect[2]), vsnum(rect[3])] };
    el.faces[face] = f;
  } else {
    f.uv = [vsnum(rect[0]), vsnum(rect[1]), vsnum(rect[2]), vsnum(rect[3])];
  }
  if (rotation !== undefined) {
    if (rotation === 0) delete f.rotation;
    else f.rotation = vsnum(rotation);
  }
  return f;
}

// ---------------------------------------------------------------------------
// setFaceProps
// ---------------------------------------------------------------------------

export interface FacePropsPatch {
  /**
   * Texture key ('skin' or '#skin'). The key is not required to exist in the textures
   * map (some shapes rely on entity-supplied keys, e.g. vanilla's '#null'); fast
   * validation flags dangling refs after the call.
   */
  texture?: string;
  /** Glow 0–255 (brightness floor); null or 0 removes the field. */
  glow?: number | null;
  /** false disables the face (the engine drops it at load); true or null restores the default. */
  enabled?: boolean | null;
}

export interface SetFacePropsResult {
  /** element name → faces updated, in document order. */
  updated: Record<string, FaceName[]>;
  facesUpdated: number;
}

/**
 * Edits properties of EXISTING faces (texture key, glow, enabled) across one or more
 * elements — optionally whole subtrees — without touching UV rects. Faces are never
 * created here (creating a face needs a uv rect: use setFaceUv or addElement).
 */
export function setFaceProps(
  doc: ShapeDocument,
  elements: string[],
  props: FacePropsPatch,
  opts: { faces?: FaceName[]; subtree?: boolean } = {},
): SetFacePropsResult {
  const op = 'setFaceProps';
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new Error(`${op}: pass at least one element name`);
  }
  if (props.texture === undefined && props.glow === undefined && props.enabled === undefined) {
    throw new Error(`${op}: nothing to change — pass texture, glow and/or enabled`);
  }
  if (typeof props.glow === 'number' && (!Number.isFinite(props.glow) || props.glow < 0 || props.glow > 255)) {
    throw new Error(`${op}: glow must be 0–255 (the engine packs it into a byte), got ${props.glow}`);
  }
  const which = opts.faces ?? [...FACE_NAMES];
  for (const f of which) {
    if (!FACE_NAMES.includes(f)) {
      throw new Error(`${op}: ${describeUnknown('face', String(f), [...FACE_NAMES], 'the faces filter')}`);
    }
  }

  const targets: ElementJson[] = [];
  const seen = new Set<ElementJson>();
  for (const name of elements) {
    const stack: ElementJson[] = [requireElement(doc, name, op)];
    while (stack.length > 0) {
      const el = stack.pop()!;
      if (seen.has(el)) continue;
      seen.add(el);
      targets.push(el);
      if (opts.subtree === true) for (const c of el.children ?? []) stack.push(c);
    }
  }

  const updated: Record<string, FaceName[]> = {};
  let facesUpdated = 0;
  for (const el of targets) {
    for (const facing of which) {
      const face = el.faces?.[facing];
      if (face === undefined) continue;
      if (props.texture !== undefined) {
        face.texture = props.texture.startsWith('#') ? props.texture : `#${props.texture}`;
      }
      if (props.glow !== undefined) {
        if (props.glow === null || props.glow === 0) delete face.glow;
        else face.glow = vsnum(props.glow);
      }
      if (props.enabled !== undefined) {
        if (props.enabled === false) face.enabled = false;
        else delete face.enabled;
      }
      (updated[el.name] ??= []).push(facing);
      facesUpdated++;
    }
  }
  if (facesUpdated === 0) {
    throw new Error(
      `${op}: no matching faces on ${elements.map((n) => `'${n}'`).join(', ')}` +
        `${opts.subtree === true ? ' (or descendants)' : ''} for [${which.join(', ')}] — faces are ` +
        `only edited here, not created (use setFaceUv or addElement to create them)`,
    );
  }
  return { updated, facesUpdated };
}

// ---------------------------------------------------------------------------
// autoUv
// ---------------------------------------------------------------------------

export interface PackedFace {
  element: string;
  face: FaceName;
  textureKey: string;
  rect: UvRect;
}

export interface AutoUvResult {
  faces: PackedFace[];
}

interface PackItem {
  cf: CollectedFace;
  w: number;
  h: number;
}

/**
 * Shelf packing: items sorted by height (then width) descending, placed left-to-right in
 * rows top-down; a new row starts when the current one is full. Returns positions or
 * null when the sheet is too small. Exact (fractional) face dims are used — no rounding.
 */
function shelfPack(items: PackItem[], width: number, height: number): Map<PackItem, [number, number]> | null {
  const placed = new Map<PackItem, [number, number]>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const item of items) {
    if (item.w > width) return null;
    if (x + item.w > width) {
      y += rowH;
      x = 0;
      rowH = 0;
    }
    if (y + item.h > height) return null;
    placed.set(item, [x, y]);
    x += item.w;
    rowH = Math.max(rowH, item.h);
  }
  return placed;
}

/**
 * First-fit placement into free sheet space at 0.5-unit granularity, avoiding the
 * `occupied` rects (the layout of faces that are NOT being repacked).
 */
function freeSpacePack(
  items: PackItem[],
  occupied: UvRect[],
  width: number,
  height: number,
): Map<PackItem, [number, number]> | null {
  const G = 2; // grid cells per shape unit
  const gw = Math.max(1, Math.ceil(width * G));
  const gh = Math.max(1, Math.ceil(height * G));
  const grid = new Uint8Array(gw * gh);
  const mark = (r: UvRect): void => {
    const x0 = Math.max(0, Math.floor(Math.min(r[0], r[2]) * G));
    const y0 = Math.max(0, Math.floor(Math.min(r[1], r[3]) * G));
    const x1 = Math.min(gw, Math.ceil(Math.max(r[0], r[2]) * G));
    const y1 = Math.min(gh, Math.ceil(Math.max(r[1], r[3]) * G));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) grid[y * gw + x] = 1;
  };
  for (const r of occupied) mark(r);
  const placed = new Map<PackItem, [number, number]>();
  for (const item of items) {
    const cw = Math.ceil(item.w * G);
    const ch = Math.ceil(item.h * G);
    let pos: [number, number] | null = null;
    outer: for (let y = 0; y + ch <= gh; y++) {
      for (let x = 0; x + cw <= gw; x++) {
        let free = true;
        scan: for (let yy = y; yy < y + ch; yy++) {
          for (let xx = x; xx < x + cw; xx++) {
            if (grid[yy * gw + xx] !== 0) {
              free = false;
              break scan;
            }
          }
        }
        if (free) {
          pos = [x / G, y / G];
          break outer;
        }
      }
    }
    if (pos === null) return null;
    placed.set(item, pos);
    mark([pos[0], pos[1], pos[0] + item.w, pos[1] + item.h]);
  }
  return placed;
}

function groupPackItems(faces: CollectedFace[]): Map<string, PackItem[]> {
  const groups = new Map<string, PackItem[]>();
  for (const cf of faces) {
    const [w, h] = faceDims(cf.el, cf.facing);
    const list = groups.get(cf.textureKey) ?? [];
    list.push({ cf, w, h });
    groups.set(cf.textureKey, list);
  }
  for (const items of groups.values()) {
    items.sort(
      (a, b) =>
        b.h - a.h ||
        b.w - a.w ||
        a.cf.element.localeCompare(b.cf.element) ||
        a.cf.facing.localeCompare(b.cf.facing),
    );
  }
  return groups;
}

export interface AutoUvFitPlan {
  fits: boolean;
  width: number;
  height: number;
  /** Smallest sheet (doubling from current) on which a FULL repack of every face fits. */
  neededWidth: number;
  neededHeight: number;
}

/**
 * Dry-run: would a full auto-UV repack of every enabled face fit the current sheet?
 * Used to warn right when geometry outgrows the sheet (e.g. after a whole-model scale)
 * instead of at the next autoUv call.
 */
export function planAutoUvFit(doc: ShapeDocument): AutoUvFitPlan {
  const groups = groupPackItems(collectFaces(doc));
  const [width, height] = texDims(doc);
  const fitsAll = (w: number, h: number): boolean =>
    [...groups.values()].every((items) => shelfPack(items, w, h) !== null);
  if (fitsAll(width, height)) {
    return { fits: true, width, height, neededWidth: width, neededHeight: height };
  }
  let w = width;
  let h = height;
  for (let i = 0; i < 24 && !fitsAll(w, h); i++) {
    if (w <= h) w *= 2;
    else h *= 2;
  }
  return { fits: false, width, height, neededWidth: w, neededHeight: h };
}

/**
 * Auto-UV packing, one independent sheet per texture key (faces of different textures may
 * legitimately share UV space). Face dims are the exact shape-unit face sizes; existing
 * uv rotations are cleared (the packed rect assumes the unrotated corner mapping).
 * Disabled faces are skipped.
 *
 * Without an element list: FULL repack of every face (shelf packing); throws — naming the
 * smallest doubled sheet that fits — when the sheet is too small.
 *
 * With an element list (exact names, no subtree recursion): INCREMENTAL — only the listed
 * elements' faces are re-laid, placed into space not occupied by any other face's rect,
 * so existing layouts (and hand-painted textures aligned to them) are preserved. Throws
 * when no free space remains.
 */
export function autoUv(doc: ShapeDocument, elements?: string[]): AutoUvResult {
  const op = 'autoUv';
  let filter: Set<string> | null = null;
  if (elements !== undefined) {
    if (elements.length === 0) {
      throw new Error(`${op}: the elements list is empty — omit it to pack every element`);
    }
    for (const n of elements) requireElement(doc, n, op);
    filter = new Set(elements);
  }

  const all = collectFaces(doc).filter((cf) => filter === null || filter.has(cf.element));
  if (all.length === 0) {
    throw new Error(
      `${op}: no enabled faces to pack in ${docLabel(doc)}` +
        (filter !== null
          ? ` — the selected elements (${[...filter].join(', ')}) have no enabled faces`
          : ` — add elements with faces first (known elements: ${listElementNames(doc).join(', ') || 'none'})`),
    );
  }

  // One packing problem per texture key.
  const groups = groupPackItems(all);
  const [width, height] = texDims(doc);

  if (filter !== null) {
    // Incremental: place the selected faces into space not occupied by anything else.
    const outside = collectFaces(doc).filter((cf) => !filter.has(cf.element));
    const occupiedByKey = new Map<string, UvRect[]>();
    for (const cf of outside) {
      const list = occupiedByKey.get(cf.textureKey) ?? [];
      list.push(cf.rect);
      occupiedByKey.set(cf.textureKey, list);
    }
    const result: AutoUvResult = { faces: [] };
    for (const [textureKey, items] of groups) {
      const placed = freeSpacePack(items, occupiedByKey.get(textureKey) ?? [], width, height);
      if (placed === null) {
        throw new Error(
          `${op}: no free space left on the ${width}x${height} sheet of '#${textureKey}' for the ` +
            `selected faces — run a full repack (omit the elements list) or enlarge ` +
            `textureWidth/textureHeight`,
        );
      }
      for (const item of items) {
        const [x, y] = placed.get(item)!;
        const rect: UvRect = [x, y, x + item.w, y + item.h];
        item.cf.face.uv = [vsnum(rect[0]), vsnum(rect[1]), vsnum(rect[2]), vsnum(rect[3])];
        delete item.cf.face.rotation;
        result.faces.push({ element: item.cf.element, face: item.cf.facing, textureKey, rect });
      }
    }
    return result;
  }
  const fitsAll = (w: number, h: number): boolean =>
    [...groups.values()].every((items) => shelfPack(items, w, h) !== null);

  if (!fitsAll(width, height)) {
    let w = width;
    let h = height;
    // Double the smaller dimension until everything fits (typical texture sizes are
    // powers of two); cap the search rather than looping forever on absurd geometry.
    for (let i = 0; i < 24 && !fitsAll(w, h); i++) {
      if (w <= h) w *= 2;
      else h *= 2;
    }
    const failing = [...groups.entries()]
      .filter(([, items]) => shelfPack(items, width, height) === null)
      .map(([key]) => `'#${key}'`);
    throw new Error(
      `${op}: the faces of texture${failing.length > 1 ? 's' : ''} ${failing.join(', ')} do not fit ` +
        `on the ${width}x${height} sheet of ${docLabel(doc)}; the smallest sheet (doubling from ` +
        `${width}x${height}) that fits every texture is ${fitsAll(w, h) ? `${w}x${h}` : `larger than ${w}x${h}`} — ` +
        `set textureWidth/textureHeight accordingly and re-run`,
    );
  }

  const result: AutoUvResult = { faces: [] };
  for (const [textureKey, items] of groups) {
    const placed = shelfPack(items, width, height)!;
    for (const item of items) {
      const [x, y] = placed.get(item)!;
      const rect: UvRect = [x, y, x + item.w, y + item.h];
      item.cf.face.uv = [vsnum(rect[0]), vsnum(rect[1]), vsnum(rect[2]), vsnum(rect[3])];
      delete item.cf.face.rotation;
      result.faces.push({ element: item.cf.element, face: item.cf.facing, textureKey, rect });
    }
  }
  return result;
}
