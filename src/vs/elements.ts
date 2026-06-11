/**
 * Geometry operations on a ShapeDocument: add / edit / rename / delete / duplicate /
 * mirror / scale / reparent / import. Every operation that other data depends on cascades
 * (rename → keyframe element maps, delete → keyframe stripping, whole-model scale →
 * keyframe offsets, import → texture map entries).
 *
 * Transactions: ops here do NOT call doc.transact — the MCP server wraps each tool call
 * in exactly one transaction, so a throwing op rolls the document back wholesale. Ops
 * still validate everything they can up-front and mutate last, so they are safe to call
 * outside a transaction too.
 *
 * Errors are the product: every throw names the entities involved, lists near-miss
 * candidates for unknown names, and states the feasible fix.
 */

import type { ShapeDocument } from './document.js';
import { cloneJsonValue, stripLayout, vsnum } from './json.js';
import { elementMatrices } from './fk.js';
import { mat4Create, mat4TransformVec3, type Mat4 } from './transform.js';
import {
  FACE_NAMES,
  type ElementJson,
  type FaceJson,
  type FaceName,
  type JsonValue,
  type ShapeJson,
  type Vec3,
  type Vec3Json,
  type VsNum,
} from './types.js';

// ---------------------------------------------------------------------------
// Shared helpers (also used by animation.ts and uv.ts)
// ---------------------------------------------------------------------------

/** Human label for a document in error messages. */
export const docLabel = (doc: ShapeDocument): string => doc.path ?? 'this shape';

/** Classic Levenshtein distance; inputs are short element/animation names. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** Near-miss candidates for an unknown name, best first (case-insensitive distance). */
export function suggestNames(input: string, candidates: Iterable<string>): string[] {
  const lower = input.toLowerCase();
  const scored: [string, number][] = [];
  for (const c of candidates) {
    scored.push([c, editDistance(lower, c.toLowerCase())]);
  }
  scored.sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0]));
  const limit = Math.max(2, Math.floor(input.length / 3));
  return scored
    .filter(([, d]) => d <= limit)
    .slice(0, 5)
    .map(([c]) => c);
}

/**
 * Builds the standard "unknown name" message: near-miss suggestions plus the (capped)
 * list of valid candidates. `kind` is e.g. "element" or "animation".
 */
export function describeUnknown(
  kind: string,
  name: string,
  candidates: string[],
  where: string,
): string {
  if (candidates.length === 0) {
    return `${kind} '${name}' does not exist in ${where} — ${where} has no ${kind}s yet`;
  }
  const near = suggestNames(name, candidates);
  const didYouMean =
    near.length > 0 ? ` — did you mean ${near.map((n) => `'${n}'`).join(', ')}?` : ' —';
  const capped = candidates.slice(0, 25).join(', ') + (candidates.length > 25 ? ', …' : '');
  return (
    `${kind} '${name}' does not exist in ${where}${didYouMean} ` +
    `known ${kind}s (${candidates.length}): ${capped}`
  );
}

/** All element names in document (pre-)order. */
export function listElementNames(doc: ShapeDocument): string[] {
  const names: string[] = [];
  doc.walk((el) => names.push(el.name));
  return names;
}

/** Looks up an element by name; throws with near-miss candidates when absent. */
export function requireElement(doc: ShapeDocument, name: string, op: string): ElementJson {
  const el = doc.getElement(name);
  if (el !== undefined) return el;
  throw new Error(`${op}: ${describeUnknown('element', name, listElementNames(doc), docLabel(doc))}`);
}

/** Validates a [x, y, z] tuple of finite numbers. */
export function assertVec3(v: unknown, what: string): asserts v is Vec3 {
  if (!Array.isArray(v) || v.length !== 3 || v.some((c) => typeof c !== 'number' || !Number.isFinite(c))) {
    throw new Error(`${what} must be a [x, y, z] array of three finite numbers, got ${JSON.stringify(v)}`);
  }
}

/** '#'-prefixed reference to the shape's first texture key, falling back to '#skin'. */
export function defaultTextureRef(root: ShapeJson): string {
  const keys = Object.keys(root.textures ?? {});
  return `#${keys[0] ?? 'skin'}`;
}

