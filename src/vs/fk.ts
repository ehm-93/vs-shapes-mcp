/**
 * Forward kinematics: exact port of the engine's keyframe interpolation plus posed
 * world-space geometry.
 *
 * Sources (Vintage Story 1.22, decompiled VintagestoryAPI.decompiled.cs):
 * - Animation.GenerateFrameForElement :143638, lerpKeyFrameElement :143669,
 *   getTwoKeyFramesElementForFlag :143698, seekRightKeyFrame :143713,
 *   seekLeftKeyFrame :143735, GenerateFrame :143603 (recursive world = parent · local).
 * - AnimationKeyFrameElement.PositionSet/RotationSet/StretchSet :144102 (a channel is
 *   "set" when any of its three components is non-null).
 * - ElementPose.Add :146322 (runtime lerp between generated keyframe frames; shortest-path
 *   rotation lerp when the left keyframe sets rotShortestDistanceX/Y/Z) and
 *   ClientAnimator.calculateMatrices :146130 (Hold end-clamp :146147).
 * - GameMath.Mod :15246/:15270 (true modulo, result sign follows the divisor),
 *   GameMath.Lerp :15726 (plain v0 + (v1−v0)·t), GameMath.AngleDegDistance :15323
 *   (`((end − start) % 360 + 540) % 360 − 180`, shortest signed angular distance).
 *
 * Normative semantics: docs/GROUND-TRUTH.md §5–§6 (interpolation),
 * docs/ground-truth/tesselator.md §2–§4 and §6 (face emission, UV mapping, shading).
 *
 * Fractional-frame generalization: the engine pre-generates one pose per keyframe
 * (GenerateAllFrames) and at runtime lerps between the two generated frames bracketing the
 * float CurrentFrame. This port evaluates the per-channel seek directly at the (possibly
 * fractional) requested frame; for keyframe arrays sorted ascending by frame the two
 * mechanisms agree (generated frames are plain-lerp samples of the same channel segments),
 * so integer inputs match the engine bit-for-bit (modulo float→double precision). Frames
 * outside [0, quantityFrames) are wrapped with the true modulo first.
 *
 * Known divergences, both narrow and deliberate:
 * - Unsorted keyframe arrays (4 vanilla animations: elk/moose 'walkback'): the engine's
 *   runtime segment lookup (getLeftRightResolvedFrame :143749) scans the keyframe ARRAY
 *   from the end, not frame order, and on such inputs disagrees with the engine's own
 *   generation-time per-channel seek. This port matches the generation-time mechanism;
 *   the validator warns (anim/unsorted-keyframes).
 * - rotShortestDistance: the engine applies the shortest-path lerp per runtime segment
 *   between consecutive animation keyframes; this port applies it across the whole
 *   rotation-channel segment (left keyed frame → right keyed frame). The two agree unless
 *   a flagged channel segment both spans more than 180° and contains intermediate
 *   keyframes keyed only for other channels — none of the 37 flag-bearing rotation
 *   segments in the vanilla 1.22 corpus does.
 *
 * Behavior exactly AT a set keyframe frame F (sorted arrays): seekRightKeyFrame skips F
 * (strictly-greater comparison) and returns the next set keyframe (wrapping to the first
 * when none follows); seekLeftKeyFrame then lands on F itself, so left.frame == F and
 * t == 0 in both the wrap and no-wrap branches — the pose is exactly the keyed values.
 *
 * onAnimationEnd 'Hold' parks playback at quantityframes − 1, where the engine replaces
 * the 'next' generated frame with 'prev' (API:146147, RunningAnimation clamp :147168) —
 * the held resting pose is the LAST keyframe's generated frame, not a wrap-lerp toward
 * frame 0; interpolatePose reproduces that clamp.
 *
 * stepParentName is an attach-time overlay mechanism (Shape.StepParentShape, API:147876):
 * the engine only consults it when a part shape is overlaid onto another shape, never when
 * a shape is loaded standalone — fk intentionally ignores it (the validator emits a
 * shape/step-parent note so renders of floating part shapes are explainable).
 */

