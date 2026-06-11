/**
 * Validation suite: every shape/animation invariant as an explicit check with a stable code.
 *
 * Stable finding codes (agents, tools and tests key on these — never rename):
 *
 * | code                     | severity  | level | meaning                                            |
 * |--------------------------|-----------|-------|----------------------------------------------------|
 * | shape/malformed-tree     | error     | fast  | elements/animations not arrays / entries not objects |
 * | shape/malformed-box      | error     | fast  | from/to is not a 3-number array                     |
 * | shape/inverted-box       | error     | fast  | from > to on some axis (box is inside-out)          |
 * | shape/zero-thickness     | note      | fast  | from == to on some axis (legal, vanilla uses it)    |
 * | shape/dup-name           | error     | fast  | duplicate element names (animations key on names)   |
 * | shape/key-casing         | error     | fast  | known key in non-canonical casing (tool misreads it)|
 * | shape/face-key           | error     | fast  | non-canonical face dict key (engine first-letter)   |
 * | shape/step-parent        | note      | fast  | root elements carry stepParentName (attach-time)    |
 * | uv/malformed             | warn      | fast  | uv is not a 4-number array (engine drops the face)  |
 * | uv/inverted              | note      | fast  | u1 > u2 or v1 > v2 — mirrored sampling (engine OK)  |
 * | uv/out-of-bounds         | error     | fast  | uv outside the face's effective texture size        |
 * | uv/bad-rotation          | error     | fast  | negative face rotation (underflows engine UV table) |
 * | tex/missing-hash         | error     | fast  | face texture without '#' (engine mangles the key)   |
 * | tex/dangling-key         | warn/note | fast  | face '#key' missing from the textures map           |
 * | anim/dup-code            | error     | fast  | duplicate animation codes                           |
 * | anim/no-keyframes        | error     | fast  | animation without keyframes (engine throws)         |
 * | anim/frame-overflow      | error     | fast  | quantityframes ≤ max keyframe frame (engine throws) |
 * | anim/dangling-ref        | error     | fast  | keyframe element name not in the tree               |
 * | anim/partial-channel     | error     | fast  | partial offset/rotation/stretch triple (engine NPE) |
 * | anim/unsorted-keyframes  | warn      | fast  | keyframes not sorted by frame (engine self-inconsistent) |
 * | anim/joint-cap           | warn      | fast  | joint count reaches the legacy 31 cap               |
 * | anim/hard-wrap           | warn      | full  | Repeat loop snaps at the cycle wrap                 |
 * | anim/foot-slide          | warn      | full  | foot skates during stance (needs opts.footElements) |
 * | anim/eval-failed         | error     | full  | defensive: fk evaluation threw unexpectedly         |
 *
 * Severities mirror engine behavior: 'error' = the engine throws at load, crashes when the
 * animation plays, or silently corrupts intent (the silent-rename failure); 'warn' = loads
 * but degrades on some clients or visibly misbehaves; 'note' = legal, listed for awareness.
 * tex/dangling-key is 'warn' when the shape's own textures map is non-empty (likely a typo
 * in a self-contained shape; the engine logs an error and renders the unknown-texture
 * placeholder when nothing supplies the key) and 'note' when the map is empty (the shape
 * clearly relies on textures supplied by the consuming block/item/entity type definition —
 * a standard vanilla pattern, 189 of 6,097 vanilla shapes).
 *
 * Normative sources: docs/GROUND-TRUTH.md §4–§6, docs/ground-truth/tesselator.md §1/§2/§4/§5,
 * decompiled Animation.GenerateAllFrames (VintagestoryAPI.decompiled.cs:143564–143589).
 */

import {
  FACE_NAMES,
  IDENTITY_POSE,
  VsNum,
  type AnimationJson,
  type ElementJson,
  type FaceJson,
  type Finding,
  type KeyFrameElementJson,
  type KeyFrameJson,
  type PoseTf,
  type ShapeJson,
} from './types.js';
import { angleDegDistance, footContacts, interpolatePose, rootOf, type ShapeDocLike } from './fk.js';

export interface ValidateOptions {
  /** 'fast' (default) = static checks only; 'full' adds the fk-based checks. */
  level?: 'fast' | 'full';
  /**
   * Foot element names for the foot-slide check (full level only). Every name must exist
   * in the tree — unknown names throw (an options mistake, not a document finding).
   */
  footElements?: string[];
}

// ---------------------------------------------------------------------------
// Tolerances (exported so tests and callers can reference the exact values)
// ---------------------------------------------------------------------------

/**
 * Warn when the effective joint count REACHES 31: the engine throws when
 * jointsById.Count >= GlobalConstants.MaxAnimatedElements (API:143582 — '>=', so a count
 * equal to the cap already fails; 230 in vanilla 1.22, but clients override it via
 * clientsettings.json "maxAnimatedElements", historically 31; the engine's own error
 * message advises raising it to 46, "this works for most GPUs"). The effective count is
 * one joint per distinct keyframed element that resolves in the tree, PLUS one for an
 * existing-but-unkeyed element named 'head': every entity animator load path passes
 * 'head' as requireJointsForElements (API:155457) and ResolveAndFindJoints allocates it a
 * joint (API:148122-148136).
 */
export const JOINT_WARN_CAP = 31;

/**
 * Hard-wrap pose tolerance: rotation deltas (compared modulo 360° — a k·360° wrap is the
 * same pose) within 10° count as "the same pose". The engine lerps the ≤ 1-frame wrap
 * exactly like any other keyframe interval (API:146144), so the wrap crosses the delta in
 * one 30 fps tick; calibrated against the vanilla corpus so ordinary cycle wraps
 * (chicken walk 5°, hawk fly-flap 3.6°, fish swim 3°) pass while genuine pops are flagged.
 */
export const HARD_WRAP_TOL_DEG = 10;
/** Hard-wrap pose tolerance for offsets, in blocks: 0.1 of a 1/16-block unit. */
export const HARD_WRAP_TOL_BLOCKS = 0.1 / 16;
/**
 * Hard-wrap pose tolerance for stretch: 1% scale. Chosen (the task spec only fixes the
 * rotation/offset tolerances): a 1% size pop at 30 fps is at the edge of perception, the
 * same ballpark as the 10° / 0.1-unit thresholds.
 */
export const HARD_WRAP_TOL_STRETCH = 0.01;

/**
 * Foot-slide tolerance, in blocks per frame of deviation from the stance-phase mean
 * horizontal velocity, measured over MID-stance segments only (the first and last segment
 * of each ground-contact run — lift-off and touch-down, where velocity legitimately
 * ramps — are excluded).
 *
 * Calibrated against the vanilla 1.22 corpus (354 locomotion animations across 111
 * creature shapes with foot-named elements): vanilla rigs are rotation-driven and roll
 * the foot through stance, so their bottom-center deviation spans 0.005–0.31 blocks/frame
 * CONTINUOUSLY (median 0.056; the maximum, 0.31, is the shiver/bear/deer run cycles) —
 * no smaller threshold separates shipped-quality cycles from defects. The tolerance
 * therefore sits just above the vanilla maximum: every vanilla locomotion cycle passes,
 * and the check flags only skating beyond anything the game ships.
 */