/** Unique-ify a name against `taken` with the '2', '3', … suffix convention; reserves it. */
function uniqueName(base: string, taken: Set<string>): string {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}${n}`;
  taken.add(candidate);
  return candidate;
}

const vec3ToJson = (v: Vec3): Vec3Json => [vsnum(v[0]), vsnum(v[1]), vsnum(v[2])];

interface ElementEntry {
  el: ElementJson;
  parent: ElementJson | null;
  /** Ancestor chain from root level down to (excluding) the element. */
  path: ElementJson[];
}

function findWithParent(doc: ShapeDocument, name: string): ElementEntry | undefined {
  let found: ElementEntry | undefined;
  doc.walk((el, path) => {
    if (found === undefined && el.name === name) {
      found = { el, parent: path.length > 0 ? path[path.length - 1]! : null, path };
    }
  });
  return found;
}

function requireElementEntry(doc: ShapeDocument, name: string, op: string): ElementEntry {
  const entry = findWithParent(doc, name);
  if (entry !== undefined) return entry;
  throw new Error(`${op}: ${describeUnknown('element', name, listElementNames(doc), docLabel(doc))}`);
}

/** The mutable array that holds `parent`'s children (root list when parent is null). */
function childListOf(doc: ShapeDocument, parent: ElementJson | null): ElementJson[] {
  if (parent === null) {
    doc.root.elements ??= [];
    return doc.root.elements;
  }
  parent.children ??= [];
  return parent.children;
}

const holderLabel = (parent: ElementJson | null): string =>
  parent === null ? 'at root level' : `child of '${parent.name}'`;

/** Pre-order list of an element and all its descendants. */
function subtree(el: ElementJson): ElementJson[] {
  const out: ElementJson[] = [];
  const go = (e: ElementJson): void => {
    out.push(e);
    for (const c of e.children ?? []) go(c);
  };
  go(el);
  return out;
}

/**
 * True when the element's local matrix is sensitive to rotationOrigin: any nonzero
 * rotation or non-unit scale (M = T(o)·R·S·T(from/16 − o) collapses to T(from/16)
 * only when R and S are identity).
 */
function originMatters(el: ElementJson): boolean {
  return (
    (el.rotationX?.value ?? 0) !== 0 ||
    (el.rotationY?.value ?? 0) !== 0 ||
    (el.rotationZ?.value ?? 0) !== 0 ||
    (el.scaleX?.value ?? 1) !== 1 ||
    (el.scaleY?.value ?? 1) !== 1 ||
    (el.scaleZ?.value ?? 1) !== 1
  );
}

// ---------------------------------------------------------------------------
// addElement / editElement
// ---------------------------------------------------------------------------

export interface Vec3Named {
  x: number;
  y: number;
  z: number;
}

export interface FaceSpecEntry {
  /** Texture ref; '#' is prepended when missing. Defaults to the shape's first texture key. */
  texture?: string;
  uv: [number, number, number, number];
  rotation?: number;
  glow?: number;
  enabled?: boolean;
}

export type FaceSpec = Partial<Record<FaceName, FaceSpecEntry>>;

export interface AddElementOpts {
  parent?: string;
  name: string;
  from: Vec3;
  to: Vec3;
  rotationOrigin?: Vec3;
  rotation?: Partial<Vec3Named>;
  /**
   * 'auto-uv' (default): six faces textured with the shape's first texture key (or
   * '#skin'), each with the engine-auto-UV-style rect [0, 0, faceWidth, faceHeight]
   * in shape units. 'none': no faces (the element still parents children). Or an
   * explicit per-face spec.
   */
  faces?: 'auto-uv' | 'none' | FaceSpec;
}

const VALID_UV_ROTATIONS = new Set([0, 90, 180, 270]);

function assertUvRotation(rotation: number, what: string): void {
  if (!VALID_UV_ROTATIONS.has(rotation)) {
    throw new Error(
      `${what}: face uv rotation must be 0, 90, 180 or 270 (the engine indexes a 4-entry ` +
        `corner table with rotation/90), got ${rotation}`,
    );
  }
}

/** Face width/height in shape UV units per facing (tesselator auto-UV dims). */
function faceDims(size: Vec3, facing: FaceName): [number, number] {
  const [sx, sy, sz] = size;
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

function buildFace(texture: string, uv: [number, number, number, number], rotation?: number): FaceJson {
  const face: FaceJson = {
    texture: texture.startsWith('#') ? texture : `#${texture}`,
    uv: [vsnum(uv[0]), vsnum(uv[1]), vsnum(uv[2]), vsnum(uv[3])],
  };
  if (rotation !== undefined && rotation !== 0) face.rotation = vsnum(rotation);
  return face;
}

export function addElement(doc: ShapeDocument, opts: AddElementOpts): ElementJson {
  const op = 'addElement';
  if (typeof opts.name !== 'string' || opts.name.length === 0) {
    throw new Error(`${op}: the new element needs a non-empty name (animations address elements by name)`);
  }
  const existing = findWithParent(doc, opts.name);
  if (existing !== undefined) {
    throw new Error(
      `${op}: an element named '${opts.name}' already exists (${holderLabel(existing.parent)}) in ` +
        `${docLabel(doc)} — element names must be unique because animations key on them; pick another name`,
    );
  }
  const parentEntry = opts.parent !== undefined ? requireElementEntry(doc, opts.parent, op) : null;
  assertVec3(opts.from, `${op}: 'from'`);
  assertVec3(opts.to, `${op}: 'to'`);
  if (opts.rotationOrigin !== undefined) assertVec3(opts.rotationOrigin, `${op}: 'rotationOrigin'`);

  // Canonical key order (GROUND-TRUTH §8): name, from, to, rotationOrigin?, rotationX/Y/Z?, faces.
  const el: ElementJson = {
    name: opts.name,
    from: vec3ToJson(opts.from),
    to: vec3ToJson(opts.to),
  };
  if (opts.rotationOrigin !== undefined) el.rotationOrigin = vec3ToJson(opts.rotationOrigin);
  for (const [key, axis] of [['rotationX', 'x'], ['rotationY', 'y'], ['rotationZ', 'z']] as const) {
    const v = opts.rotation?.[axis];
    if (v !== undefined) {
      if (!Number.isFinite(v)) throw new Error(`${op}: rotation.${axis} must be a finite number, got ${v}`);
      el[key] = vsnum(v);
    }
  }

  const facesOpt = opts.faces ?? 'auto-uv';
  if (facesOpt === 'auto-uv') {
    const size: Vec3 = [
      Math.abs(opts.to[0] - opts.from[0]),
      Math.abs(opts.to[1] - opts.from[1]),
      Math.abs(opts.to[2] - opts.from[2]),
    ];
    const tex = defaultTextureRef(doc.root);
    const faces: Partial<Record<FaceName, FaceJson>> = {};
    for (const facing of FACE_NAMES) {
      const [w, h] = faceDims(size, facing);
      faces[facing] = buildFace(tex, [0, 0, w, h]);
    }
    el.faces = faces;
  } else if (facesOpt !== 'none') {
    const faces: Partial<Record<FaceName, FaceJson>> = {};
    for (const facing of FACE_NAMES) {
      const spec = facesOpt[facing];
      if (spec === undefined) continue;
      const uv = spec.uv;
      if (!Array.isArray(uv) || uv.length !== 4 || uv.some((c) => typeof c !== 'number' || !Number.isFinite(c))) {
        throw new Error(
          `${op}: face '${facing}' of '${opts.name}' needs uv as [u1, v1, u2, v2] finite numbers, ` +
            `got ${JSON.stringify(uv)}`,
        );
      }
      if (spec.rotation !== undefined) assertUvRotation(spec.rotation, `${op}: face '${facing}' of '${opts.name}'`);
      const face = buildFace(spec.texture ?? defaultTextureRef(doc.root), uv, spec.rotation);
      if (spec.glow !== undefined) face.glow = vsnum(spec.glow);
      if (spec.enabled !== undefined) face.enabled = spec.enabled;
      faces[facing] = face;
    }
    el.faces = faces;
  }

  childListOf(doc, parentEntry?.el ?? null).push(el);
  return el;
}