import {
  FACE_NAMES,
  IDENTITY_POSE,
  type AnimationJson,
  type ElementJson,
  type FaceJson,
  type FaceName,
  type KeyFrameElementJson,
  type KeyFrameJson,
  type PoseTf,
  type RenderFace,
  type ShapeJson,
  type Vec3,
  type VsNum,
} from './types.js';
import {
  localTransformMatrix,
  mat4Create,
  mat4Mul,
  mat4TransformVec3,
  type ElementTransformView,
  type Mat4,
} from './transform.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Reads a possibly-absent VsNum; JSON `null` is treated like absent (engine: nullable double). */
const optNum = (v: VsNum | null | undefined): number | undefined =>
  v == null ? undefined : v.value;

const reqNum = (v: VsNum | null | undefined, fallback = 0): number =>
  v == null ? fallback : v.value;

/** Port of GameMath.Mod: true modulo, result in [0, n) for n > 0. */
const mod = (k: number, n: number): number => {
  const r = k % n;
  return r < 0 ? r + n : r;
};

/** Port of GameMath.Lerp. */
const lerp = (v0: number, v1: number, t: number): number => v0 + (v1 - v0) * t;

/**
 * Port of GameMath.AngleDegDistance (API:15323): shortest signed angular distance from
 * `start` to `end` in degrees, in [−180, 180). JS `%` matches C# `%` here (sign of the
 * dividend), and the +540 keeps the second modulo's operand positive.
 */
export const angleDegDistance = (start: number, end: number): number =>
  ((((end - start) % 360) + 540) % 360) - 180;

const animCodeOf = (anim: AnimationJson): string => anim.code ?? anim.name;

/**
 * The geometry entry points accept either the parsed shape tree itself or any holder that
 * exposes it as `root` (e.g. ShapeDocument) — fk must not import document.ts.
 */
export type ShapeDocLike = ShapeJson | { root: ShapeJson };

/**
 * Resolve the shape tree from a ShapeDocLike. A bare tree may legitimately omit the
 * `elements` key (such shapes parse and traverse as empty), so a missing `elements` must
 * NOT make the object look like a document holder — only an object that actually has a
 * `root` is treated as one.
 */
export const rootOf = (doc: ShapeDocLike): ShapeJson => {
  if ('elements' in doc) return doc;
  if ('root' in doc) return doc.root;
  return doc as ShapeJson;
};

// ---------------------------------------------------------------------------
// Keyframe interpolation — exact port of Animation.GenerateFrameForElement
// ---------------------------------------------------------------------------

/** Channel flags exactly as in the engine: 0 = offset, 1 = rotation, 2 = stretch. */
type ChannelFlag = 0 | 1 | 2;

const CHANNEL_FIELDS: readonly [
  readonly ['offsetX', 'offsetY', 'offsetZ'],
  readonly ['rotationX', 'rotationY', 'rotationZ'],
  readonly ['stretchX', 'stretchY', 'stretchZ'],
] = [
  ['offsetX', 'offsetY', 'offsetZ'],
  ['rotationX', 'rotationY', 'rotationZ'],
  ['stretchX', 'stretchY', 'stretchZ'],
];

const CHANNEL_NAMES = ['offset', 'rotation', 'stretch'] as const;

/** Port of AnimationKeyFrameElement.IsSet for flags 0–2: any component non-null. */
function channelIsSet(kfe: KeyFrameElementJson, flag: ChannelFlag): boolean {
  const [fx, fy, fz] = CHANNEL_FIELDS[flag];
  return kfe[fx] != null || kfe[fy] != null || kfe[fz] != null;
}

function keyFrameElementOf(kf: KeyFrameJson, elementName: string): KeyFrameElementJson | undefined {
  // A JSON-null entry deserializes to null in the engine and is skipped there too.
  return kf.elements?.[elementName] ?? undefined;
}

/**
 * Port of Animation.seekRightKeyFrame: first keyframe (array order) with the channel set
 * for the element AND frame strictly greater than `aboveFrameNumber`; when none is greater,
 * the first set one (wraparound); −1 when the element/channel is keyed nowhere.
 */