export const FOOT_SLIDE_TOL = 0.32;

/** Stance = frames where the foot's bottom sits in the lowest 20% of its vertical travel. */
export const STANCE_BAND_FRACTION = 0.2;

/** Locomotion-looking animation codes get the foot-slide check. */
const LOCOMOTION_RE = /walk|run|trot|sprint|move/i;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Reads a possibly-absent VsNum; JSON `null` counts as absent (engine: nullable double). */
const numOf = (v: VsNum | null | undefined, fallback = 0): number =>
  v == null ? fallback : v.value;

const animCodeOf = (anim: AnimationJson): string =>
  typeof anim.code === 'string' ? anim.code : anim.name;

const AXIS_NAMES = ['X', 'Y', 'Z'] as const;

/** Short number for messages: ≤ 4 decimals, no trailing zeros, no negative zero. */
const fmt = (n: number): string => {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

const plural = (n: number): string => (n === 1 ? '' : 's');

const isVec = (v: unknown, len: number): v is VsNum[] =>
  Array.isArray(v) && v.length === len && v.every((x) => x instanceof VsNum);

/**
 * Defensive runtime guard for values the types declare as objects but a corrupted tree may
 * not provide (typed via `unknown` so strict TS allows the null/shape checks).
 */
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof VsNum);

const elName = (el: ElementJson): string =>
  typeof el.name === 'string' ? el.name : '<unnamed>';

