/**
 * The `doc_script` API surface: builds the sandbox globals bound to one {@link ShapeDocument}
 * and runs a script against them (ARCHITECTURE.md §script). Every function here is a thin
 * wrapper over the SAME typed ops the individual MCP tools call (vs/elements, vs/animation,
 * vs/uv) plus the shared RFC-6902 engine (vs/jsonpatch) — so a script and a sequence of tool
 * calls produce identical results and identical errors.
 *
 * The whole script runs inside ONE doc.transact (the caller wraps it), so it is a single
 * undoable unit and an uncaught error rolls every mutation back. Mutations the script
 * *catches* and recovers from stand, exactly like a normal program.
 *
 * Values cross the boundary as plain JSON: scripts pass plain numbers/arrays/objects to the
 * ops (which wrap them losslessly), and the read helpers return plain snapshots — never the
 * live VsNum tree — so a script can never reach into document internals.
 */

import {
  adjustChannel,
  animCodeOf,
  createAnimation,
  deleteAnimation,
  deleteKeyframe,
  editAnimationMeta,
  mirrorPhase,
  retimeAnimation,
  setKeyframe,
} from '../vs/animation.js';
import { ShapeDocument } from '../vs/document.js';
import {
  addElement,
  deleteElement,
  duplicateElement,
  editElement,
  listElementNames,
  mirrorElement,
  renameElement,
  reparentElement,
  scaleElement,
} from '../vs/elements.js';
import { modelBounds } from '../vs/fk.js';
import { applyPatch, getAt, toPlain, type PatchOpInput } from '../vs/jsonpatch.js';
import {
  vec3 as vec3Of,
  type AnimationJson,
  type ElementJson,
  type FaceName,
  type JsonValue,
  type Vec3,
} from '../vs/types.js';
import { autoUv, setFaceProps, setFaceUv, uvReport } from '../vs/uv.js';
import { runScript, type ScriptLimits } from './interp.js';

export interface RunDocScriptOpts {
  /** JSON value exposed to the script as the global `args`. */
  args?: unknown;
  /** Seed for the script's `random()`/`randInt()` (deterministic). Default 0. */
  seed?: number;
  /** Interpreter budgets (steps, depth, source length). */
  limits?: ScriptLimits;
  /** Max op (mutating-API) calls before aborting. Default 200,000. */
  maxOps?: number;
  /** Max `log()` lines retained. Default 1,000. */
  maxLog?: number;
}

export interface RunDocScriptResult {
  /** The script's top-level `return` value (plain JSON), or null. */
  returned: unknown;
  /** Captured `log()` lines (capped). */
  log: string[];
  /** Count of mutating-API calls the script made. */
  ops: number;
  /** Element count after the script ran. */
  elements: number;
}

const DEFAULT_MAX_OPS = 200_000;
const DEFAULT_MAX_LOG = 1_000;

/** Deterministic 32-bit RNG (mulberry32) → floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A shallow, plain snapshot of an element (geometry + child/face NAMES, no live nodes). */
function plainNode(el: ElementJson, parent: string | null, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: el.name,
    from: vec3Of(el.from),
    to: vec3Of(el.to),
    parent,
    depth,
  };
  if (el.rotationOrigin) out['rotationOrigin'] = vec3Of(el.rotationOrigin);
  if (el.rotationX) out['rotationX'] = el.rotationX.value;
  if (el.rotationY) out['rotationY'] = el.rotationY.value;
  if (el.rotationZ) out['rotationZ'] = el.rotationZ.value;
  out['faces'] = Object.keys(el.faces ?? {});
  out['children'] = (el.children ?? []).map((c) => c.name);
  return out;
}

function animSnapshot(a: AnimationJson): Record<string, unknown> {
  return {
    code: animCodeOf(a),
    name: a.name,
    quantityFrames: a.quantityframes?.value ?? null,
    keyframes: a.keyframes?.length ?? 0,
    onAnimationEnd: a.onAnimationEnd ?? null,
  };
}

/**
 * Build the sandbox globals (the document API + helpers) for `doc`, run `source`, and
 * return a plain result. Intended to be called inside a doc.transact by the caller.
 */