function seekRightKeyFrame(
  keyframes: readonly KeyFrameJson[],
  aboveFrameNumber: number,
  elementName: string,
  flag: ChannelFlag,
): number {
  let firstSet = -1;
  for (let i = 0; i < keyframes.length; i++) {
    const kf = keyframes[i]!;
    const kfe = keyFrameElementOf(kf, elementName);
    if (kfe !== undefined && channelIsSet(kfe, flag)) {
      if (firstSet === -1) firstSet = i;
      if (reqNum(kf.frame) > aboveFrameNumber) return i;
    }
  }
  return firstSet;
}

/**
 * Port of Animation.seekLeftKeyFrame: nearest set keyframe scanning backwards from
 * `leftOfKeyFrameIndex` (wrapping). The scan covers all indices including
 * `leftOfKeyFrameIndex` itself, so a single set keyframe resolves to left == right.
 */
function seekLeftKeyFrame(
  keyframes: readonly KeyFrameJson[],
  leftOfKeyFrameIndex: number,
  elementName: string,
  flag: ChannelFlag,
): number {
  for (let i = 0; i < keyframes.length; i++) {
    const idx = mod(leftOfKeyFrameIndex - i - 1, keyframes.length);
    const kfe = keyFrameElementOf(keyframes[idx]!, elementName);
    if (kfe !== undefined && channelIsSet(kfe, flag)) return idx;
  }
  return -1;
}

/**
 * Port of Animation.getTwoKeyFramesElementForFlag, returning keyframe indices
 * (the engine compares the two by reference; index equality is the same predicate).
 * Returns null when the element/channel is not keyed anywhere.
 */
function getTwoKeyFrameIndicesForFlag(
  keyframes: readonly KeyFrameJson[],
  frameNumber: number,
  elementName: string,
  flag: ChannelFlag,
): { leftIdx: number; rightIdx: number } | null {
  const rightIdx = seekRightKeyFrame(keyframes, frameNumber, elementName, flag);
  if (rightIdx === -1) return null;
  const leftIdx = seekLeftKeyFrame(keyframes, rightIdx, elementName, flag);
  // leftIdx === -1 is unreachable when rightIdx !== -1 (the backward scan covers every
  // index including rightIdx); kept for engine parity.
  return { leftIdx: leftIdx === -1 ? rightIdx : leftIdx, rightIdx };
}

/**
 * Port of Animation.lerpKeyFrameElement for one channel. The engine dereferences all three
 * `.Value`s of both keyframe elements — a partial channel triple NPEs there, so we throw a
 * named error instead of silently guessing.
 */
function lerpChannelInto(
  pose: PoseTf,
  flag: ChannelFlag,
  leftKf: KeyFrameJson,
  rightKf: KeyFrameJson,
  t: number,
  elementName: string,
  animCode: string,
): void {
  const fields = CHANNEL_FIELDS[flag];
  const read = (kf: KeyFrameJson): [number, number, number] => {
    const kfe = keyFrameElementOf(kf, elementName)!;
    const vals = fields.map((f) => optNum(kfe[f]));
    const missing = fields.filter((_, i) => vals[i] === undefined);
    if (missing.length > 0) {
      throw new Error(
        `Keyframe at frame ${reqNum(kf.frame)} of animation '${animCode}' sets a partial ` +
          `${CHANNEL_NAMES[flag]} channel for element '${elementName}' (missing ` +
          `${missing.join(', ')}); the engine crashes on partial channel triples — ` +
          `set all three ${CHANNEL_NAMES[flag]} components (neutral value is ` +
          `${flag === 2 ? '1' : '0'}) or remove the set one(s) from this keyframe.`,
      );
    }
    return vals as [number, number, number];
  };
  const [lx, ly, lz] = read(leftKf);
  const [rx, ry, rz] = read(rightKf);
  switch (flag) {
    case 0:
      // Offsets are authored in 1/16-block units; the engine lerps the /16 values.
      pose.translateX = lerp(lx / 16, rx / 16, t);
      pose.translateY = lerp(ly / 16, ry / 16, t);
      pose.translateZ = lerp(lz / 16, rz / 16, t);
      break;
    case 1: {
      // rotShortestDistanceX/Y/Z: GenerateFrameForElement copies the flags from the LEFT
      // keyframe onto the generated pose (API:143661-143663), and the runtime lerp
      // (ElementPose.Add, API:146322) then takes the shortest angular path for each
      // flagged axis — for single animations too: deg = left + AngleDegDistance(l, r)·t.
      // Continuous rotators (gencore, gengearbox, hurdygurdy …) depend on this at the
      // cycle wrap. See the module header for the (narrow) inner-segment caveat.
      const flags = keyFrameElementOf(leftKf, elementName)!;
      pose.degX =
        flags.rotShortestDistanceX === true ? lx + angleDegDistance(lx, rx) * t : lerp(lx, rx, t);
      pose.degY =
        flags.rotShortestDistanceY === true ? ly + angleDegDistance(ly, ry) * t : lerp(ly, ry, t);
      pose.degZ =
        flags.rotShortestDistanceZ === true ? lz + angleDegDistance(lz, rz) * t : lerp(lz, rz, t);
      break;
    }
    case 2:
      pose.scaleX = lerp(lx, rx, t);
      pose.scaleY = lerp(ly, ry, t);
      pose.scaleZ = lerp(lz, rz, t);
      break;
  }
}