/** Levenshtein distance (two-row DP), for the dangling-ref nearest-name suggestion. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  let curr: number[] = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** Nearest existing name by case-insensitive edit distance; tree order breaks ties. */
function nearestName(target: string, names: Iterable<string>): string | undefined {
  const t = target.toLowerCase();
  let best: string | undefined;
  let bestDist = Infinity;
  for (const name of names) {
    const d = levenshtein(t, name.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Element collection
// ---------------------------------------------------------------------------

interface ElementEntry {
  el: ElementJson;
  /** Name of the parent element, or null at root level. */
  parentName: string | null;
}

/**
 * Pre-order element collection. Unlike ShapeDocument's traversal (which throws on cycles /
 * shared subtrees), the validator must terminate and report on whatever tree it is handed,
 * so non-object entries are skipped and already-seen nodes are not re-entered.
 */
function collectElements(root: ShapeJson): ElementEntry[] {
  const out: ElementEntry[] = [];
  const seen = new Set<ElementJson>();
  const visit = (els: unknown, parentName: string | null): void => {
    if (!Array.isArray(els)) return;
    for (const raw of els) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || raw instanceof VsNum) {
        continue;
      }
      const el = raw as ElementJson;
      if (seen.has(el)) continue;
      seen.add(el);
      out.push({ el, parentName });
      visit(el.children, typeof el.name === 'string' ? el.name : null);
    }
  };
  visit(root.elements, null);
  return out;
}

/**
 * Structural-tree errors: ShapeDocument.parse enforces that `elements`/`animations` are
 * arrays, but the escape hatch (doc_patch_json) and bare trees can violate that — and the
 * tolerant traversals here (collectElements skipping, listAnimations coercing) would
 * otherwise validate a load-fatal document as CLEAN. Every spot a traversal skips gets an
 * explicit error so the validator never silently passes a tree the engine cannot load.
 */
function checkTreeShape(root: ShapeJson, findings: Finding[]): void {
  const describe = (v: unknown): string => {
    if (v === null) return 'null';
    if (v instanceof VsNum) return `the number ${v.value}`;
    if (Array.isArray(v)) return 'an array';
    return `a ${typeof v}`;
  };
  const malformed = (what: string, v: unknown, expected: string): void => {
    findings.push({
      severity: 'error',
      code: 'shape/malformed-tree',
      message:
        `${what} is ${describe(v)} but must be ${expected}; the engine cannot load the ` +
        `document and most tools fail on it.`,
      fix: `Restore ${what} to ${expected} (doc_undo if a doc_patch_json caused this).`,
    });
  };

  const seen = new Set<object>();
  const visitElements = (els: unknown, owner: string): void => {
    if (els === undefined) return;
    if (!Array.isArray(els)) {
      malformed(owner, els, 'an array of element objects');
      return;
    }
    for (let i = 0; i < els.length; i++) {
      const raw: unknown = els[i];
      if (!isObj(raw)) {
        malformed(`${owner}[${i}]`, raw, 'an element object (with "name", "from", "to")');
        continue;
      }
      if (seen.has(raw)) continue;
      seen.add(raw);
      visitElements(
        (raw as { children?: unknown }).children,
        `"children" of element '${elName(raw as unknown as ElementJson)}'`,
      );
    }
  };
  visitElements((root as { elements?: unknown }).elements, '"elements"');

  const anims: unknown = (root as { animations?: unknown }).animations;
  if (anims !== undefined) {
    if (!Array.isArray(anims)) {
      malformed('"animations"', anims, 'an array of animation objects');
    } else {
      for (let i = 0; i < anims.length; i++) {
        const raw: unknown = anims[i];
        if (!isObj(raw)) {
          malformed(`"animations"[${i}]`, raw, 'an animation object (with "name", "keyframes")');
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// shape/* checks
// ---------------------------------------------------------------------------

function checkBoxes(entries: ElementEntry[], findings: Finding[]): void {
  for (const { el } of entries) {
    const name = elName(el);
    if (!isVec(el.from, 3) || !isVec(el.to, 3)) {
      findings.push({
        severity: 'error',
        code: 'shape/malformed-box',
        element: name,
        message:
          `Element '${name}' has a malformed 'from'/'to' (each must be a [x, y, z] number ` +
          `array in 1/16-block units); the engine cannot build its box.`,
        fix: `Set both 'from' and 'to' on '${name}' to 3-number arrays, e.g. [ 0.0, 0.0, 0.0 ].`,
      });
      continue;
    }
    const invertedAxes: string[] = [];
    const zeroAxes: string[] = [];
    const swaps: string[] = [];
    for (let i = 0; i < 3; i++) {
      const f = el.from[i]!.value;
      const t = el.to[i]!.value;
      if (f > t) {
        invertedAxes.push(AXIS_NAMES[i]!);
        swaps.push(`${AXIS_NAMES[i]} (${fmt(f)} ↔ ${fmt(t)})`);
      } else if (f === t) {
        zeroAxes.push(AXIS_NAMES[i]!);
      }
    }
    if (invertedAxes.length > 0) {
      findings.push({
        severity: 'error',
        code: 'shape/inverted-box',
        element: name,
        message:
          `Element '${name}' has from > to on the ${invertedAxes.join('/')} ax${
            invertedAxes.length === 1 ? 'is' : 'es'
          } (from [${el.from.map((v) => fmt(v.value)).join(', ')}] vs to [${el.to
            .map((v) => fmt(v.value))
            .join(', ')}]); the box is inside-out and its faces emit with negative size.`,
        fix: `Swap from/to on ax${invertedAxes.length === 1 ? 'is' : 'es'} ${swaps.join(', ')}.`,
      });
    }
    if (zeroAxes.length === 3) {
      findings.push({
        severity: 'note',
        code: 'shape/zero-thickness',
        element: name,
        message:
          `Element '${name}' is zero-size on all three axes (from == to); the engine emits no ` +
          `faces for it. Fine for pivot/marker elements, otherwise give it a size.`,
      });
    } else if (zeroAxes.length > 0) {
      findings.push({
        severity: 'note',
        code: 'shape/zero-thickness',
        element: name,
        message:
          `Element '${name}' is zero-thick on the ${zeroAxes.join('/')} ax${
            zeroAxes.length === 1 ? 'is' : 'es'
          }. Legal — vanilla uses zero-thick planes (ears, leaves) — listed for awareness; ` +
          `the two faces on that axis are coplanar and visible from both sides.`,
      });
    }
  }
}

function checkDuplicateNames(entries: ElementEntry[], findings: Finding[]): void {
  const byName = new Map<string, ElementEntry[]>();
  for (const entry of entries) {
    if (typeof entry.el.name !== 'string') continue; // unnamed elements cannot collide
    const list = byName.get(entry.el.name);
    if (list === undefined) byName.set(entry.el.name, [entry]);
    else list.push(entry);
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const where = list
      .map((e) => (e.parentName === null ? 'at root level' : `under '${e.parentName}'`))
      .join('; ');
    findings.push({
      severity: 'error',
      code: 'shape/dup-name',
      element: name,
      message:
        `${list.length} elements share the name '${name}' (${where}); names address elements, ` +
        `so only one is reachable — the engine animates only the LAST one in tree order ` +
        `(Shape.CollectElements overwrites by name, API:148028) while this tool's element ` +
        `edits reach the first.`,
      fix: `Rename ${list.length - 1} of them (e.g. '${name}-2'); element names must be unique.`,
    });
  }
}

/**
 * shape/step-parent (note): stepParentName is an attach-time overlay mechanism
 * (Shape.StepParentShape, API:147876) — the engine re-parents the element under the named
 * element of the PARENT shape when this shape is overlaid onto it, and ignores the field
 * entirely for standalone shapes (~20% of vanilla shapes carry it: antlers, cargo parts…).
 * fk/render intentionally ignore it too, so such part shapes pose/render "floating" at
 * their raw coordinates; one note per shape explains why.
 */
function checkStepParent(root: ShapeJson, findings: Finding[]): void {
  const els: unknown = root.elements;
  if (!Array.isArray(els)) return;
  const carriers = els
    .filter((el): el is ElementJson => isObj(el) && typeof el.stepParentName === 'string')
    .map((el) => `'${elName(el)}' → '${el.stepParentName}'`);
  if (carriers.length === 0) return;
  findings.push({
    severity: 'note',
    code: 'shape/step-parent',
    message:
      `Root element${plural(carriers.length)} ${carriers.slice(0, 6).join(', ')}` +
      `${carriers.length > 6 ? ` and ${carriers.length - 6} more` : ''} carr` +
      `${carriers.length === 1 ? 'ies' : 'y'} stepParentName: this shape is designed to be ` +
      `step-parented onto another shape at attach time (Shape.StepParentShape, API:147876). ` +
      `Standalone poses and renders place it at its raw coordinates — that is also what the ` +
      `engine does when the shape is loaded standalone.`,
  });
}

// ---------------------------------------------------------------------------
// shape/key-casing
// ---------------------------------------------------------------------------

/**
 * Known JSON keys per context, in the canonical casing 100% of the vanilla corpus writes.
 * The engine deserializes shape JSON with Newtonsoft, which binds properties
 * case-insensitively (GROUND-TRUTH §5) — a file written with 'quantityFrames' or 'OffsetX'
 * loads and animates fine IN-GAME — but this tool reads exact-case keys only, so an
 * off-case known key silently degrades the tool (quantityframes reads as 0 and triggers a
 * bogus frame-overflow error; off-case channel fields read as unset and poses fall back to
 * identity). The casing mismatch is therefore an error: it silently corrupts what every
 * other tool and finding reports.
 */
const CANONICAL_KEYS = {
  root: [
    'editor', 'textureWidth', 'textureHeight', 'textureSizes', 'textures', 'elements',
    'animations',
  ],
  element: [
    'name', 'from', 'to', 'rotationOrigin', 'rotationX', 'rotationY', 'rotationZ',
    'scaleX', 'scaleY', 'scaleZ', 'uv', 'unwrapMode', 'unwrapRotation', 'stepParentName',
    'shade', 'gradientShade', 'faces', 'children', 'attachmentpoints',
  ],
  face: ['texture', 'uv', 'rotation', 'glow', 'enabled', 'reflectiveMode', 'windMode', 'windData'],
  animation: [
    'name', 'code', 'version', 'quantityframes', 'onActivityStopped', 'onAnimationEnd',
    'easeAnimationSpeed', 'keyframes',
  ],
  keyframe: ['frame', 'elements'],
  keyframeElement: [
    'offsetX', 'offsetY', 'offsetZ', 'rotationX', 'rotationY', 'rotationZ',
    'stretchX', 'stretchY', 'stretchZ', 'originX', 'originY', 'originZ',
    'rotShortestDistanceX', 'rotShortestDistanceY', 'rotShortestDistanceZ',
  ],
} as const;

const CANONICAL_LOOKUP = new Map<keyof typeof CANONICAL_KEYS, Map<string, string>>(
  (Object.keys(CANONICAL_KEYS) as (keyof typeof CANONICAL_KEYS)[]).map((ctx) => [
    ctx,
    new Map(CANONICAL_KEYS[ctx].map((k) => [k.toLowerCase(), k])),
  ]),
);

function checkKeyCasing(root: ShapeJson, entries: ElementEntry[], findings: Finding[]): void {
  const report = (
    obj: Record<string, unknown>,
    ctx: keyof typeof CANONICAL_KEYS,
    where: string,
    extra: Partial<Finding>,
  ): void => {
    const lookup = CANONICAL_LOOKUP.get(ctx)!;
    for (const key of Object.keys(obj)) {
      const want = lookup.get(key.toLowerCase());
      if (want === undefined || want === key) continue;
      findings.push({
        severity: 'error',
        code: 'shape/key-casing',
        ...extra,
        message:
          `${where} has the key '${key}' where the canonical casing is '${want}'. The engine ` +
          `(Newtonsoft) matches JSON keys case-insensitively, so the file works in-game, but ` +
          `this tool reads exact casing: '${key}' is silently ignored here, and other ` +
          `findings/poses may be wrong because of it.`,
        fix: `Rename '${key}' to '${want}' (doc_patch_json: move from the off-case pointer to the canonical one).`,
      });
    }
  };

  report(root as unknown as Record<string, unknown>, 'root', 'The shape root', {});
  for (const { el } of entries) {
    const name = elName(el);
    report(el as unknown as Record<string, unknown>, 'element', `Element '${name}'`, { element: name });
    const faces: unknown = el.faces;
    if (isObj(faces)) {
      for (const [faceKey, face] of Object.entries(faces)) {
        if (!isObj(face)) continue;
        report(face, 'face', `Face '${faceKey}' of element '${name}'`, { element: name });
      }
    }
  }
  const anims: unknown = root.animations;
  if (!Array.isArray(anims)) return;
  for (const anim of anims as AnimationJson[]) {
    if (!isObj(anim)) continue;
    const code = animCodeOf(anim);
    const animWhere = typeof code === 'string' ? `Animation '${code}'` : 'An animation';
    const extra: Partial<Finding> = typeof code === 'string' ? { animation: code } : {};
    report(anim as unknown as Record<string, unknown>, 'animation', animWhere, extra);
    const keyframes: unknown = anim.keyframes;
    if (!Array.isArray(keyframes)) continue;
    for (const kf of keyframes as KeyFrameJson[]) {
      if (!isObj(kf)) continue;
      const frame = numOf(kf.frame);
      report(
        kf as unknown as Record<string, unknown>,
        'keyframe',
        `${animWhere} keyframe at frame ${fmt(frame)}`,
        { ...extra, frame },
      );
      const kfElements: unknown = kf.elements;
      if (!isObj(kfElements)) continue;
      for (const [elKey, kfe] of Object.entries(kfElements)) {
        if (!isObj(kfe)) continue;
        report(
          kfe,
          'keyframeElement',
          `${animWhere} keyframe at frame ${fmt(frame)}, element '${elKey}'`,
          { ...extra, frame, element: elKey },
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// uv/* and tex/* checks
// ---------------------------------------------------------------------------

function checkFaces(root: ShapeJson, entries: ElementEntry[], findings: Finding[]): void {
  const texW = numOf(root.textureWidth, 16); // engine defaults to 16 when absent
  const texH = numOf(root.textureHeight, 16);
  const textures: Record<string, unknown> = isObj(root.textures) ? root.textures : {};
  const textureKeys = Object.keys(textures);
  const textureSizes: Record<string, unknown> = isObj(root.textureSizes) ? root.textureSizes : {};
  /**
   * Effective UV-space size for a face: the engine picks it PER face texture key —
   * meta.TexturesSizes.TryGetValue(key) else the shape default (Lib:155033-155036,
   * tesselator.md §5) — matching render/textures.ts createTextureSet.
   */
  const effectiveSize = (key: string | undefined): [number, number] => {
    const override = key !== undefined ? textureSizes[key] : undefined;
    if (isVec(override, 2)) {
      const w = override[0]!.value;
      const h = override[1]!.value;
      return [w > 0 ? w : texW, h > 0 ? h : texH];
    }
    return [texW, texH];
  };

  for (const { el } of entries) {
    const name = elName(el);
    const faces: unknown = el.faces;
    if (!isObj(faces)) continue;

    // -- face dictionary keys -------------------------------------------------
    // The engine resolves face keys by their FIRST LETTER, case-insensitively
    // (BlockFacing.FromFirstLetter, API:9084-9100; TrimTextureNamesAndResolveFaces,
    // API:148707): 'n', 'North' and 'north' all resolve to NORTH in-game, while this tool
    // reads only the canonical full names and silently skips anything else.
    for (const faceKey of Object.keys(faces)) {
      if ((FACE_NAMES as readonly string[]).includes(faceKey)) continue;
      const byLetter = FACE_NAMES.find((f) => f[0] === faceKey[0]?.toLowerCase());
      findings.push({
        severity: 'error',
        code: 'shape/face-key',
        element: name,
        message:
          `Element '${name}' has a face key '${faceKey}', which is not one of the canonical ` +
          `names (north, east, south, west, up, down). The engine matches face keys by their ` +
          `first letter only${byLetter !== undefined ? ` — in-game this resolves to '${byLetter}'` : ' — in-game this face is dropped'} ` +
          `— while this tool ignores non-canonical keys, so the two disagree.`,
        fix:
          byLetter !== undefined
            ? `Rename the face key to '${byLetter}'.`
            : `Rename the face key to the intended canonical face name.`,
      });
    }

    for (const facing of FACE_NAMES) {
      const faceRaw: unknown = faces[facing];
      if (!isObj(faceRaw)) continue;
      const face = faceRaw as unknown as FaceJson;
      // enabled:false faces are dropped at load (tesselator.md §2) — their texture/uv are
      // dead data, never read by the engine (vanilla hawk.json keeps '#null' refs there).
      if (face.enabled === false) continue;

      // -- texture reference ------------------------------------------------
      let texKey: string | undefined;
      if (typeof face.texture !== 'string') {
        findings.push({
          severity: 'error',
          code: 'tex/dangling-key',
          element: name,
          message:
            `Face '${facing}' of element '${name}' has no 'texture' set; every enabled face ` +
            `must reference a textures-map key like '#skin'.`,
          fix:
            textureKeys.length > 0
              ? `Set "texture" to one of: ${textureKeys.map((k) => `'#${k}'`).join(', ')}.`
              : `Add an entry to the shape's textures map and reference it as '#<key>'.`,
        });
      } else if (!face.texture.startsWith('#')) {
        // The engine strips the FIRST character of face.texture unconditionally
        // (TrimTextureNamesAndResolveFaces, API:148715): a texture written without '#'
        // resolves to a mangled key in-game ('skin' → 'kin'), silently corrupting the
        // reference even though this tool would resolve it fine.
        texKey = face.texture;
        findings.push({
          severity: 'error',
          code: 'tex/missing-hash',
          element: name,
          message:
            `Face '${facing}' of element '${name}' has texture '${face.texture}' without the ` +
            `leading '#'. The engine strips the FIRST character of every face texture ` +
            `unconditionally (API:148715), so in-game this references the mangled key ` +
            `'${face.texture.slice(1)}', not '${face.texture}'.`,
          fix: `Change the face's texture to '#${face.texture}'.`,
        });
      } else {
        const key = face.texture.slice(1);
        texKey = key;
        if (!Object.prototype.hasOwnProperty.call(textures, key)) {
          // The engine resolves face textures against the CONSUMING block/item/entity
          // type's texture source at tesselation time, not (only) the shape's own map
          // (Lib:135809, Lib:155700): a key missing here may be supplied externally —
          // standard for vanilla block/entity shapes — and even an unresolvable key does
          // not throw on the default load paths (the engine logs and renders the
          // unknown-texture placeholder, Lib:155604-155662).
          const mapEmpty = textureKeys.length === 0;
          findings.push({
            severity: mapEmpty ? 'note' : 'warn',
            code: 'tex/dangling-key',
            element: name,
            message:
              `Face '${facing}' of element '${name}' references '${face.texture}' but the ` +
              `shape's textures map has no '${key}' entry` +
              (mapEmpty
                ? ` (the map is empty — this shape evidently relies on textures supplied by ` +
                  `the consuming block/item/entity type definition, a standard vanilla ` +
                  `pattern; fine if that type defines '${key}').`
                : ` (available: ${textureKeys.map((k) => `'${k}'`).join(', ')}). Unless the ` +
                  `consuming block/item/entity type supplies '${key}', the engine logs an ` +
                  `error and renders the unknown-texture placeholder.`),
            fix:
              `Add "${key}": "<asset path>" to the textures map, retarget the face` +
              (textureKeys.length > 0
                ? ` to one of: ${textureKeys.map((k) => `'#${k}'`).join(', ')},`
                : `,`) +
              ` or ensure the consuming type definition supplies '${key}'.`,
          });
        }
      }

      // -- uv rect ----------------------------------------------------------
      const [effW, effH] = effectiveSize(texKey);
      const uv = face.uv as unknown;
      if (uv !== undefined && uv !== null) {
        if (!isVec(uv, 4)) {
          findings.push({
            severity: 'warn',
            code: 'uv/malformed',
            element: name,
            message:
              `Face '${facing}' of element '${name}' has a malformed uv (expected ` +
              `[u1, v1, u2, v2]); the engine logs a warning and drops the face.`,
            fix: `Set uv to four numbers within the ${fmt(effW)}×${fmt(effH)} texture space.`,
          });
        } else {
          const [u1, v1, u2, v2] = [uv[0]!.value, uv[1]!.value, uv[2]!.value, uv[3]!.value];
          if (u1 > u2 || v1 > v2) {
            const parts: string[] = [];
            if (u1 > u2) parts.push('u');
            if (v1 > v2) parts.push('v');
            findings.push({
              severity: 'note',
              code: 'uv/inverted',
              element: name,
              message:
                `Face '${facing}' of element '${name}' has an inverted uv rect ` +
                `[${[u1, v1, u2, v2].map(fmt).join(', ')}] (${parts.join(' and ')} ` +
                `reversed): the texture samples MIRRORED on that axis. The engine accepts ` +
                `this (negative spans flow through the tesselator unchanged, ` +
                `Lib:155021-155053) and vanilla uses it to flip textures across symmetric ` +
                `parts — listed for awareness; nothing to fix if the mirroring is intended.`,
            });
          }
          const uOut = [u1, u2].some((u) => u < 0 || u > effW);
          const vOut = [v1, v2].some((v) => v < 0 || v > effH);
          if (uOut || vOut) {
            const clamp = (x: number, hi: number): number => Math.min(Math.max(x, 0), hi);
            const clamped = [clamp(u1, effW), clamp(v1, effH), clamp(u2, effW), clamp(v2, effH)];
            findings.push({
              severity: 'error',
              code: 'uv/out-of-bounds',
              element: name,
              message:
                `Face '${facing}' of element '${name}' has uv ` +
                `[${[u1, v1, u2, v2].map(fmt).join(', ')}] outside the ` +
                `${fmt(effW)}×${fmt(effH)} texture space` +
                (texKey !== undefined && isVec(textureSizes[texKey], 2)
                  ? ` (the textureSizes['${texKey}'] override)`
                  : ``) +
              ` (u must be within 0..${fmt(effW)}, v within 0..${fmt(effH)}).`,
              fix:
                `Clamp the rect to [${clamped.map(fmt).join(', ')}], or raise ` +
                (texKey !== undefined && isVec(textureSizes[texKey], 2)
                  ? `textureSizes['${texKey}']`
                  : `textureWidth/textureHeight (or add a textureSizes override)`) +
                ` to cover it.`,
            });
          }
        }
      }

      // -- uv rotation --------------------------------------------------------
      // tesselator.md §4: r = (int)(rotation/90) is used as a UV-cycle index offset;
      // negative values underflow the engine's table (crash on north faces).
      const rotation = numOf(face.rotation, 0);
      if (rotation < 0) {
        findings.push({
          severity: 'error',
          code: 'uv/bad-rotation',
          element: name,
          message:
            `Face '${facing}' of element '${name}' has uv rotation ${fmt(rotation)}; negative ` +
            `rotations underflow the engine's UV cycle table (crash on north faces, garbage ` +
            `elsewhere). Only 0, 90, 180 and 270 are valid.`,
          fix: `Replace with the equivalent positive rotation ${fmt(((rotation % 360) + 360) % 360)}.`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// anim/* static checks
// ---------------------------------------------------------------------------

const CHANNELS: readonly {
  name: 'offset' | 'rotation' | 'stretch';
  fields: readonly [keyof KeyFrameElementJson, keyof KeyFrameElementJson, keyof KeyFrameElementJson];
  neutral: number;
}[] = [
  { name: 'offset', fields: ['offsetX', 'offsetY', 'offsetZ'], neutral: 0 },
  { name: 'rotation', fields: ['rotationX', 'rotationY', 'rotationZ'], neutral: 0 },
  { name: 'stretch', fields: ['stretchX', 'stretchY', 'stretchZ'], neutral: 1 },
];

interface AnimInfo {
  anim: AnimationJson;
  code: string;
  /** False when a static error (no keyframes / frame overflow / partial channel) would make fk throw. */
  fkSafe: boolean;
}

function checkAnimations(
  root: ShapeJson,
  elementNames: Set<string>,
  findings: Finding[],
): AnimInfo[] {
  const anims: AnimationJson[] = Array.isArray(root.animations) ? root.animations : [];
  const infos: AnimInfo[] = [];

  // Duplicate effective codes (code defaults to name — GROUND-TRUTH §5).
  const byCode = new Map<string, AnimationJson[]>();
  for (const anim of anims) {
    if (!isObj(anim)) continue;
    const code = animCodeOf(anim);
    const list = byCode.get(code);
    if (list === undefined) byCode.set(code, [anim]);
    else list.push(anim);
  }
  for (const [code, list] of byCode) {
    if (list.length < 2) continue;
    findings.push({
      severity: 'error',
      code: 'anim/dup-code',
      animation: code,
      message:
        `${list.length} animations share the code '${code}' (names: ${list
          .map((a) => `'${a.name}'`)
          .join(', ')}); entities trigger animations by code, so only one is addressable.`,
      fix: `Give each animation a unique 'code' (or 'name', which is the code's fallback).`,
    });
  }

  // The 31-cap counts distinct animated elements across ALL animations of the shape: the
  // engine assigns one joint per keyframed element that resolves in the tree (jointsById,
  // Animation.GenerateAllFrames) — dangling names get no joint and are errored separately.
  const animatedExisting = new Set<string>();

  for (const anim of anims) {
    if (!isObj(anim)) continue;
    const code = animCodeOf(anim);
    let fkSafe = true;
    const keyframes: KeyFrameJson[] = Array.isArray(anim.keyframes) ? anim.keyframes : [];

    if (keyframes.length === 0) {
      fkSafe = false;
      findings.push({
        severity: 'error',
        code: 'anim/no-keyframes',
        animation: code,
        message:
          `Animation '${code}' has no keyframes; the engine throws ("has no keyframes, this ` +
          `will cause other errors every time it is ticked") when it compiles the shape.`,
        fix: `Add at least one keyframe (frame 0 is conventional) or delete the animation.`,
      });
      infos.push({ anim, code, fkSafe });
      continue;
    }

    // anim/unsorted-keyframes: the engine has TWO keyframe mechanisms — the per-channel
    // generation-time seek (array order, GenerateFrameForElement) and the runtime segment
    // lookup (getLeftRightResolvedFrame, API:143749, scans the ARRAY from the end for
    // frame <= current) — and they disagree with each other when the array is not sorted
    // ascending by frame (4 vanilla animations: elk/moose 'walkback'): some keyed poses
    // are then never realized exactly in-game. fk follows the generation-time mechanism.
    for (let i = 1; i < keyframes.length; i++) {
      if (numOf(keyframes[i]?.frame) < numOf(keyframes[i - 1]?.frame)) {
        findings.push({
          severity: 'warn',
          code: 'anim/unsorted-keyframes',
          animation: code,
          frame: numOf(keyframes[i]?.frame),
          message:
            `Animation '${code}' has keyframes out of frame order (frame ` +
            `${fmt(numOf(keyframes[i]?.frame))} after ${fmt(numOf(keyframes[i - 1]?.frame))}). ` +
            `The engine's runtime frame lookup follows ARRAY order, so out-of-order ` +
            `keyframes interpolate inconsistently in-game (some keyed poses are never ` +
            `reached exactly), and this tool's pose evaluation can differ from the engine ` +
            `by the same amount.`,
          fix: `Sort the keyframes ascending by frame (re-setting any keyframe via anim_set_keyframe re-sorts them).`,
        });
        break;
      }
    }

    const q = numOf(anim.quantityframes, 0);
    let maxFrame = -Infinity;
    for (const kf of keyframes) maxFrame = Math.max(maxFrame, numOf(kf?.frame));
    if (q <= maxFrame) {
      fkSafe = false;
      findings.push({
        severity: 'error',
        code: 'anim/frame-overflow',
        animation: code,
        frame: maxFrame,
        message:
          `Animation '${code}' has quantityframes ${fmt(q)}` +
          (anim.quantityframes == null ? ' (missing, treated as 0)' : '') +
          ` but a keyframe at frame ${fmt(maxFrame)}; the engine requires quantityframes to ` +
          `be strictly greater than every keyframe frame and throws at load otherwise.`,
        fix:
          `Raise quantityframes to at least ${fmt(maxFrame + 1)}, or move/delete the ` +
          `keyframes at frame ≥ ${fmt(q)} (anim_retime rescales them proportionally).`,
      });
    }

    // Dangling refs (grouped per element name) and partial channel triples.
    const danglingFrames = new Map<string, number[]>();
    for (const kf of keyframes) {
      if (!isObj(kf)) continue;
      const frame = numOf(kf.frame);
      const kfElements: unknown = kf.elements;
      if (!isObj(kfElements)) continue;
      for (const [refName, kfeRaw] of Object.entries(kfElements)) {
        if (!isObj(kfeRaw)) continue; // JSON-null entries are skipped by the engine
        const kfe = kfeRaw as KeyFrameElementJson;
        if (!elementNames.has(refName)) {
          const frames = danglingFrames.get(refName);
          if (frames === undefined) danglingFrames.set(refName, [frame]);
          else frames.push(frame);
        } else {
          animatedExisting.add(refName);
        }
        for (const channel of CHANNELS) {
          const present = channel.fields.filter((f) => kfe[f] != null);
          if (present.length === 0 || present.length === 3) continue;
          const missing = channel.fields.filter((f) => kfe[f] == null);
          fkSafe = false;
          findings.push({
            severity: 'error',
            code: 'anim/partial-channel',
            animation: code,
            frame,
            element: refName,
            message:
              `Keyframe at frame ${fmt(frame)} of animation '${code}' sets a partial ` +
              `${channel.name} channel on element '${refName}' (${present.join(', ')} set; ` +
              `${missing.join(', ')} missing); the engine NPEs when it lerps a channel ` +
              `with missing components.`,
            fix:
              `Set ${missing.join(' and ')} (neutral value ${channel.neutral}) or remove ` +
              `${present.join(', ')} from this keyframe entry.`,
          });
        }
      }
    }
    for (const [refName, frames] of danglingFrames) {
      const nearest = elementNames.size > 0 ? nearestName(refName, elementNames) : undefined;
      const more =
        frames.length > 1
          ? ` (also at frame${plural(frames.length - 1)} ${frames
              .slice(1, 6)
              .map(fmt)
              .join(', ')}${frames.length > 6 ? ` and ${frames.length - 6} more` : ''})`
          : '';
      findings.push({
        severity: 'error',
        code: 'anim/dangling-ref',
        animation: code,
        frame: frames[0]!,
        element: refName,
        message:
          `Animation '${code}' keyframe at frame ${fmt(frames[0]!)} animates element ` +
          `'${refName}', which does not exist in the tree${more}. The engine silently skips ` +
          `unknown names, so that part simply stops animating — this is what a rename without ` +
          `keyframe cascade looks like.` +
          (nearest !== undefined ? ` Nearest existing element: '${nearest}'.` : ''),
        fix:
          nearest !== undefined
            ? `Rename the keyframe entries to '${nearest}' (if that is the renamed element) ` +
              `or re-add an element named '${refName}'.`
            : `Add an element named '${refName}' or remove these keyframe entries.`,
      });
    }

    infos.push({ anim, code, fkSafe });
  }

  // Effective joint count: one per distinct keyframed element that resolves in the tree,
  // plus one for an existing-but-unkeyed 'head' (entity animators always require a 'head'
  // joint, API:155457/148122). The engine throws when the count REACHES the client cap
  // (jointsById.Count >= MaxAnimatedElements, API:143582).
  const headBump =
    animatedExisting.size > 0 && elementNames.has('head') && !animatedExisting.has('head')
      ? 1
      : 0;
  const joints = animatedExisting.size + headBump;
  if (joints >= JOINT_WARN_CAP) {
    findings.push({
      severity: 'warn',
      code: 'anim/joint-cap',
      message:
        `${joints} animation joints are needed (${animatedExisting.size} distinct keyframed ` +
        `element${plural(animatedExisting.size)}` +
        (headBump === 1 ? ` plus the always-required 'head' joint` : ``) +
        `), reaching the legacy cap of ${JOINT_WARN_CAP}. Clients whose ` +
        `"maxAnimatedElements" setting is ≤ ${joints} refuse to load the shape (the engine ` +
        `throws when the joint count reaches the cap); its own error advises raising the ` +
        `client setting to 46 ("this works for most GPUs"; vanilla 1.22 defaults to 230).`,
      fix:
        `Keep the joint count below ${JOINT_WARN_CAP} where possible ` +
        `— key a common parent instead of each child; children inherit the parent's motion.`,
    });
  }

  return infos;
}

// ---------------------------------------------------------------------------
// full: anim/hard-wrap
// ---------------------------------------------------------------------------

/**
 * Cycle smoothness for onAnimationEnd 'Repeat'.
 *
 * Why this is a *gap* check and not a plain last-vs-first pose comparison: the engine has no
 * "snap back to frame 0" — its keyframe seek wraps (GROUND-TRUTH §6): playing past the last
 * keyframe, the right keyframe becomes the FIRST keyed one again, and the pose lerps from the
 * last keyframe back to the first across span = firstFrame + (quantityFrames − lastFrame)
 * frames. So a Repeat loop is ALWAYS blended; whether the wrap is smooth depends on how much
 * time that blend gets. When the gap is ≥ 2 frames the wrap is an ordinary interpolation
 * segment; when the gap is ≤ 1 frame (typically a last keyframe at quantityFrames − 1) the
 * entire residual pose delta is crossed in one 30 fps tick — a visible snap whenever the
 * last-keyframe pose differs materially from the frame-0 pose.
 *
 * Poses are compared via interpolatePose at the last/first keyed frames, so channels whose
 * own last key sits earlier (and are already mid-wrap, hence near their frame-0 value) do
 * not false-positive. Rotation deltas are compared modulo 360° (shortest angular
 * distance): a k·360° wrap on a continuous rotator (devastation gears, jonas shafts) is
 * the same pose, not a snap. A missing onAnimationEnd means Repeat — the engine enum's
 * default member (EnumEntityAnimationEndHandling, API:143491/143538).
 */
function checkHardWrap(infos: AnimInfo[], findings: Finding[]): void {
  for (const { anim, code, fkSafe } of infos) {
    if (!fkSafe) continue; // a fast error already names the real problem
    const end = typeof anim.onAnimationEnd === 'string' ? anim.onAnimationEnd.trim() : 'Repeat';
    if (!/^repeat$/i.test(end)) continue;
    const keyframes = anim.keyframes;
    let first = Infinity;
    let last = -Infinity;
    for (const kf of keyframes) {
      const f = numOf(kf?.frame);
      if (f < first) first = f;
      if (f > last) last = f;
    }
    if (!Number.isFinite(first) || last === first) continue; // single key = constant pose
    const q = numOf(anim.quantityframes, 0);
    const gap = first + (q - last);
    if (gap > 1) continue;

    let endPoses: Map<string, PoseTf>;
    let startPoses: Map<string, PoseTf>;
    try {
      endPoses = interpolatePose(anim, last);
      startPoses = interpolatePose(anim, first);
    } catch (e) {
      // Defensive: fkSafe should have excluded everything interpolatePose throws on; if it
      // still throws, surface it as a finding rather than killing the whole validation run.
      findings.push({
        severity: 'error',
        code: 'anim/eval-failed',
        animation: code,
        message: `Animation '${code}' could not be evaluated: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    let worstRatio = 0;
    let worstElement = '';
    let worstDesc = '';
    const names = new Set([...endPoses.keys(), ...startPoses.keys()]);
    for (const name of names) {
      const a = endPoses.get(name) ?? IDENTITY_POSE;
      const b = startPoses.get(name) ?? IDENTITY_POSE;
      // Modulo-360 shortest angular distance: full turns are the same pose.
      const rotDelta = Math.max(
        Math.abs(angleDegDistance(a.degX, b.degX)),
        Math.abs(angleDegDistance(a.degY, b.degY)),
        Math.abs(angleDegDistance(a.degZ, b.degZ)),
      );
      const offDelta = Math.max(
        Math.abs(a.translateX - b.translateX),
        Math.abs(a.translateY - b.translateY),
        Math.abs(a.translateZ - b.translateZ),
      );
      const strDelta = Math.max(
        Math.abs(a.scaleX - b.scaleX),
        Math.abs(a.scaleY - b.scaleY),
        Math.abs(a.scaleZ - b.scaleZ),
      );
      const candidates: [number, string][] = [
        [rotDelta / HARD_WRAP_TOL_DEG, `rotation differs by ${fmt(rotDelta)}° (modulo 360°)`],
        // Report offsets in the 1/16-block units they are authored in.
        [offDelta / HARD_WRAP_TOL_BLOCKS, `offset differs by ${fmt(offDelta * 16)} (1/16 units)`],
        [strDelta / HARD_WRAP_TOL_STRETCH, `stretch differs by ${fmt(strDelta)}`],
      ];
      for (const [ratio, desc] of candidates) {
        if (ratio > worstRatio) {
          worstRatio = ratio;
          worstElement = name;
          worstDesc = desc;
        }
      }
    }
    if (worstRatio <= 1) continue;

    findings.push({
      severity: 'warn',
      code: 'anim/hard-wrap',
      animation: code,
      element: worstElement,
      frame: last,
      message:
        `Animation '${code}' (onAnimationEnd: Repeat) wraps from its last keyframe (frame ` +
        `${fmt(last)}) back to frame ${fmt(first)} in only ${fmt(gap)} frame${plural(gap)}, ` +
        `but the two poses differ materially — worst on element '${worstElement}': ` +
        `${worstDesc}. The engine always lerps across that gap, so the loop snaps visibly ` +
        `every cycle.`,
      fix:
        `Make the last keyframe's pose match frame ${fmt(first)}'s (a Repeat loop should end ` +
        `where it begins), or move the last keyframe to frame ≤ ${fmt(last - 2 + gap)} so ` +
        `the wrap gets ≥ 2 frames to blend.`,
    });
  }
}

// ---------------------------------------------------------------------------
// full: anim/foot-slide
// ---------------------------------------------------------------------------

/**
 * Foot slide: walk animations are authored in place (the game adds forward motion), so
 * during ground contact a foot should sweep backward at roughly constant horizontal
 * velocity — the constant the entity's ground speed cancels. Large velocity variation
 * while planted reads as the foot skating on the ground.
 *
 * Stance detection: frames where the foot's bottom-center y sits within the lowest
 * STANCE_BAND_FRACTION (20%) of that foot's y-range over the cycle. Frames are treated as a
 * cycle (locomotion animations loop), so a stance phase spanning the wrap is one run, and
 * the wrap segment's velocity is measured like any other. Only MID-stance segments are
 * scored (the first and last segment of a non-cyclic run are lift-off/touch-down, where
 * velocity legitimately ramps), the deviation is compared against FOOT_SLIDE_TOL — which
 * is calibrated so every vanilla locomotion cycle passes (see its doc) — and at most ONE
 * warn is emitted per animation, naming the worst foot/segment.
 */
function checkFootSlide(
  root: ShapeJson,
  infos: AnimInfo[],
  footElements: string[],
  elementNames: Set<string>,
  findings: Finding[],
): void {
  const missing = footElements.filter((n) => !elementNames.has(n));
  if (missing.length > 0) {
    const known = [...elementNames];
    throw new Error(
      `validateDocument: footElements ${missing.map((n) => `'${n}'`).join(', ')} do${
        missing.length === 1 ? 'es' : ''
      } not exist in the shape — names are case-sensitive. Known elements: ${known
        .slice(0, 30)
        .map((n) => `'${n}'`)
        .join(', ')}${known.length > 30 ? ` and ${known.length - 30} more` : ''}.`,
    );
  }

  for (const { code, fkSafe } of infos) {
    if (!fkSafe || !LOCOMOTION_RE.test(code)) continue;

    let contacts;
    try {
      contacts = footContacts(root, code, { elements: footElements });
    } catch (e) {
      findings.push({
        severity: 'error',
        code: 'anim/eval-failed',
        animation: code,
        message: `Animation '${code}' could not be evaluated: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    const q = contacts.length;
    if (q < 4) continue; // too few frames to tell stance from swing

    // Worst mid-stance deviation across ALL feet — one finding per animation at most.
    let score = 0;
    let worstFoot = '';
    let worstFrame = -1;
    let worstNext = -1;
    for (const foot of footElements) {
      const pos = contacts.map((c) => c.positions[foot]!);
      const ys = pos.map((p) => p[1]);
      const yMin = Math.min(...ys);
      const yMax = Math.max(...ys);
      // Tiny epsilon so a foot that never lifts (yRange 0 up to float noise) is all-stance.
      const band = yMin + Math.max((yMax - yMin) * STANCE_BAND_FRACTION, 1e-9);
      const stance = ys.map((y) => y <= band);

      // Cyclic runs of consecutive stance frames.
      const runs: number[][] = [];
      if (stance.every(Boolean)) {
        runs.push(contacts.map((c) => c.frame));
      } else {
        for (let s = 0; s < q; s++) {
          if (!stance[s] || stance[(s + q - 1) % q]) continue; // not a run start
          const run: number[] = [];
          for (let i = s; stance[i % q] && run.length < q; i++) run.push(i % q);
          runs.push(run);
        }
      }

      for (const run of runs) {
        if (run.length < 3) continue; // need ≥ 2 velocity segments to measure variation
        // Segments between consecutive stance frames; a full-cycle run also wraps q−1 → 0.
        const cyclic = run.length === q;
        const segCount = cyclic ? q : run.length - 1;
        const segs: { from: number; to: number; vx: number; vz: number }[] = [];
        for (let k = 0; k < segCount; k++) {
          const a = run[k]!;
          const b = run[(k + 1) % run.length]!;
          segs.push({
            from: a,
            to: b,
            vx: pos[b]![0] - pos[a]![0],
            vz: pos[b]![2] - pos[a]![2],
          });
        }
        // Mid-stance only: lift-off/touch-down segments (the ends of a non-cyclic run)
        // legitimately accelerate; a cyclic (never-lifting) run has no ends.
        const scored = cyclic ? segs : segs.slice(1, -1);
        if (scored.length < 2) continue;
        const mvx = scored.reduce((s, g) => s + g.vx, 0) / scored.length;
        const mvz = scored.reduce((s, g) => s + g.vz, 0) / scored.length;
        for (const g of scored) {
          const dev = Math.hypot(g.vx - mvx, g.vz - mvz);
          if (dev > score) {
            score = dev;
            worstFoot = foot;
            worstFrame = g.from;
            worstNext = g.to;
          }
        }
      }
    }

    if (score > FOOT_SLIDE_TOL) {
      findings.push({
        severity: 'warn',
        code: 'anim/foot-slide',
        animation: code,
        element: worstFoot,
        frame: worstFrame,
        message:
          `Animation '${code}': foot '${worstFoot}' slides during ground contact — its ` +
          `mid-stance horizontal velocity deviates up to ${fmt(score)} blocks/frame from ` +
          `the stance-phase mean (tolerance ${FOOT_SLIDE_TOL}, calibrated so every vanilla ` +
          `locomotion cycle passes); worst between frames ${worstFrame} and ${worstNext}. ` +
          `Stance = frames where the foot's bottom sits in the lowest ` +
          `${STANCE_BAND_FRACTION * 100}% of its vertical travel.`,
        fix:
          `Re-key the stance so '${worstFoot}' moves at roughly constant horizontal speed ` +
          `while planted (equal x/z offset deltas per frame); the game adds the entity's ` +
          `forward motion, so velocity wobble far beyond vanilla levels reads as skating.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Validate a shape document (a ShapeDocument or a bare ShapeJson tree).
 *
 * Returns findings in check order: structural tree, shape geometry, duplicate names, key
 * casing, step-parent notes, faces (uv + texture), animations (static), then — at level
 * 'full' — hard-wrap and foot-slide. Never throws on document content; throws only on
 * invalid options (unknown footElements names).
 */
export function validateDocument(doc: ShapeDocLike, opts: ValidateOptions = {}): Finding[] {
  const root = rootOf(doc);
  const findings: Finding[] = [];

  const entries = collectElements(root);
  const elementNames = new Set<string>();
  for (const { el } of entries) {
    if (typeof el.name === 'string') elementNames.add(el.name);
  }

  checkTreeShape(root, findings);
  checkBoxes(entries, findings);
  checkDuplicateNames(entries, findings);
  checkKeyCasing(root, entries, findings);
  checkStepParent(root, findings);
  checkFaces(root, entries, findings);
  const animInfos = checkAnimations(root, elementNames, findings);

  if (opts.level === 'full') {
    checkHardWrap(animInfos, findings);
    if (opts.footElements !== undefined && opts.footElements.length > 0) {
      checkFootSlide(root, animInfos, opts.footElements, elementNames, findings);
    }
  }

  return findings;
}
