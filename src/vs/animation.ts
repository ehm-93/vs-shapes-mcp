/**
 * Animation operations on a ShapeDocument: create / delete / meta-edit animations,
 * keyframe CRUD, channel-wide adjustments, proportional retiming, and gait-cycle phase
 * mirroring.
 *
 * Transactions: ops here do NOT call doc.transact — the MCP server wraps each tool call
 * in exactly one transaction, so a throwing op rolls the document back wholesale. Ops
 * still validate before mutating wherever practical.
 *
 * Engine constraints enforced here (GROUND-TRUTH §5–§6):
 * - Setting a channel always writes the FULL triple (offsetX/Y/Z, …): the engine
 *   dereferences all three components of a set channel and NPEs on partial triples.
 * - Keyframe frames are integers with 0 ≤ frame < quantityframes (strictly less — the
 *   engine throws on load otherwise).
 * - Keyframes are kept sorted by frame (the engine's seek walks them in array order).
 */

import type { ShapeDocument } from './document.js';
import { cloneJsonValue, invalidateShadows, vsnum } from './json.js';
import {
  type AnimationJson,
  type JsonObject,
  type JsonValue,
  type KeyFrameElementJson,
  type KeyFrameJson,
  type Vec3,
} from './types.js';
import { assertVec3, describeUnknown, docLabel, requireElement, suggestNames } from './elements.js';

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** Effective code: the animation's `code`, defaulting to `name` (GROUND-TRUTH §5). */
export const animCodeOf = (anim: AnimationJson): string => anim.code ?? anim.name;

function requireAnimation(doc: ShapeDocument, code: string, op: string): AnimationJson {
  const anim = doc.getAnimation(code);
  if (anim !== undefined) return anim;
  const codes = doc.listAnimations().map(animCodeOf);
  throw new Error(`${op}: ${describeUnknown('animation', code, codes, docLabel(doc))}`);
}

/**
 * Refuses a new code that collides with any other animation's code OR name (the engine
 * falls back from code to name, so both must stay distinct). `self` is exempted.
 */
function assertCodeFree(doc: ShapeDocument, code: string, op: string, self?: AnimationJson): void {
  for (const anim of doc.listAnimations()) {
    if (anim === self) continue;
    if (anim.code === code || anim.name === code) {
      const field = anim.code === code ? 'code' : 'name';
      throw new Error(
        `${op}: '${code}' collides with the ${field} of the existing animation ` +
          `'${animCodeOf(anim)}' in ${docLabel(doc)} — animation codes (and names, which codes ` +
          `default to) must be unique; pick another code`,
      );
    }
  }
}

const sortKeyframes = (anim: AnimationJson): void => {
  anim.keyframes?.sort((a, b) => a.frame.value - b.frame.value);
};

const CHANNEL_FIELDS = {
  offset: ['offsetX', 'offsetY', 'offsetZ'],
  rotation: ['rotationX', 'rotationY', 'rotationZ'],
  stretch: ['stretchX', 'stretchY', 'stretchZ'],
} as const;

export type ChannelName = keyof typeof CHANNEL_FIELDS;

const ALL_CHANNEL_FIELDS = [
  ...CHANNEL_FIELDS.offset,
  ...CHANNEL_FIELDS.rotation,
  ...CHANNEL_FIELDS.stretch,
] as const;

/** True when the entry still sets at least one channel component (null counts as unset). */
const entryHasAnyChannel = (kfe: KeyFrameElementJson): boolean =>
  ALL_CHANNEL_FIELDS.some((f) => kfe[f] != null);

// ---------------------------------------------------------------------------
// createAnimation / deleteAnimation / editAnimationMeta
// ---------------------------------------------------------------------------

export interface CreateAnimationOpts {
  code: string;
  /** Defaults to `code`. */
  name?: string;
  quantityFrames: number;
  /** Default 'Repeat'. */
  onAnimationEnd?: 'Repeat' | 'Hold' | 'Stop' | 'EaseOut';
  /** Default 'EaseOut' (the common vanilla choice; the engine default is 'Rewind'). */
  onActivityStopped?: string;
}