/**
 * Exact port of Animation.GenerateFrameForElement (VintagestoryAPI.decompiled.cs:143638)
 * evaluated for every element named in any keyframe, generalized to fractional frames
 * (see module header for the generalization contract and the exact-at-keyframe behavior).
 *
 * Returns a pose per keyframed element; elements never named in a keyframe are absent
 * (callers use the identity pose for those). Channels not keyed for an element stay at
 * their identity values (translate 0, deg 0, scale 1) — channels are fully independent.
 *
 * Engine-load invariants are enforced here because the engine enforces them at load:
 * the animation must have at least one keyframe, and quantityframes must be strictly
 * greater than every keyframe frame.
 *
 * rotShortestDistanceX/Y/Z on the LEFT keyframe of a rotation segment switch that axis to
 * the engine's shortest-angular-path lerp (ElementPose.Add, API:146322) — this applies to
 * single-animation playback, not just cross-animation blending. onAnimationEnd 'Hold'
 * clamps frames in [quantityframes−1, quantityframes) to the last keyframe's generated
 * pose (API:146147). Both are handled here; see the module header.
 */
export function interpolatePose(anim: AnimationJson, frame: number): Map<string, PoseTf> {
  const code = animCodeOf(anim);
  if (!Number.isFinite(frame)) {
    throw new Error(
      `interpolatePose: frame must be a finite number, got ${frame} ` +
        `(animation '${code}'). Pass a frame in [0, quantityframes).`,
    );
  }
  const quantityFrames = reqNum(anim.quantityframes);
  const keyframes = anim.keyframes ?? [];
  if (keyframes.length === 0) {
    throw new Error(
      `Animation '${code}' has no keyframes; the engine refuses to load it. ` +
        `Add at least one keyframe (frame 0 is conventional).`,
    );
  }
  let maxKeyframeFrame = -Infinity;
  for (const kf of keyframes) {
    const f = reqNum(kf.frame);
    if (f > maxKeyframeFrame) maxKeyframeFrame = f;
    if (f >= quantityFrames) {
      throw new Error(
        `Animation '${code}' has quantityframes ${quantityFrames} but a keyframe at frame ` +
          `${f}; the engine requires quantityframes to be strictly greater than every ` +
          `keyframe frame — raise quantityframes to at least ${f + 1} or move the keyframe.`,
      );
    }
  }
  // Cyclic extension for out-of-domain inputs; identity for the engine's 0..q−1 domain.
  let frameNumber = mod(frame, quantityFrames);

  // Hold end-clamp (ClientAnimator.calculateMatrices, API:146147): when onAnimationEnd is
  // Hold and (int)frame + 1 == quantityframes, the engine replaces the 'next' generated
  // frame with 'prev' — and RunningAnimation parks CurrentFrame at quantityframes − 1
  // (API:147168) — so the held resting pose is the LAST keyframe's generated frame, not a
  // wrap-lerp toward frame 0. Reproduce by evaluating at the last keyframe frame.
  if (
    Math.floor(frameNumber) === quantityFrames - 1 &&
    typeof anim.onAnimationEnd === 'string' &&
    /^hold$/i.test(anim.onAnimationEnd.trim())
  ) {
    frameNumber = maxKeyframeFrame;
  }

  const elementNames = new Set<string>();
  for (const kf of keyframes) {
    for (const name of Object.keys(kf.elements ?? {})) elementNames.add(name);
  }

  const poses = new Map<string, PoseTf>();
  for (const name of elementNames) {
    const pose: PoseTf = { ...IDENTITY_POSE };
    for (const flag of [0, 1, 2] as const) {
      const found = getTwoKeyFrameIndicesForFlag(keyframes, frameNumber, name, flag);
      if (found === null) continue;
      const { leftIdx, rightIdx } = found;
      const leftFrame = reqNum(keyframes[leftIdx]!.frame);
      const rightFrame = reqNum(keyframes[rightIdx]!.frame);
      let t: number;
      if (leftIdx === rightIdx) {
        // Single set keyframe for this channel: constant value across the whole cycle.
        t = 0;
      } else if (rightFrame < leftFrame) {
        // Wraparound across the cycle end.
        const span = rightFrame + (quantityFrames - leftFrame);
        t = mod(frameNumber - leftFrame, quantityFrames) / span;
      } else {
        t = (frameNumber - leftFrame) / (rightFrame - leftFrame);
      }
      lerpChannelInto(pose, flag, keyframes[leftIdx]!, keyframes[rightIdx]!, t, name, code);
    }
    poses.set(name, pose);
  }
  return poses;
}

