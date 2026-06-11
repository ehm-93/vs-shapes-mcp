/**
 * Shared data model for Vintage Story shape JSON.
 *
 * The parsed tree mirrors the file exactly: key order is preserved (JS object insertion
 * order), unknown keys are kept untouched, and every number is a {@link VsNum} wrapper that
 * remembers the original literal so an unedited file re-serializes byte-identically.
 *
 * Interfaces below declare the *known* fields (casing as observed in vanilla files —
 * note `quantityframes` is all-lowercase there); runtime objects may carry extra keys,
 * which all code must preserve. See docs/GROUND-TRUTH.md for the semantics.
 */

/** A JSON number that remembers its source literal until the value is changed. */
export class VsNum {
  /**
   * @param value numeric value
   * @param raw   the exact literal from the source file; undefined for fresh/edited numbers,
   *              in which case the serializer formats per field convention
   */
  constructor(
    public value: number,
    public raw?: string,
  ) {}

  toJSON(): number {
    return this.value;
  }
}

export type JsonValue = VsNum | string | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** [x, y, z] in the JSON tree. Units: 1/16 block for geometry fields. */
export type Vec3Json = [VsNum, VsNum, VsNum];
/** [u1, v1, u2, v2] in shape UV units. */
export type UvRectJson = [VsNum, VsNum, VsNum, VsNum];

export type FaceName = 'north' | 'east' | 'south' | 'west' | 'up' | 'down';
export const FACE_NAMES: readonly FaceName[] = ['north', 'east', 'south', 'west', 'up', 'down'];

export interface FaceJson {
  texture: string; // '#key' reference into ShapeJson.textures
  uv: UvRectJson;
  rotation?: VsNum; // 0 | 90 | 180 | 270
  glow?: VsNum;
  enabled?: boolean;
  reflectiveMode?: VsNum;
  windMode?: JsonValue;
  windData?: JsonValue;
}

export interface ElementJson {
  name: string;
  from: Vec3Json;
  to: Vec3Json;
  rotationOrigin?: Vec3Json;
  rotationX?: VsNum;
  rotationY?: VsNum;
  rotationZ?: VsNum;
  scaleX?: VsNum;
  scaleY?: VsNum;
  scaleZ?: VsNum;
  uv?: [VsNum, VsNum]; // editor auto-UV hint (top-left), not used by the engine
  unwrapMode?: VsNum; // editor hint
  unwrapRotation?: VsNum; // editor hint
  /**
   * Attach-time overlay mechanism (Shape.StepParentShape, API:147876): when this shape is
   * overlaid onto a parent shape, the element is re-parented under the parent shape's
   * element of this name. Never applies to a standalone shape — fk/render intentionally
   * ignore it (the validator emits a shape/step-parent note for awareness).
   */
  stepParentName?: string;
  /** false: the engine packs the element-up normal instead of the face normal (tesselator.md §6a). */
  shade?: boolean;
  /** Per-vertex up/face normal mix (tesselator.md §6a); render approximates it per face. */
  gradientShade?: boolean;
  faces?: Partial<Record<FaceName, FaceJson>>;
  children?: ElementJson[];
  attachmentpoints?: JsonObject[];
}

export interface KeyFrameElementJson {
  offsetX?: VsNum;
  offsetY?: VsNum;
  offsetZ?: VsNum;
  rotationX?: VsNum;
  rotationY?: VsNum;
  rotationZ?: VsNum;
  stretchX?: VsNum;
  stretchY?: VsNum;
  stretchZ?: VsNum;
  originX?: VsNum; // parsed by the engine but unused in frame generation
  originY?: VsNum;
  originZ?: VsNum;
  rotShortestDistanceX?: boolean;
  rotShortestDistanceY?: boolean;
  rotShortestDistanceZ?: boolean;
}

export interface KeyFrameJson {
  frame: VsNum;
  elements: { [elementName: string]: KeyFrameElementJson };
}

export interface AnimationJson {
  name: string;
  code?: string; // defaults to name when absent
  version?: VsNum; // selects local-transform composition, see GROUND-TRUTH §2
  quantityframes: VsNum; // must be > every keyframe frame
  onActivityStopped?: string; // e.g. 'EaseOut', 'Rewind', 'Stop', 'PlayTillEnd'
  onAnimationEnd?: string; // e.g. 'Repeat', 'Hold', 'Stop', 'EaseOut'
  easeAnimationSpeed?: boolean;
  keyframes: KeyFrameJson[];
}

export interface ShapeJson {
  editor?: JsonObject;
  textureWidth?: VsNum; // default 16 when absent
  textureHeight?: VsNum;
  textureSizes?: { [textureKey: string]: [VsNum, VsNum] };
  textures?: { [textureKey: string]: string }; // key → asset path like 'entity/animal/mammal/fox/red-male'
  elements: ElementJson[];
  animations?: AnimationJson[];
}

// ---------------------------------------------------------------------------
// Plain-number mirrors, used by query results, fk, render, and validators.
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number];

export interface PoseTf {
  translateX: number; // blocks (already /16)
  translateY: number;
  translateZ: number;
  degX: number;
  degY: number;
  degZ: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
}

export const IDENTITY_POSE: Readonly<PoseTf> = Object.freeze({
  translateX: 0,
  translateY: 0,
  translateZ: 0,
  degX: 0,
  degY: 0,
  degZ: 0,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
});

/** A posed, world-space face ready for rasterization. */
export interface RenderFace {
  /** World-space quad in blocks; counter-clockwise when viewed from outside (facing dir). */
  positions: [Vec3, Vec3, Vec3, Vec3];
  /** [u1, v1, u2, v2] in shape UV units. */
  uvRect: [number, number, number, number];
  uvRotation: 0 | 90 | 180 | 270;
  /** Texture key without the '#'. */
  textureKey: string;
  facing: FaceName;
  /**
   * World-space unit shading normal (tesselator.md §6a): the face normal rotated by the
   * element world matrix; element-up for shade:false; an up/face mix for gradientShade.
   */
  normal: Vec3;
  glow?: number;
}

export interface Finding {
  severity: 'error' | 'warn' | 'note';
  code: string;
  message: string;
  element?: string;
  animation?: string;
  frame?: number;
  /** The feasible fix, when computable. Errors are the product. */
  fix?: string;
}

export const num = (v: VsNum | undefined, fallback = 0): number => (v ? v.value : fallback);
export const vec3 = (v: Vec3Json | undefined): Vec3 | undefined =>
  v ? [v[0].value, v[1].value, v[2].value] : undefined;