export function createAnimation(doc: ShapeDocument, opts: CreateAnimationOpts): AnimationJson {
  const op = 'createAnimation';
  if (typeof opts.code !== 'string' || opts.code.length === 0) {
    throw new Error(`${op}: the animation needs a non-empty code (entities trigger animations by code)`);
  }
  if (!Number.isInteger(opts.quantityFrames) || opts.quantityFrames < 1) {
    throw new Error(
      `${op}: quantityFrames must be a positive integer (30 ≈ 1 second at the 30 fps convention), ` +
        `got ${opts.quantityFrames}`,
    );
  }
  assertCodeFree(doc, opts.code, op);

  // Vanilla key order: name, code, quantityframes, onActivityStopped, onAnimationEnd, keyframes.
  const anim: AnimationJson = {
    name: opts.name ?? opts.code,
    code: opts.code,
    quantityframes: vsnum(opts.quantityFrames),
    onActivityStopped: opts.onActivityStopped ?? 'EaseOut',
    onAnimationEnd: opts.onAnimationEnd ?? 'Repeat',
    keyframes: [],
  };
  doc.root.animations ??= [];
  doc.root.animations.push(anim);
  return anim;
}

export function deleteAnimation(doc: ShapeDocument, code: string): void {
  const op = 'deleteAnimation';
  const anim = requireAnimation(doc, code, op);
  const anims = doc.root.animations!;
  anims.splice(anims.indexOf(anim), 1);
}

export interface AnimationMetaPatch {
  /** Renames the animation code (uniqueness enforced across all codes and names). */
  code?: string;
  name?: string;
  /**
   * Sets quantityframes directly WITHOUT moving keyframes; must stay strictly greater
   * than every keyframe frame. Use retimeAnimation to rescale keyframes proportionally.
   */
  quantityFrames?: number;
  /** null deletes the key (engine default applies). */
  onAnimationEnd?: string | null;
  onActivityStopped?: string | null;
  easeAnimationSpeed?: boolean | null;
  version?: number | null;
}

export function editAnimationMeta(
  doc: ShapeDocument,
  code: string,
  patch: AnimationMetaPatch,
): AnimationJson {
  const op = 'editAnimationMeta';
  const anim = requireAnimation(doc, code, op);

  if (patch.code !== undefined) {
    if (typeof patch.code !== 'string' || patch.code.length === 0) {
      throw new Error(`${op}('${code}'): the new code must be a non-empty string`);
    }
    assertCodeFree(doc, patch.code, op, anim);
  }
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || patch.name.length === 0) {
      throw new Error(`${op}('${code}'): the new name must be a non-empty string`);
    }
    // The name becomes the effective code when no explicit code exists (after this patch).
    const finalCode = patch.code ?? anim.code;
    if (finalCode === undefined) assertCodeFree(doc, patch.name, op, anim);
  }
  if (patch.quantityFrames !== undefined) {
    const q = patch.quantityFrames;
    if (!Number.isInteger(q) || q < 1) {
      throw new Error(`${op}('${code}'): quantityFrames must be a positive integer, got ${q}`);
    }
    const maxFrame = Math.max(-1, ...(anim.keyframes ?? []).map((kf) => kf.frame.value));
    if (q <= maxFrame) {
      throw new Error(
        `${op}('${code}'): quantityFrames ${q} is not strictly greater than the last keyframe ` +
          `frame ${maxFrame} — the engine throws on load. Use at least ${maxFrame + 1}, or ` +
          `retimeAnimation to rescale the keyframes proportionally.`,
      );
    }
  }

  if (patch.code !== undefined) anim.code = patch.code;
  if (patch.name !== undefined) anim.name = patch.name;
  if (patch.quantityFrames !== undefined) anim.quantityframes = vsnum(patch.quantityFrames);
  for (const key of ['onAnimationEnd', 'onActivityStopped'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (v === null) delete anim[key];
    else anim[key] = v;
  }
  if (patch.easeAnimationSpeed !== undefined) {
    if (patch.easeAnimationSpeed === null) delete anim.easeAnimationSpeed;
    else anim.easeAnimationSpeed = patch.easeAnimationSpeed;
  }
  if (patch.version !== undefined) {
    if (patch.version === null) delete anim.version;
    else anim.version = vsnum(patch.version);
  }
  return anim;
}

// ---------------------------------------------------------------------------
// setKeyframe / deleteKeyframe
// ---------------------------------------------------------------------------