// ---------------------------------------------------------------------------
// Posed world-space geometry
// ---------------------------------------------------------------------------

export interface PoseOpts {
  /** Animation code (anim.code ?? anim.name). Omit for the static pose. */
  anim?: string;
  /** Frame (may be fractional); requires `anim`. Defaults to 0 when `anim` is given. */
  frame?: number;
}

function findAnimation(doc: ShapeJson, code: string): AnimationJson {
  const anims = doc.animations ?? [];
  const found = anims.find((a) => animCodeOf(a) === code);
  if (found === undefined) {
    const codes = anims.map(animCodeOf);
    throw new Error(
      `Animation '${code}' not found in the shape; ` +
        (codes.length > 0
          ? `available animation codes: ${codes.join(', ')}.`
          : `the shape has no animations.`),
    );
  }
  return found;
}

/** Resolves PoseOpts into the per-element poses + the animation version (0 unless exactly 1). */
function resolvePose(
  doc: ShapeJson,
  opts: PoseOpts,
): { poses: Map<string, PoseTf>; animVersion: 0 | 1 } {
  if (opts.anim === undefined) {
    if (opts.frame !== undefined) {
      throw new Error(
        `A frame (${opts.frame}) was given without an animation; pass 'anim' as well, ` +
          `or omit 'frame' for the static pose.`,
      );
    }
    return { poses: new Map(), animVersion: 0 };
  }
  const anim = findAnimation(doc, opts.anim);
  // The engine treats Version == 1 specially and everything else as version 0.
  const animVersion = reqNum(anim.version) === 1 ? 1 : 0;
  return { poses: interpolatePose(anim, opts.frame ?? 0), animVersion };
}

function elementView(el: ElementJson): ElementTransformView {
  return {
    from: [el.from[0].value, el.from[1].value, el.from[2].value],
    rotationOrigin: el.rotationOrigin
      ? [el.rotationOrigin[0].value, el.rotationOrigin[1].value, el.rotationOrigin[2].value]
      : undefined,
    rotationX: optNum(el.rotationX),
    rotationY: optNum(el.rotationY),
    rotationZ: optNum(el.rotationZ),
    scaleX: optNum(el.scaleX),
    scaleY: optNum(el.scaleY),
    scaleZ: optNum(el.scaleZ),
  };
}