export function runDocScript(
  doc: ShapeDocument,
  source: string,
  opts: RunDocScriptOpts = {},
): RunDocScriptResult {
  const maxOps = opts.maxOps ?? DEFAULT_MAX_OPS;
  const maxLog = opts.maxLog ?? DEFAULT_MAX_LOG;
  const log: string[] = [];
  let logTruncated = false;
  let ops = 0;

  /** Count one mutating op; abort if the script blows the op budget. */
  const op = (): void => {
    if (++ops > maxOps) {
      throw new Error(`doc_script exceeded the ${maxOps.toLocaleString('en-US')}-operation budget`);
    }
  };

  const rng = mulberry32((opts.seed ?? 0) | 0);
  const random = (): number => rng();
  const randInt = (min: unknown, max: unknown): number => {
    const lo = Math.ceil(Number(min));
    const hi = Math.floor(Number(max));
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) {
      throw new Error(`randInt(min, max): need finite min ≤ max, got ${String(min)}, ${String(max)}`);
    }
    return lo + Math.floor(rng() * (hi - lo + 1));
  };

  const globals: Record<string, unknown> = {
    args: opts.args ?? null,
    random,
    randInt,
    log: (...parts: unknown[]): void => {
      if (log.length >= maxLog) {
        logTruncated = true;
        return;
      }
      log.push(parts.map((p) => (typeof p === 'string' ? p : safeJson(p))).join(' '));
    },

    // --- geometry ---------------------------------------------------------------------
    addElement: (o: Record<string, unknown>): string => {
      op();
      return addElement(doc, o as never).name;
    },
    editElement: (name: string, patch: Record<string, unknown>): string => {
      op();
      return editElement(doc, name, patch as never).name;
    },
    renameElement: (oldName: string, newName: string): Record<string, unknown> => {
      op();
      return { ...renameElement(doc, oldName, newName) };
    },
    reparentElement: (name: string, newParent: string | null, o?: Record<string, unknown>): Record<string, unknown> => {
      op();
      return { ...reparentElement(doc, name, newParent, (o ?? {}) as never) };
    },
    mirrorElement: (name: string, axis: 'x' | 'z', o?: Record<string, unknown>): Record<string, string> => {
      op();
      return mirrorElement(doc, name, axis, (o ?? {}) as never);
    },
    scaleElement: (name: string | null, factor: number | Vec3, anchor?: Vec3): void => {
      op();
      scaleElement(doc, name, factor, (anchor ?? [0, 0, 0]) as Vec3);
    },
    duplicateElement: (name: string, newName?: string): Record<string, string> => {
      op();
      return duplicateElement(doc, name, newName);
    },
    deleteElement: (name: string, o?: Record<string, unknown>): Record<string, unknown> => {
      op();
      return { ...deleteElement(doc, name, (o ?? {}) as never) };
    },

    // --- queries (read-only, no op budget) --------------------------------------------
    getElement: (name: string): Record<string, unknown> | undefined => {
      const el = doc.getElement(name);
      return el === undefined ? undefined : plainNode(el, doc.parentOf(name)?.name ?? null, 0);
    },
    elementNames: (): string[] => listElementNames(doc),
    count: (): number => listElementNames(doc).length,
    walk: (cb: (node: Record<string, unknown>, path: string[]) => void): void => {
      // Snapshot first so a callback that mutates the tree can't corrupt the iteration.
      const nodes: { node: Record<string, unknown>; path: string[] }[] = [];
      doc.walk((el, path) => {
        nodes.push({
          node: plainNode(el, path.length ? path[path.length - 1]!.name : null, path.length),
          path: path.map((p) => p.name),
        });
      });
      for (const { node, path } of nodes) cb(node, path);
    },
    bounds: (o?: { anim?: string; frame?: number }): { min: Vec3; max: Vec3 } => {
      const bo = o?.anim !== undefined ? { anim: o.anim, frames: [o.frame ?? 0] } : {};
      return modelBounds(doc, bo);
    },
    listAnimations: (): Record<string, unknown>[] => doc.listAnimations().map(animSnapshot),
    getAnimation: (code: string): Record<string, unknown> | undefined => {
      const a = doc.getAnimation(code);
      return a === undefined ? undefined : animSnapshot(a);
    },

    // --- UV ----------------------------------------------------------------------------
    setFaceUv: (element: string, face: FaceName, uv: [number, number, number, number], rotation?: number): void => {
      op();
      setFaceUv(doc, element, face, uv, rotation);
    },
    faceSet: (o: Record<string, unknown>): number => {
      op();
      const elements = o['elements'] as string[];
      const props = {
        ...(o['texture'] !== undefined ? { texture: o['texture'] as string } : {}),
        ...(o['glow'] !== undefined ? { glow: o['glow'] as number | null } : {}),
        ...(o['enabled'] !== undefined ? { enabled: o['enabled'] as boolean | null } : {}),
      };
      const facesOpt = {
        ...(o['faces'] !== undefined ? { faces: o['faces'] as FaceName[] } : {}),
        ...(o['subtree'] !== undefined ? { subtree: o['subtree'] as boolean } : {}),
      };
      return setFaceProps(doc, elements, props, facesOpt).facesUpdated;
    },
    autoUv: (elements?: string[]): number => {
      op();
      return autoUv(doc, elements).faces.length;
    },
    uvReport: (o?: Record<string, unknown>): unknown => toPlain(uvReport(doc, (o ?? {}) as never) as unknown as JsonValue),

    // --- animation ---------------------------------------------------------------------
    createAnimation: (o: Record<string, unknown>): string => {
      op();
      return animCodeOf(createAnimation(doc, o as never));
    },
    deleteAnimation: (code: string): void => {
      op();
      deleteAnimation(doc, code);
    },
    editAnimationMeta: (code: string, patch: Record<string, unknown>): void => {
      op();
      editAnimationMeta(doc, code, patch as never);
    },
    setKeyframe: (code: string, frame: number, element: string, pose: Record<string, unknown>): void => {
      op();
      setKeyframe(doc, code, frame, element, pose as never);
    },
    deleteKeyframe: (code: string, frame: number, element?: string): void => {
      op();
      deleteKeyframe(doc, code, frame, element);
    },
    adjustChannel: (code: string, o: Record<string, unknown>): Record<string, unknown> => {
      op();
      return { ...adjustChannel(doc, code, o as never) };
    },
    retimeAnimation: (code: string, quantityFrames: number): Record<string, unknown> => {
      op();
      return { ...retimeAnimation(doc, code, quantityFrames) };
    },
    mirrorPhase: (code: string, pairs: [string, string][], o?: Record<string, unknown>): Record<string, unknown> => {
      op();
      return { ...mirrorPhase(doc, code, pairs, (o ?? {}) as never) };
    },

    // --- raw JSON escape hatch ---------------------------------------------------------
    getJson: (pointer?: string): unknown => toPlain(getAt(doc.root as unknown as JsonValue, pointer ?? '', 'getJson')),
    patchJson: (patch: PatchOpInput[]): number => {
      op();
      applyPatch(doc.root as unknown as JsonValue, patch);
      return patch.length;
    },

    // vec3 convenience (kept tiny; scripts can also use plain arrays + Math)
    vec3: {
      add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
      sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
      scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
    },
  };
  // Freeze the vec3 helpers so the sandbox rejects reassigning them.
  Object.freeze(globals['vec3']);

  // ScriptError (with its source location) and op Errors both propagate to the caller's
  // guard, which surfaces the message and rolls the transaction back.
  const returned = runScript(source, globals, opts.limits);

  if (logTruncated) log.push(`… (log truncated at ${maxLog} lines)`);
  return {
    returned: returned === undefined ? null : sanitizeReturn(returned),
    log,
    ops,
    elements: listElementNames(doc).length,
  };
}

/** JSON-safe stringify for log lines (handles cycles/functions gracefully). */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Coerce a returned value into JSON-safe plain data (drop functions, break cycles). */
function sanitizeReturn(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return String(v);
  }
}