export interface ElementPatch {
  from?: Vec3;
  to?: Vec3;
  /** null removes rotationOrigin. */
  rotationOrigin?: Vec3 | null;
  /** null removes the rotation field (engine default 0). */
  rotationX?: number | null;
  rotationY?: number | null;
  rotationZ?: number | null;
}

export function editElement(doc: ShapeDocument, name: string, patch: ElementPatch): ElementJson {
  const op = 'editElement';
  const el = requireElement(doc, name, op);
  if (patch.from !== undefined) assertVec3(patch.from, `${op}('${name}'): 'from'`);
  if (patch.to !== undefined) assertVec3(patch.to, `${op}('${name}'): 'to'`);
  if (patch.rotationOrigin != null) assertVec3(patch.rotationOrigin, `${op}('${name}'): 'rotationOrigin'`);
  for (const key of ['rotationX', 'rotationY', 'rotationZ'] as const) {
    const v = patch[key];
    if (v !== undefined && v !== null && !Number.isFinite(v)) {
      throw new Error(`${op}('${name}'): ${key} must be a finite number (degrees) or null to clear, got ${v}`);
    }
  }
  if (patch.from !== undefined) el.from = vec3ToJson(patch.from);
  if (patch.to !== undefined) el.to = vec3ToJson(patch.to);
  if (patch.rotationOrigin !== undefined) {
    if (patch.rotationOrigin === null) delete el.rotationOrigin;
    else el.rotationOrigin = vec3ToJson(patch.rotationOrigin);
  }
  for (const key of ['rotationX', 'rotationY', 'rotationZ'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (v === null) delete el[key];
    else el[key] = vsnum(v);
  }
  return el;
}

// ---------------------------------------------------------------------------
// renameElement — cascades into every animation keyframe
// ---------------------------------------------------------------------------

export interface RenameResult {
  keyframesUpdated: number;
  animationsUpdated: string[];
}

export function renameElement(doc: ShapeDocument, oldName: string, newName: string): RenameResult {
  const op = 'renameElement';
  if (typeof newName !== 'string' || newName.length === 0) {
    throw new Error(`${op}: the new name must be a non-empty string`);
  }
  requireElementEntry(doc, oldName, op);
  if (oldName === newName) return { keyframesUpdated: 0, animationsUpdated: [] };

  const collision = findWithParent(doc, newName);
  if (collision !== undefined) {
    throw new Error(
      `${op}: cannot rename '${oldName}' to '${newName}' — an element named '${newName}' already ` +
        `exists (${holderLabel(collision.parent)}) in ${docLabel(doc)}; pick a unique name`,
    );
  }

  // Validation pass first (atomicity without relying on the server transaction):
  // refuse when any keyframe already carries an entry for newName (a stale reference —
  // renaming onto it would silently merge animation data).
  interface Hit {
    code: string;
    kfElements: Record<string, unknown>;
  }
  const hits: Hit[] = [];
  const animationsUpdated = new Set<string>();
  for (const anim of doc.listAnimations()) {
    const code = anim.code ?? anim.name;
    for (const kf of anim.keyframes ?? []) {
      const elements = kf.elements ?? {};
      if (Object.prototype.hasOwnProperty.call(elements, newName)) {
        throw new Error(
          `${op}: cannot rename '${oldName}' to '${newName}' — animation '${code}' keyframe at frame ` +
            `${kf.frame.value} already contains an entry named '${newName}' (a stale reference to a ` +
            `deleted/renamed element?); delete it first with deleteKeyframe or pick another name`,
        );
      }
      if (Object.prototype.hasOwnProperty.call(elements, oldName)) {
        hits.push({ code, kfElements: elements as Record<string, unknown> });
        animationsUpdated.add(code);
      }
    }
  }

  const el = doc.getElement(oldName)!;
  el.name = newName;
  for (const hit of hits) {
    // NB: re-keying moves the entry to the end of the serialized keyframe map (the
    // lossless layout is keyed by the old name); entry order is not semantic.
    const value = hit.kfElements[oldName];
    delete hit.kfElements[oldName];
    hit.kfElements[newName] = value;
  }
  return { keyframesUpdated: hits.length, animationsUpdated: [...animationsUpdated] };
}

// ---------------------------------------------------------------------------
// deleteElement — refuses (or force-strips) animation references to the subtree
// ---------------------------------------------------------------------------

export interface DeleteElementResult {
  strippedFrom: { animation: string; frames: number[] }[];
}

export function deleteElement(
  doc: ShapeDocument,
  name: string,
  opts?: { force?: boolean },
): DeleteElementResult {
  const op = 'deleteElement';
  const entry = requireElementEntry(doc, name, op);
  const subtreeNames = new Set(subtree(entry.el).map((e) => e.name));

  const refs: { animation: string; frames: number[] }[] = [];
  for (const anim of doc.listAnimations()) {
    const code = anim.code ?? anim.name;
    const frames: number[] = [];
    for (const kf of anim.keyframes ?? []) {
      if (Object.keys(kf.elements ?? {}).some((n) => subtreeNames.has(n))) {
        frames.push(kf.frame.value);
      }
    }
    if (frames.length > 0) refs.push({ animation: code, frames });
  }

  if (refs.length > 0 && opts?.force !== true) {
    const list = refs.map((r) => `'${r.animation}' (frame${r.frames.length > 1 ? 's' : ''} ${r.frames.join(', ')})`);
    const names = [...subtreeNames];
    throw new Error(
      `${op}: cannot delete '${name}' — its subtree (${names.join(', ')}) is referenced by ` +
        `animation${refs.length > 1 ? 's' : ''} ${list.join('; ')}. Re-run with force: true to delete ` +
        `the element and strip those keyframe entries, or remove the keyframes first.`,
    );
  }

  if (refs.length > 0) {
    for (const anim of doc.listAnimations()) {
      const keyframes = anim.keyframes ?? [];
      for (const kf of keyframes) {
        const elements = kf.elements ?? {};
        for (const n of Object.keys(elements)) {
          if (subtreeNames.has(n)) delete elements[n];
        }
      }
      // Keyframes emptied by the strip are pruned (an entry-less keyframe is dead weight).
      // In-place splice keeps the array's lossless layout metadata attached.
      for (let i = keyframes.length - 1; i >= 0; i--) {
        if (Object.keys(keyframes[i]!.elements ?? {}).length === 0) keyframes.splice(i, 1);
      }
    }
  }

  const list = childListOf(doc, entry.parent);
  const idx = list.indexOf(entry.el);
  // idx is guaranteed ≥ 0: entry came from walking this very tree.
  list.splice(idx, 1);
  return { strippedFrom: refs };
}

// ---------------------------------------------------------------------------
// mirrorElement — mirrored deep copy with exact world-geometry reflection
// ---------------------------------------------------------------------------

export interface MirrorElementOpts {
  /**
   * Mirror plane coordinate in 1/16-block units, in the coordinate space the target
   * element's from/to live in (model space for root-level elements, parent-local space
   * for children). Default 8 = the model center plane for root-level elements.
   */
  about?: number;
  /** Explicit name for the mirrored copy's root (throws on collision). */
  newName?: string;
}

/** L/R name-swap heuristics: 'L '/'R ' prefixes, '-l'/'-r' suffixes, Left/Right substrings. */
function swapLRName(name: string): string | null {
  if (name.startsWith('L ')) return `R ${name.slice(2)}`;
  if (name.startsWith('R ')) return `L ${name.slice(2)}`;
  if (name.endsWith('-l')) return `${name.slice(0, -2)}-r`;
  if (name.endsWith('-r')) return `${name.slice(0, -2)}-l`;
  for (const [from, to] of [
    ['Left', 'Right'],
    ['Right', 'Left'],
    ['left', 'right'],
    ['right', 'left'],
  ] as const) {
    const i = name.indexOf(from);
    if (i !== -1) return name.slice(0, i) + to + name.slice(i + from.length);
  }
  return null;
}

/**
 * Mirrors a deep copy of the subtree about the given plane and inserts it next to the
 * original. Returns the old → new name map for every element in the subtree.
 *
 * Geometry (exact, verified against fk world bounds):
 * - from/to on the mirrored axis are reflected AND swapped: from' = F − to, to' = F − from
 *   (F = 2·about for the subtree root). Box size is unchanged.
 * - rotationOrigin is reflected on the axis; an absent origin is materialized as the
 *   reflection of (0,0,0) when the element has rotation/scale (the origin stops being a
 *   no-op once reflected).
 * - Rotation signs: x-mirror negates rotationY and rotationZ (keeps rotationX); z-mirror
 *   negates rotationX and rotationY (keeps rotationZ). Because the engine composes
 *   R = Rx·Ry·Rz, this equals conjugating the rotation by the mirror plane.
 * - Children live in parent-from-corner-relative coordinates, so each child level
 *   reflects about its parent's local size: F_child = parent.to − parent.from on the axis.
 *
 * Face UVs are copied as-is: the texture appears visually mirrored on the copy. Re-mapping
 * UVs so the texture reads un-mirrored (a "UV broker") is out of scope for v1.
 */
export function mirrorElement(
  doc: ShapeDocument,
  name: string,
  axis: 'x' | 'z',
  opts?: MirrorElementOpts,
): Record<string, string> {
  const op = 'mirrorElement';
  if (axis !== 'x' && axis !== 'z') {
    throw new Error(
      `${op}: axis must be 'x' or 'z' (mirroring across the Y plane would flip the model ` +
        `upside down — not supported), got '${String(axis)}'`,
    );
  }
  const about = opts?.about ?? 8;
  if (typeof about !== 'number' || !Number.isFinite(about)) {
    throw new Error(`${op}: 'about' must be a finite plane coordinate in 1/16-block units, got ${about}`);
  }
  const entry = requireElementEntry(doc, name, op);
  const axisIdx = axis === 'x' ? 0 : 2;
  // x-mirror: negate rotY+rotZ; z-mirror: negate rotX+rotY (see jsdoc).
  const negate: Record<'rotationX' | 'rotationY' | 'rotationZ', boolean> = {
    rotationX: axis === 'z',
    rotationY: true,
    rotationZ: axis === 'x',
  };

  const copy = cloneJsonValue(entry.el as unknown as JsonValue) as unknown as ElementJson;

  const mirrorNode = (el: ElementJson, flip: number): void => {
    const f = el.from[axisIdx]!.value;
    const t = el.to[axisIdx]!.value;
    el.from[axisIdx] = vsnum(flip - t);
    el.to[axisIdx] = vsnum(flip - f);
    if (el.rotationOrigin !== undefined) {
      el.rotationOrigin[axisIdx] = vsnum(flip - el.rotationOrigin[axisIdx]!.value);
    } else if (originMatters(el) && flip !== 0) {
      // Absent origin = (0,0,0); its reflection is nonzero, so it must be written out.
      const origin: Vec3 = [0, 0, 0];
      origin[axisIdx] = flip;
      el.rotationOrigin = vec3ToJson(origin);
    }
    for (const key of ['rotationX', 'rotationY', 'rotationZ'] as const) {
      const v = el[key];
      if (v !== undefined && negate[key] && v.value !== 0) el[key] = vsnum(-v.value);
    }
    // Child coordinates are relative to this element's from corner; their mirror plane
    // is the element's own local size (t − f, identical before and after mirroring).
    for (const child of el.children ?? []) mirrorNode(child, t - f);
  };
  mirrorNode(copy, 2 * about);

  // Names: explicit newName for the root, L/R heuristics for everything, unique-ified.
  const taken = new Set(listElementNames(doc));
  const map: Record<string, string> = {};
  const originals = subtree(entry.el).map((e) => e.name);
  for (let i = 0; i < originals.length; i++) {
    const old = originals[i]!;
    if (i === 0 && opts?.newName !== undefined) {
      const holder = findWithParent(doc, opts.newName);
      if (holder !== undefined) {
        throw new Error(
          `${op}: newName '${opts.newName}' is already used by an element ` +
            `(${holderLabel(holder.parent)}) in ${docLabel(doc)} — pick a unique name`,
        );
      }
      taken.add(opts.newName);
      map[old] = opts.newName;
      continue;
    }
    map[old] = uniqueName(swapLRName(old) ?? old, taken);
  }
  for (const el of subtree(copy)) {
    const renamed = map[el.name];
    if (renamed !== undefined) el.name = renamed;
  }

  const list = childListOf(doc, entry.parent);
  list.splice(list.indexOf(entry.el) + 1, 0, copy);
  return map;
}

// ---------------------------------------------------------------------------
// scaleElement
// ---------------------------------------------------------------------------

/**
 * Scales a subtree (or the whole model when `name` is null) about `anchor` (1/16-block
 * units, in the target's own coordinate space). from/to/rotationOrigin scale per axis as
 * v' = anchor + (v − anchor)·factor for the target element; descendants scale about
 * (0,0,0) because child coordinates are relative to the parent's from corner, whose local
 * space scales linearly from its origin.
 *
 * Whole-model scale (name = null) additionally scales every keyframe offset triple by the
 * factor (offsets are translations in 1/16 units) — never rotations or stretch. Subtree
 * scale does NOT touch keyframes: the target's own offsets live in its (unscaled) parent
 * frame; offsets keyed on its descendants are left for the caller to adjustChannel if the
 * subtree carries scaled translation animation.
 */
export function scaleElement(
  doc: ShapeDocument,
  name: string | null,
  factor: number | Vec3,
  anchor: Vec3,
): void {
  const op = 'scaleElement';
  const f: Vec3 = typeof factor === 'number' ? [factor, factor, factor] : factor;
  assertVec3(f, `${op}: 'factor'`);
  assertVec3(anchor, `${op}: 'anchor'`);
  for (const c of f) {
    if (c <= 0) {
      throw new Error(
        `${op}: scale factors must be > 0, got ${JSON.stringify(f)} — ` +
          `use mirrorElement for reflections; a factor of 0 would collapse the geometry`,
      );
    }
  }

  const scaleVec = (v: Vec3Json, a: Vec3): void => {
    for (let i = 0; i < 3; i++) {
      const next = a[i]! + (v[i]!.value - a[i]!) * f[i]!;
      if (next !== v[i]!.value) v[i] = vsnum(next);
    }
  };

  const scaleNode = (el: ElementJson, a: Vec3): void => {
    scaleVec(el.from, a);
    scaleVec(el.to, a);
    if (el.rotationOrigin !== undefined) {
      scaleVec(el.rotationOrigin, a);
    } else if (originMatters(el)) {
      // Absent origin = (0,0,0) scales to anchor·(1−f); materialize it when nonzero.
      const origin: Vec3 = [a[0] * (1 - f[0]!), a[1] * (1 - f[1]!), a[2] * (1 - f[2]!)];
      if (origin.some((c) => c !== 0)) el.rotationOrigin = vec3ToJson(origin);
    }
    for (const child of el.children ?? []) scaleNode(child, [0, 0, 0]);
  };

  if (name === null) {
    for (const el of doc.root.elements ?? []) scaleNode(el, anchor);
    const fields = ['offsetX', 'offsetY', 'offsetZ'] as const;
    for (const anim of doc.listAnimations()) {
      for (const kf of anim.keyframes ?? []) {
        for (const kfe of Object.values(kf.elements ?? {})) {
          for (let i = 0; i < 3; i++) {
            const field = fields[i]!;
            const v = kfe[field];
            if (v != null && f[i] !== 1) kfe[field] = vsnum(v.value * f[i]!);
          }
        }
      }
    }
  } else {
    const entry = requireElementEntry(doc, name, op);
    scaleNode(entry.el, anchor);
  }
}

// ---------------------------------------------------------------------------
// reparentElement
// ---------------------------------------------------------------------------

/** Inverse of an affine matrix (last row 0,0,0,1). Throws on a singular linear part. */
function invertAffine(m: Mat4, what: string): Mat4 {
  const a00 = m[0]!, a10 = m[1]!, a20 = m[2]!;
  const a01 = m[4]!, a11 = m[5]!, a21 = m[6]!;
  const a02 = m[8]!, a12 = m[9]!, a22 = m[10]!;
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;
  const c00 = a11 * a22 - a12 * a21;
  const c10 = a12 * a20 - a10 * a22;
  const c20 = a10 * a21 - a11 * a20;
  const det = a00 * c00 + a01 * c10 + a02 * c20;
  if (Math.abs(det) < 1e-12) {
    throw new Error(`${what}: the ancestor chain matrix is singular (an ancestor has scale 0) — fix the scale first`);
  }
  const b00 = c00 / det, b01 = (a02 * a21 - a01 * a22) / det, b02 = (a01 * a12 - a02 * a11) / det;
  const b10 = c10 / det, b11 = (a00 * a22 - a02 * a20) / det, b12 = (a02 * a10 - a00 * a12) / det;
  const b20 = c20 / det, b21 = (a01 * a20 - a00 * a21) / det, b22 = (a00 * a11 - a01 * a10) / det;
  const out = mat4Create();
  out[0] = b00; out[1] = b10; out[2] = b20;
  out[4] = b01; out[5] = b11; out[6] = b21;
  out[8] = b02; out[9] = b12; out[10] = b22;
  out[12] = -(b00 * tx + b01 * ty + b02 * tz);
  out[13] = -(b10 * tx + b11 * ty + b12 * tz);
  out[14] = -(b20 * tx + b21 * ty + b22 * tz);
  return out;
}

export interface ReparentResult {
  warning?: string;
}

/**
 * Moves the subtree under a new parent (null = root level).
 *
 * preserveWorld (default true) translates from/to (and rotationOrigin) so the element's
 * rotationOrigin — or its from corner when it has no origin — keeps its exact world
 * position (static pose). When neither the old nor the new ancestor chain carries
 * rotation/scale, the matrices are pure translations and the whole box keeps its world
 * placement exactly. When an involved ancestor IS rotated/scaled, an axis-aligned box
 * cannot keep both position and orientation: the reference point is still preserved
 * exactly and a `warning` describes the residual orientation change.
 */
export function reparentElement(
  doc: ShapeDocument,
  name: string,
  newParent: string | null,
  opts?: { preserveWorld?: boolean },
): ReparentResult {
  const op = 'reparentElement';
  const entry = requireElementEntry(doc, name, op);
  if (newParent === name) {
    throw new Error(`${op}: '${name}' cannot become its own parent`);
  }
  let newParentEntry: ElementEntry | null = null;
  if (newParent !== null) {
    newParentEntry = requireElementEntry(doc, newParent, op);
    if (subtree(entry.el).includes(newParentEntry.el)) {
      throw new Error(
        `${op}: cannot reparent '${name}' under '${newParent}' — '${newParent}' is inside ` +
          `'${name}''s own subtree, which would detach the subtree into a cycle; ` +
          `pick a parent outside the subtree`,
      );
    }
  }

  const preserveWorld = opts?.preserveWorld ?? true;
  const result: ReparentResult = {};
  let delta: Vec3 = [0, 0, 0];

  if (preserveWorld) {
    const mats = elementMatrices(doc);
    const oldParentMat = entry.parent !== null ? mats.get(entry.parent.name)! : mat4Create();
    const newParentMat = newParentEntry !== null ? mats.get(newParentEntry.el.name)! : mat4Create();
    const el = entry.el;
    const hasOrigin = el.rotationOrigin !== undefined;
    const ref16: Vec3 = hasOrigin
      ? [el.rotationOrigin![0]!.value, el.rotationOrigin![1]!.value, el.rotationOrigin![2]!.value]
      : [el.from[0]!.value, el.from[1]!.value, el.from[2]!.value];
    const worldRef = mat4TransformVec3(oldParentMat, [ref16[0] / 16, ref16[1] / 16, ref16[2] / 16]);
    const newLocal = mat4TransformVec3(invertAffine(newParentMat, op), worldRef);
    delta = [
      newLocal[0] * 16 - ref16[0],
      newLocal[1] * 16 - ref16[1],
      newLocal[2] * 16 - ref16[2],
    ];

    const involved = [
      ...entry.path,
      ...(newParentEntry !== null ? [...newParentEntry.path, newParentEntry.el] : []),
    ];
    const distorted = [...new Set(involved.filter(originMatters).map((a) => a.name))];
    if (distorted.length > 0) {
      result.warning =
        `reparentElement('${name}'): ancestor${distorted.length > 1 ? 's' : ''} ` +
        `${distorted.map((n) => `'${n}'`).join(', ')} carry rotation/scale, so an axis-aligned box ` +
        `cannot keep both world position and orientation. The ` +
        `${hasOrigin ? 'rotationOrigin' : 'from-corner'} world position was preserved exactly; the ` +
        `box orientation now follows the new ancestor chain — re-pose with editElement rotations if needed.`;
    }
  }

  const oldList = childListOf(doc, entry.parent);
  oldList.splice(oldList.indexOf(entry.el), 1);
  childListOf(doc, newParentEntry?.el ?? null).push(entry.el);

  // Preserved layout embeds the source file's absolute indentation; at a different
  // nesting depth it would emit the subtree mis-indented. Same depth keeps its bytes.
  const oldDepth = entry.path.length;
  const newDepth = newParentEntry === null ? 0 : newParentEntry.path.length + 1;
  if (oldDepth !== newDepth) stripLayout(entry.el as unknown as JsonValue);

  if (preserveWorld && (delta[0] !== 0 || delta[1] !== 0 || delta[2] !== 0)) {
    const el = entry.el;
    const shift = (v: Vec3Json): void => {
      for (let i = 0; i < 3; i++) {
        if (delta[i] !== 0) v[i] = vsnum(v[i]!.value + delta[i]!);
      }
    };
    shift(el.from);
    shift(el.to);
    if (el.rotationOrigin !== undefined) {
      shift(el.rotationOrigin);
    } else if (originMatters(el)) {
      // The element rotates/scales about the (absent) origin (0,0,0); after translating
      // the box, the pivot must move with it or the element swings around the old pivot.
      el.rotationOrigin = vec3ToJson(delta);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// duplicateElement / importElement
// ---------------------------------------------------------------------------

/**
 * Deep-copies the subtree as a sibling of the original. The copy's root takes `newName`
 * (throws on collision) or the unique-ified original name; descendant names are
 * unique-ified with the '2', '3', … suffix. Returns the old → new name map.
 */
export function duplicateElement(
  doc: ShapeDocument,
  name: string,
  newName?: string,
): Record<string, string> {
  const op = 'duplicateElement';
  const entry = requireElementEntry(doc, name, op);
  const taken = new Set(listElementNames(doc));
  const map: Record<string, string> = {};
  const originals = subtree(entry.el).map((e) => e.name);
  for (let i = 0; i < originals.length; i++) {
    const old = originals[i]!;
    if (i === 0 && newName !== undefined) {
      const holder = findWithParent(doc, newName);
      if (holder !== undefined) {
        throw new Error(
          `${op}: newName '${newName}' is already used by an element (${holderLabel(holder.parent)}) ` +
            `in ${docLabel(doc)} — pick a unique name`,
        );
      }
      taken.add(newName);
      map[old] = newName;
      continue;
    }
    map[old] = uniqueName(old, taken);
  }

  const copy = cloneJsonValue(entry.el as unknown as JsonValue) as unknown as ElementJson;
  for (const el of subtree(copy)) {
    const renamed = map[el.name];
    if (renamed !== undefined) el.name = renamed;
  }
  const list = childListOf(doc, entry.parent);
  list.splice(list.indexOf(entry.el) + 1, 0, copy);
  return map;
}

export interface ImportElementResult {
  /** Old → new element names (all subtree names are unique-ified against the target). */
  names: Record<string, string>;
  /** Texture keys copied verbatim from the source document. */
  texturesCopied: string[];
  /**
   * Source key → fresh key, for keys that collided in the target — either a different
   * path, or the same path authored against a different UV space.
   */
  texturesRemapped: Record<string, string>;
  /**
   * textureSizes overrides written so the imported faces keep resolving in the UV space
   * they were authored against (the source's per-key size, else its textureWidth/Height).
   */
  textureSizesAdded: Record<string, [number, number]>;
  /**
   * Elements whose stepParentName was removed (new names). The field targets an element
   * of the shape an OVERLAY is attached to; once the subtree is a real child here it is
   * meaningless and, if this document were itself used as an overlay, harmful. Only
   * stripped when importing under a parent — root-level imports may be assembling an
   * overlay shape and keep it.
   */
  stepParentsStripped: string[];
}

/**
 * Kitbash: deep-copies a subtree from another document into this one (under `parent`, or
 * at root level). All names are unique-ified against the target. Texture map keys the
 * subtree references are copied when missing in the target; a key that exists in the
 * target with a different path — or the same path in a different UV space — is remapped
 * to a fresh key (face refs in the copy are rewritten) and reported. When the source UV
 * space (per-key textureSizes, else textureWidth/Height) differs from the target's
 * textureWidth/Height, a textureSizes override is written so the imported UVs stay valid.
 */
export function importElement(
  doc: ShapeDocument,
  fromDoc: ShapeDocument,
  name: string,
  opts?: { parent?: string },
): ImportElementResult {
  const op = 'importElement';
  const srcEntry = findWithParent(fromDoc, name);
  if (srcEntry === undefined) {
    throw new Error(
      `${op}: ${describeUnknown('element', name, listElementNames(fromDoc), `the source document (${docLabel(fromDoc)})`)}`,
    );
  }
  const parentEntry = opts?.parent !== undefined ? requireElementEntry(doc, opts.parent, op) : null;

  const copy = cloneJsonValue(srcEntry.el as unknown as JsonValue) as unknown as ElementJson;

  // Names.
  const taken = new Set(listElementNames(doc));
  const names: Record<string, string> = {};
  for (const old of subtree(srcEntry.el).map((e) => e.name)) {
    names[old] = uniqueName(old, taken);
  }
  for (const el of subtree(copy)) {
    const renamed = names[el.name];
    if (renamed !== undefined) el.name = renamed;
  }

  // Textures referenced by the copied faces.
  const refKeys = new Set<string>();
  for (const el of subtree(copy)) {
    for (const facing of FACE_NAMES) {
      const face = el.faces?.[facing];
      if (face === undefined) continue;
      refKeys.add(face.texture.startsWith('#') ? face.texture.slice(1) : face.texture);
    }
  }

  const texturesCopied: string[] = [];
  const texturesRemapped: Record<string, string> = {};
  const textureSizesAdded: Record<string, [number, number]> = {};
  const srcTextures = fromDoc.root.textures ?? {};

  /** The UV space a key's face UVs are authored against in `root`. */
  const spaceOf = (root: ShapeJson, key: string): [number, number] => {
    const o = root.textureSizes?.[key];
    if (o !== undefined) return [o[0].value, o[1].value];
    return [root.textureWidth?.value ?? 16, root.textureHeight?.value ?? 16];
  };
  const targetDefault: [number, number] = [
    doc.root.textureWidth?.value ?? 16,
    doc.root.textureHeight?.value ?? 16,
  ];
  // Write an override when the source UV space differs from the target's default — the
  // imported faces keep their source-space UVs and must keep resolving against it.
  const ensureSize = (fromKey: string, toKey: string): void => {
    const srcSpace = spaceOf(fromDoc.root, fromKey);
    if (srcSpace[0] === targetDefault[0] && srcSpace[1] === targetDefault[1]) return;
    doc.root.textureSizes ??= {};
    doc.root.textureSizes[toKey] = [vsnum(srcSpace[0]), vsnum(srcSpace[1])];
    textureSizesAdded[toKey] = srcSpace;
  };
  const remapRefs = (key: string, fresh: string): void => {
    for (const el of subtree(copy)) {
      for (const facing of FACE_NAMES) {
        const face = el.faces?.[facing];
        if (face === undefined) continue;
        const raw = face.texture;
        const k = raw.startsWith('#') ? raw.slice(1) : raw;
        if (k === key) face.texture = raw.startsWith('#') ? `#${fresh}` : fresh;
      }
    }
  };

  for (const key of refKeys) {
    const srcPath = srcTextures[key];
    if (srcPath === undefined) continue; // source doesn't define it either; the validator flags it
    const tgtPath = (doc.root.textures ?? {})[key];
    if (tgtPath === undefined) {
      doc.root.textures ??= {};
      doc.root.textures[key] = srcPath;
      texturesCopied.push(key);
      ensureSize(key, key);
    } else {
      const samePath = tgtPath === srcPath;
      const srcSpace = spaceOf(fromDoc.root, key);
      const tgtSpace = spaceOf(doc.root, key);
      const sameSpace = srcSpace[0] === tgtSpace[0] && srcSpace[1] === tgtSpace[1];
      if (samePath && sameSpace) continue; // identical texture in an identical UV space
      // Different path, or same path authored against a different UV space: one key
      // cannot serve both, so the imported faces move to a fresh key.
      const takenKeys = new Set(Object.keys(doc.root.textures ?? {}));
      const fresh = uniqueName(key, takenKeys);
      doc.root.textures ??= {};
      doc.root.textures[fresh] = srcPath;
      texturesRemapped[key] = fresh;
      ensureSize(key, fresh);
      remapRefs(key, fresh);
    }
  }

  // stepParentName targets an element of the shape an overlay is attached TO; as a real
  // child of `parent` it is stale donor data (see ImportElementResult.stepParentsStripped).
  const stepParentsStripped: string[] = [];
  if (parentEntry !== null) {
    for (const el of subtree(copy)) {
      if (el.stepParentName !== undefined) {
        delete el.stepParentName;
        stepParentsStripped.push(el.name);
      }
    }
  }

  // The copy carries the source FILE's layout (absolute indentation, newline style); at
  // its position in this document that would emit mis-indented. Canonical style instead.
  stripLayout(copy as unknown as JsonValue);

  childListOf(doc, parentEntry?.el ?? null).push(copy);
  return { names, texturesCopied, texturesRemapped, textureSizesAdded, stepParentsStripped };
}