/** Element-local box size in blocks: (to − from)/16 per axis (GROUND-TRUTH §2). */
function boxSize(el: ElementJson): Vec3 {
  return [
    (el.to[0].value - el.from[0].value) / 16,
    (el.to[1].value - el.from[1].value) / 16,
    (el.to[2].value - el.from[2].value) / 16,
  ];
}

/** Depth-first walk computing world = parent · local per element (Animation.GenerateFrame). */
function walkWorld(
  doc: ShapeJson,
  poses: Map<string, PoseTf>,
  animVersion: 0 | 1,
  visit: (el: ElementJson, world: Mat4) => void,
): void {
  // Duplicate-name semantics: Shape.CollectElements registers elements by name with
  // overwrite semantics (pre-order, last wins — API:148028) and keyframes resolve to that
  // single ShapeElement reference (AnimationKeyFrame.Resolve, API:144000), so when names
  // are duplicated (invalid — the validator errors on shape/dup-name) only the pre-order
  // LAST instance is animated in-game; the others stay at the identity pose. Mirror that
  // by resolving each keyed name to its winning instance first.
  const winner = new Map<string, ElementJson>();
  if (poses.size > 0) {
    const collect = (elements: readonly ElementJson[]): void => {
      for (const el of elements) {
        if (poses.has(el.name)) winner.set(el.name, el);
        if (el.children) collect(el.children);
      }
    };
    collect(doc.elements ?? []);
  }
  const recurse = (elements: readonly ElementJson[], parent: Mat4): void => {
    for (const el of elements) {
      const local = localTransformMatrix(
        elementView(el),
        animVersion,
        winner.get(el.name) === el ? poses.get(el.name)! : IDENTITY_POSE,
      );
      const world = mat4Mul(new Float64Array(parent), local);
      visit(el, world);
      if (el.children) recurse(el.children, world);
    }
  };
  recurse(doc.elements ?? [], mat4Create());
}

/**
 * World matrix per element: recursive `world = parent · localTransformMatrix(el, pose)`
 * with poses from {@link interpolatePose} (identity for unkeyed elements / static pose).
 *
 * Keyed by element name; duplicate names (invalid — the validator errors on them) collide
 * last-wins here, which matches the engine: only the pre-order-LAST instance of a
 * duplicated name receives keyframe poses (see walkWorld), and its matrix is the one
 * stored under the name.
 */
export function elementMatrices(doc: ShapeDocLike, opts: PoseOpts = {}): Map<string, Mat4> {
  const root = rootOf(doc);
  const { poses, animVersion } = resolvePose(root, opts);
  const out = new Map<string, Mat4>();
  walkWorld(root, poses, animVersion, (el, world) => out.set(el.name, world));
  return out;
}

/**
 * Per-face local corner multipliers of the box size, in the engine's emission order
 * (docs/ground-truth/tesselator.md §3, parsed from CubeMeshUtil.CubeVertices API:52335).
 * Vertex j receives UV cycle index (rotation/90 + j) mod 4. Winding is counter-clockwise
 * viewed from outside the box.
 */
const FACE_CORNERS: Record<FaceName, readonly [Vec3, Vec3, Vec3, Vec3]> = {
  north: [
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [1, 0, 0],
  ],
  east: [
    [1, 0, 0],
    [1, 1, 0],
    [1, 1, 1],
    [1, 0, 1],
  ],
  south: [
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
    [0, 0, 1],
  ],
  west: [
    [0, 0, 1],
    [0, 1, 1],
    [0, 1, 0],
    [0, 0, 0],
  ],
  up: [
    [1, 1, 1],
    [1, 1, 0],
    [0, 1, 0],
    [0, 1, 1],
  ],
  down: [
    [0, 0, 1],
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
  ],
};

/**
 * UV rect for a face, falling back to the engine's auto-UV `[0, 0, w, h]` when `uv` is
 * absent (tesselator.md §4: up/down → (sizeX, sizeZ)·16, east/west → (sizeZ, sizeY)·16,
 * north/south → (sizeX, sizeY)·16). Returns null for a malformed uv array (length ≠ 4),
 * which the engine warns about and skips.
 */