export interface KeyframePose {
  /** Vec3 sets the full triple (1/16-block units); null clears the channel; absent leaves it. */
  offset?: Vec3 | null;
  /** Degrees. */
  rotation?: Vec3 | null;
  /** Scale factors (neutral 1). */
  stretch?: Vec3 | null;
  /**
   * Per-axis shortest-angular-path flags for the rotation lerp out of this keyframe
   * (GROUND-TRUTH §6 — continuous rotators like gears need them at the cycle wrap).
   * Given axes are set/removed individually; null removes all three. Only meaningful
   * when the entry also has a rotation channel (the engine reads them off the LEFT
   * rotation keyframe).
   */
  rotShortestDistance?: { x?: boolean; y?: boolean; z?: boolean } | null;
}

/**
 * Sets or clears channels of one element's entry at one keyframe. A non-null channel
 * always writes the FULL triple (GROUND-TRUTH §6 — the engine NPEs on partial triples);
 * null clears the channel's three fields. The entry is pruned when no channel remains,
 * the keyframe is pruned when no entry remains, and keyframes stay sorted by frame.
 *
 * Returns the resulting entry, or null when it was pruned.
 */
export function setKeyframe(
  doc: ShapeDocument,
  code: string,
  frame: number,
  element: string,
  pose: KeyframePose,
): KeyFrameElementJson | null {
  const op = 'setKeyframe';
  const anim = requireAnimation(doc, code, op);
  requireElement(doc, element, op);
  const q = anim.quantityframes.value;
  if (!Number.isInteger(frame)) {
    throw new Error(`${op}: frame must be an integer, got ${frame} (animation '${code}')`);
  }
  if (frame < 0 || frame >= q) {
    throw new Error(
      `${op}: frame ${frame} is out of range for animation '${code}' — quantityframes is ${q}, ` +
        `so valid frames are 0..${q - 1}; raise quantityframes (editAnimationMeta or ` +
        `retimeAnimation) to key later frames`,
    );
  }
  const channels = (['offset', 'rotation', 'stretch'] as const).filter((c) => pose[c] !== undefined);
  if (channels.length === 0 && pose.rotShortestDistance === undefined) {
    throw new Error(
      `${op}: the pose for '${element}' sets no channels — pass offset/rotation/stretch as a ` +
        `[x, y, z] triple to set (or null to clear), and/or rotShortestDistance flags`,
    );
  }
  for (const channel of channels) {
    const v = pose[channel];
    if (v !== null) assertVec3(v, `${op}: '${channel}' for '${element}'`);
  }

  anim.keyframes ??= [];
  let kf = anim.keyframes.find((k) => k.frame.value === frame);
  let createdKf = false;
  if (kf === undefined) {
    kf = { frame: vsnum(frame), elements: {} };
    anim.keyframes.push(kf);
    createdKf = true;
  }
  kf.elements ??= {};
  let entry = kf.elements[element];
  if (entry === undefined) {
    entry = {};
    kf.elements[element] = entry;
  }

  for (const channel of channels) {
    const v = pose[channel]!;
    const fields = CHANNEL_FIELDS[channel];
    if (v === null) {
      for (const f of fields) delete entry[f];
    } else {
      for (let i = 0; i < 3; i++) entry[fields[i]!] = vsnum(v[i]!);
    }
  }
  if (pose.rotShortestDistance !== undefined) {
    const FLAGS = ['rotShortestDistanceX', 'rotShortestDistanceY', 'rotShortestDistanceZ'] as const;
    if (pose.rotShortestDistance === null) {
      for (const f of FLAGS) delete entry[f];
    } else {
      for (const [axis, field] of [['x', FLAGS[0]], ['y', FLAGS[1]], ['z', FLAGS[2]]] as const) {
        const v = pose.rotShortestDistance[axis];
        if (v === undefined) continue;
        if (v) entry[field] = true;
        else delete entry[field];
      }
    }
  }
  // The entry was mutated IN PLACE: if the source file duplicated this element's key in
  // the keyframe map (a handful of vanilla files do), drop the now-stale earlier
  // occurrence instead of re-saving a line that contradicts this edit.
  invalidateShadows(kf.elements as unknown as JsonObject, element);

  let pruned = false;
  if (!entryHasAnyChannel(entry)) {
    delete kf.elements[element];
    pruned = true;
  }
  if (Object.keys(kf.elements).length === 0) {
    anim.keyframes.splice(anim.keyframes.indexOf(kf), 1);
  } else if (createdKf) {
    sortKeyframes(anim);
  }
  return pruned ? null : entry;
}

/**
 * Deletes a whole keyframe, or just one element's entry when `element` is given.
 * The element may be a stale (ghost) reference — only the keyframe entry must exist.
 */