function faceUvRect(
  face: FaceJson,
  facing: FaceName,
  size: Vec3,
): [number, number, number, number] | null {
  const uv = face.uv as VsNum[] | undefined;
  if (uv === undefined) {
    const [sx, sy, sz] = size;
    switch (facing) {
      case 'up':
      case 'down':
        return [0, 0, sx * 16, sz * 16];
      case 'east':
      case 'west':
        return [0, 0, sz * 16, sy * 16];
      default:
        return [0, 0, sx * 16, sy * 16];
    }
  }
  if (uv.length !== 4) return null;
  return [uv[0]!.value, uv[1]!.value, uv[2]!.value, uv[3]!.value];
}

/** Outward unit normal per facing in element-local space (BlockFacing normals, API:8600). */
const FACE_NORMALS: Readonly<Record<FaceName, Vec3>> = {
  north: [0, 0, -1],
  east: [1, 0, 0],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  up: [0, 1, 0],
  down: [0, -1, 0],
};

/** Transform a direction by the world matrix (rotation/scale block, no translation), normalized. */
function worldDirection(world: Mat4, d: Vec3): Vec3 {
  const x = world[0]! * d[0] + world[4]! * d[1] + world[8]! * d[2];
  const y = world[1]! * d[0] + world[5]! * d[1] + world[9]! * d[2];
  const z = world[2]! * d[0] + world[6]! * d[1] + world[10]! * d[2];
  const len = Math.hypot(x, y, z);
  return len > 0 ? [x / len, y / len, z / len] : [d[0], d[1], d[2]];
}

/**
 * Engine: r = (int)(rotation / 90) used as a (+ vertexIndex) % 4 cycle offset
 * (Lib:155051/:155113). Negative rotations underflow the engine's UV table (crash /
 * garbage — tesselator.md §4 treats them as invalid; the validator flags them); here they
 * are normalized cyclically so posedFaces stays total.
 */
function normalizeUvRotation(rotation: VsNum | undefined): 0 | 90 | 180 | 270 {
  const r = Math.trunc(reqNum(rotation) / 90);
  return ((((r % 4) + 4) % 4) * 90) as 0 | 90 | 180 | 270;
}

/**
 * All visible faces as world-space quads (winding CCW viewed from outside, per the
 * RenderFace contract). Per tesselator.md §2–§4:
 * - faces absent from the element or with `enabled: false` are skipped (dropped at load);
 * - an element whose size is zero on all three axes emits no faces (zero on one or two
 *   axes still emits all six);
 * - elements without faces still contribute their matrix to children;
 * - corners are the local box [0, (to−from)/16] transformed by the element world matrix;
 * - `texture` has its leading '#' stripped; missing `uv` gets the engine auto-UV;
 * - `normal` is the world-space shading normal (tesselator.md §6a, Lib:155064-155076):
 *   the face normal — or the element-up normal for `shade: false`, or the flat
 *   `normalize(0.5·up + face)` approximation of the per-vertex gradientShade mix —
 *   transformed by the element world matrix and normalized.
 */
export function posedFaces(doc: ShapeDocLike, opts: PoseOpts = {}): RenderFace[] {
  const root = rootOf(doc);
  const { poses, animVersion } = resolvePose(root, opts);
  const faces: RenderFace[] = [];
  walkWorld(root, poses, animVersion, (el, world) => {
    const size = boxSize(el);
    const [sx, sy, sz] = size;
    if (sx === 0 && sy === 0 && sz === 0) return;
    for (const facing of FACE_NAMES) {
      const face = el.faces?.[facing];
      if (face === undefined || face.enabled === false) continue;
      const uvRect = faceUvRect(face, facing, size);
      if (uvRect === null) continue;
      const corners = FACE_CORNERS[facing];
      const positions = corners.map((c) =>
        mat4TransformVec3(world, [c[0] * sx, c[1] * sy, c[2] * sz]),
      ) as [Vec3, Vec3, Vec3, Vec3];
      // Shading normal (tesselator.md §6a): shade:false packs the element UP normal
      // (Lib:155072-155076); gradientShade mixes per vertex (upper half = up, lower half
      // = normalize(0.5·up + face), API:56997-57026) — approximated flat per face here.
      const fn = FACE_NORMALS[facing];
      const localNormal: Vec3 =
        el.shade === false
          ? [0, 1, 0]
          : el.gradientShade === true
            ? [fn[0], fn[1] + 0.5, fn[2]]
            : fn;
      const renderFace: RenderFace = {
        positions,
        uvRect,
        uvRotation: normalizeUvRotation(face.rotation),
        textureKey: face.texture.startsWith('#') ? face.texture.slice(1) : face.texture,
        facing,
        normal: worldDirection(world, localNormal),
      };
      const glow = optNum(face.glow);
      if (glow !== undefined) renderFace.glow = glow;
      faces.push(renderFace);
    }
  });
  return faces;
}