export function deleteKeyframe(
  doc: ShapeDocument,
  code: string,
  frame: number,
  element?: string,
): void {
  const op = 'deleteKeyframe';
  const anim = requireAnimation(doc, code, op);
  const keyframes = anim.keyframes ?? [];
  const idx = keyframes.findIndex((k) => k.frame.value === frame);
  if (idx === -1) {
    const frames = keyframes.map((k) => k.frame.value);
    throw new Error(
      `${op}: animation '${code}' has no keyframe at frame ${frame}` +
        (frames.length > 0 ? ` — existing keyframe frames: ${frames.join(', ')}` : ' — it has no keyframes'),
    );
  }
  if (element === undefined) {
    keyframes.splice(idx, 1);
    return;
  }
  const kf = keyframes[idx]!;
  const elements = kf.elements ?? {};
  if (!Object.prototype.hasOwnProperty.call(elements, element)) {
    throw new Error(
      `${op}: ${describeUnknown(
        'keyframe entry',
        element,
        Object.keys(elements),
        `frame ${frame} of animation '${code}'`,
      )}`,
    );
  }
  delete elements[element];
  if (Object.keys(elements).length === 0) keyframes.splice(idx, 1);
}

// ---------------------------------------------------------------------------
// adjustChannel
// ---------------------------------------------------------------------------

export interface AdjustChannelOpts {
  /** '*' = every element keyed anywhere in the animation. */
  elements: '*' | string[];
  channel: ChannelName;
  op: 'scale' | 'add' | 'clamp';
  /** Required for scale/add; scalar applies to all three components. */
  value?: number | Vec3;
  /** clamp bounds (at least one required for clamp). */
  min?: number | Vec3;
  max?: number | Vec3;
}

export interface AdjustChannelResult {
  keyframesTouched: number;
  entriesTouched: number;
}

const toTriple = (v: number | Vec3, what: string): Vec3 => {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`${what} must be finite, got ${v}`);
    return [v, v, v];
  }
  assertVec3(v, what);
  return v;
};

/**
 * Applies scale/add/clamp to one channel across all keyframes of the listed elements.
 * Only components that are present are touched (a channel an entry does not set stays
 * unset; partial triples — already invalid per GROUND-TRUTH §6 — are adjusted as-is and
 * left for the validator to flag).
 */
export function adjustChannel(doc: ShapeDocument, code: string, opts: AdjustChannelOpts): AdjustChannelResult {
  const op = 'adjustChannel';
  const anim = requireAnimation(doc, code, op);
  if (!(opts.channel in CHANNEL_FIELDS)) {
    throw new Error(`${op}: channel must be 'offset', 'rotation' or 'stretch', got '${String(opts.channel)}'`);
  }
  const fields = CHANNEL_FIELDS[opts.channel];

  let lo: Vec3 = [-Infinity, -Infinity, -Infinity];
  let hi: Vec3 = [Infinity, Infinity, Infinity];
  let val: Vec3 = [0, 0, 0];
  if (opts.op === 'scale' || opts.op === 'add') {
    if (opts.value === undefined) {
      throw new Error(`${op}('${code}'): op '${opts.op}' requires 'value' (a number or [x, y, z])`);
    }
    val = toTriple(opts.value, `${op}: 'value'`);
  } else if (opts.op === 'clamp') {
    if (opts.min === undefined && opts.max === undefined) {
      throw new Error(`${op}('${code}'): op 'clamp' requires 'min' and/or 'max'`);
    }
    if (opts.min !== undefined) lo = toTriple(opts.min, `${op}: 'min'`);
    if (opts.max !== undefined) hi = toTriple(opts.max, `${op}: 'max'`);
    for (let i = 0; i < 3; i++) {
      if (lo[i]! > hi[i]!) {
        throw new Error(`${op}('${code}'): min ${JSON.stringify(lo)} exceeds max ${JSON.stringify(hi)} on axis ${i}`);
      }
    }
  } else {
    throw new Error(`${op}: op must be 'scale', 'add' or 'clamp', got '${String(opts.op)}'`);
  }

  const keyframes = anim.keyframes ?? [];
  const keyedNames = new Set<string>();
  for (const kf of keyframes) {
    for (const n of Object.keys(kf.elements ?? {})) keyedNames.add(n);
  }
  let targets: Set<string>;
  if (opts.elements === '*') {
    targets = keyedNames;
  } else {
    for (const n of opts.elements) {
      if (!keyedNames.has(n)) {
        const near = suggestNames(n, keyedNames);
        throw new Error(
          `${op}: element '${n}' has no keyframe entries in animation '${code}'` +
            (near.length > 0 ? ` — did you mean ${near.map((s) => `'${s}'`).join(', ')}?` : ' —') +
            ` keyed elements: ${[...keyedNames].join(', ') || '(none)'}`,
        );
      }
    }
    targets = new Set(opts.elements);
  }

  const apply = (v: number, i: number): number => {
    switch (opts.op) {
      case 'scale':
        return v * val[i]!;
      case 'add':
        return v + val[i]!;
      default:
        return Math.min(Math.max(v, lo[i]!), hi[i]!);
    }
  };

  let entriesTouched = 0;
  let keyframesTouched = 0;
  for (const kf of keyframes) {
    let touchedThisKf = false;
    for (const [name, entry] of Object.entries(kf.elements ?? {})) {
      if (!targets.has(name)) continue;
      let touched = false;
      for (let i = 0; i < 3; i++) {
        const f = fields[i]!;
        const cur = entry[f];
        if (cur == null) continue;
        const next = apply(cur.value, i);
        if (next !== cur.value) entry[f] = vsnum(next);
        touched = true;
      }
      if (touched) {
        entriesTouched++;
        touchedThisKf = true;
        // In-place mutation: drop stale shadow duplicates of this entry's key (see setKeyframe).
        invalidateShadows(kf.elements as unknown as JsonObject, name);
      }
    }
    if (touchedThisKf) keyframesTouched++;
  }
  return { keyframesTouched, entriesTouched };
}