export interface BoundsOpts {
  /** Animation code; omit for the static pose. */
  anim?: string;
  /** Frames (may be fractional) to union over; defaults to [0] when `anim` is given. */
  frames?: number[];
}

/**
 * World AABB of the posed visible geometry (the corners of every emitted face — i.e. of
 * {@link posedFaces}), in blocks, unioned across `frames` when given. Throws when the
 * shape emits no faces at all (the bounds of nothing are undefined).
 */
export function modelBounds(doc: ShapeDocLike, opts: BoundsOpts = {}): { min: Vec3; max: Vec3 } {
  const root = rootOf(doc);
  const frames: (number | undefined)[] =
    opts.anim === undefined ? [undefined] : opts.frames?.length ? opts.frames : [0];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const frame of frames) {
    const poseOpts: PoseOpts =
      opts.anim === undefined ? {} : { anim: opts.anim, frame: frame ?? 0 };
    for (const face of posedFaces(root, poseOpts)) {
      any = true;
      for (const p of face.positions) {
        for (let axis = 0; axis < 3; axis++) {
          if (p[axis]! < min[axis]!) min[axis] = p[axis]!;
          if (p[axis]! > max[axis]!) max[axis] = p[axis]!;
        }
      }
    }
  }
  if (!any) {
    throw new Error(
      `modelBounds: the shape emits no faces` +
        ((root.elements ?? []).length === 0
          ? ` (it has no elements). Add at least one element.`
          : ` (every element has no enabled faces or is zero-size on all axes). ` +
            `Enable at least one face.`),
    );
  }
  return { min, max };
}

export interface FootContactFrame {
  frame: number;
  /** Element name → world position (blocks) of the element's bottom-center point. */
  positions: Record<string, Vec3>;
}

/**
 * For every integer frame 0..quantityframes−1 of the animation, the world position of each
 * listed element's bottom-center local point — center of the box in x/z at y = 0, i.e.
 * ((to−from)/32, 0, (to−from)/32) in blocks. Feeds the foot-slide validator.
 */
export function footContacts(
  doc: ShapeDocLike,
  animCode: string,
  opts: { elements: string[] },
): FootContactFrame[] {
  const root = rootOf(doc);
  const anim = findAnimation(root, animCode);
  const quantityFrames = reqNum(anim.quantityframes);

  const byName = new Map<string, ElementJson>();
  const collect = (els: readonly ElementJson[]): void => {
    for (const el of els) {
      byName.set(el.name, el);
      if (el.children) collect(el.children);
    }
  };
  collect(root.elements ?? []);

  for (const name of opts.elements) {
    if (!byName.has(name)) {
      throw new Error(
        `footContacts: element '${name}' does not exist in the shape; ` +
          `known elements: ${[...byName.keys()].join(', ')}.`,
      );
    }
  }

  const result: FootContactFrame[] = [];
  for (let frame = 0; frame < quantityFrames; frame++) {
    const mats = elementMatrices(root, { anim: animCode, frame });
    const positions: Record<string, Vec3> = {};
    for (const name of opts.elements) {
      const el = byName.get(name)!;
      const [sx, , sz] = boxSize(el);
      // World matrix is present for every element in the tree; byName guaranteed it exists.
      positions[name] = mat4TransformVec3(mats.get(name)!, [sx / 2, 0, sz / 2]);
    }
    result.push({ frame, positions });
  }
  return result;
}