// ---------------------------------------------------------------------------
// retimeAnimation
// ---------------------------------------------------------------------------

export interface RetimeResult {
  /** Old frame → new frame for every keyframe. */
  mapping: { from: number; to: number }[];
}

/**
 * Rescales every keyframe proportionally to a new cycle length: newFrame =
 * round(frame · newQ / oldQ), clamped to newQ − 1 (round-to-nearest can land exactly on
 * newQ for the last frame of an odd ratio). Throws — naming the colliding keyframes —
 * when rounding would collapse two keyframes onto the same frame.
 */
export function retimeAnimation(doc: ShapeDocument, code: string, newQuantityFrames: number): RetimeResult {
  const op = 'retimeAnimation';
  const anim = requireAnimation(doc, code, op);
  if (!Number.isInteger(newQuantityFrames) || newQuantityFrames < 1) {
    throw new Error(`${op}('${code}'): newQuantityFrames must be a positive integer, got ${newQuantityFrames}`);
  }
  const oldQ = anim.quantityframes.value;
  if (!(oldQ > 0)) {
    throw new Error(
      `${op}('${code}'): the animation's current quantityframes is ${oldQ}; fix it with ` +
        `editAnimationMeta before retiming`,
    );
  }
  const keyframes = anim.keyframes ?? [];
  const mapping: { from: number; to: number }[] = [];
  const byTarget = new Map<number, number[]>();
  for (const kf of keyframes) {
    const from = kf.frame.value;
    const to = Math.min(Math.round((from * newQuantityFrames) / oldQ), newQuantityFrames - 1);
    mapping.push({ from, to });
    const olds = byTarget.get(to) ?? [];
    olds.push(from);
    byTarget.set(to, olds);
  }
  const collisions = [...byTarget.entries()].filter(([, olds]) => olds.length > 1);
  if (collisions.length > 0) {
    const desc = collisions
      .map(([to, olds]) => `frames ${olds.join(' and ')} (of ${oldQ}) would both land on frame ${to}`)
      .join('; ');
    throw new Error(
      `${op}('${code}', ${newQuantityFrames}): ${desc} — choose a larger quantityframes or ` +
        `delete one of the colliding keyframes first`,
    );
  }
  for (let i = 0; i < keyframes.length; i++) {
    keyframes[i]!.frame = vsnum(mapping[i]!.to);
  }
  anim.quantityframes = vsnum(newQuantityFrames);
  sortKeyframes(anim);
  return { mapping };
}

// ---------------------------------------------------------------------------
// mirrorPhase
// ---------------------------------------------------------------------------

export interface MirrorPhaseResult {
  /** Target frames written (frame + q/2 for every source keyframe with frame < q/2). */
  framesWritten: number[];
}

/**
 * Mirror-conjugates one keyframe entry across the sagittal plane normal to `axis`,
 * matching element_mirror's rotation rules: a 'z' mirror negates rotationX/rotationY and
 * offsetZ (keeps rotationZ); an 'x' mirror negates rotationY/rotationZ and offsetX
 * (keeps rotationX). Stretch and rotShortestDistance flags are unchanged.
 */
function conjugateEntry(entry: KeyFrameElementJson, axis: 'x' | 'z'): void {
  const negate = (field: keyof KeyFrameElementJson): void => {
    const v = entry[field];
    if (v !== undefined && typeof v === 'object' && 'value' in v) {
      (entry as Record<string, unknown>)[field] = vsnum(-v.value);
    }
  };
  if (axis === 'z') {
    negate('rotationX');
    negate('rotationY');
    negate('offsetZ');
  } else {
    negate('rotationY');
    negate('rotationZ');
    negate('offsetX');
  }
}

/**
 * Contralateral phase copy for gait cycles: for every keyframe with frame < q/2, writes
 * (replacing any existing keyframe) frame + q/2 where each [a, b] pair's channel values
 * are swapped (a's entry is written under b and vice versa) and unpaired elements are
 * copied as-is. Requires an even quantityframes.
 *
 * `axis` (default 'z' — VS creatures are z-symmetric) mirror-conjugates every copied
 * entry across the sagittal plane, exactly like element_mirror conjugates static
 * rotations: for 'z', rotationX/rotationY and offsetZ negate while rotationZ holds.
 * That makes the copy correct for any keyed channel — quadruped/biped rotZ swings pass
 * through unchanged, while spider-style rotX/rotY lifts and lateral sways flip as the
 * contralateral side requires (unpaired elements like tails and heads flip too, which is
 * what an alternating gait wants). Pass 'none' for a verbatim copy (legacy behavior).
 */
export function mirrorPhase(
  doc: ShapeDocument,
  code: string,
  pairs: [string, string][],
  opts: { axis?: 'x' | 'z' | 'none' } = {},
): MirrorPhaseResult {
  const op = 'mirrorPhase';
  const axis = opts.axis ?? 'z';
  if (axis !== 'x' && axis !== 'z' && axis !== 'none') {
    throw new Error(`${op}: axis must be 'x', 'z' or 'none', got ${JSON.stringify(axis)}`);
  }
  const anim = requireAnimation(doc, code, op);
  const q = anim.quantityframes.value;
  if (!Number.isInteger(q) || q < 2 || q % 2 !== 0) {
    throw new Error(
      `${op}('${code}'): quantityframes is ${q} — mirrorPhase needs an even cycle length so ` +
        `frame + q/2 stays an integer frame; retimeAnimation to ${Math.max(2, Math.ceil(q / 2) * 2)} first`,
    );
  }
  const pairMap = new Map<string, string>();
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error(`${op}: each pair must be a [nameA, nameB] tuple, got ${JSON.stringify(pair)}`);
    }
    const [a, b] = pair;
    if (a === b) {
      throw new Error(`${op}: pair ['${a}', '${b}'] names the same element twice — pairs must be two distinct elements`);
    }
    for (const n of [a, b]) {
      requireElement(doc, n, op);
      if (pairMap.has(n)) {
        throw new Error(`${op}: element '${n}' appears in more than one pair — each element may be paired only once`);
      }
    }
    pairMap.set(a, b);
    pairMap.set(b, a);
  }

  const half = q / 2;
  const keyframes = (anim.keyframes ??= []);
  const sources = keyframes.filter((kf) => kf.frame.value < half);
  const framesWritten: number[] = [];
  for (const src of sources) {
    const targetFrame = src.frame.value + half;
    const elements: KeyFrameJson['elements'] = {};
    for (const [name, entry] of Object.entries(src.elements ?? {})) {
      const targetName = pairMap.get(name) ?? name;
      const copy = cloneJsonValue(entry as unknown as JsonValue) as KeyFrameElementJson;
      if (axis !== 'none') conjugateEntry(copy, axis);
      elements[targetName] = copy;
    }
    const existingIdx = keyframes.findIndex((kf) => kf.frame.value === targetFrame);
    if (existingIdx !== -1) keyframes.splice(existingIdx, 1);
    keyframes.push({ frame: vsnum(targetFrame), elements });
    framesWritten.push(targetFrame);
  }
  sortKeyframes(anim);
  return { framesWritten: framesWritten.sort((a, b) => a - b) };
}
