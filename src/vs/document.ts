/**
 * ShapeDocument: the live, lossless shape tree plus transactions, undo/redo and history.
 *
 * The tree is the parseVsJson result kept as mutable plain objects (numbers as VsNum).
 * Transaction snapshots use json.ts cloneJsonValue — NOT structuredClone — because clones
 * must preserve VsNum class identity and the hidden layout metadata that makes
 * serializeVsJson byte-stable; structuredClone destroys both. A rolled-back or undone
 * document therefore re-serializes byte-identically to its pre-transaction text.
 *
 * Identity caveat (inherent to snapshot/restore): rollback and undo/redo *replace* the
 * root tree, so element/animation references obtained before a rollback point at a dead
 * tree afterwards — re-fetch via getElement()/getAnimation() after catching a transaction
 * error. Mutating tool code that never catches its own transact errors is unaffected.
 */

import { VsNum } from './types.js';
import type { AnimationJson, ElementJson, JsonValue, ShapeJson } from './types.js';
import { VsJsonParseError, cloneJsonValue, parseVsJson, serializeVsJson, vsnum } from './json.js';

/** Undo/redo depth bound (ARCHITECTURE: bounded 200). Oldest entries are evicted. */
const MAX_UNDO = 200;

interface UndoEntry {
  summary: string;
  at: number;
  /** Snapshot of the tree as it was just before the transaction ran. */
  before: ShapeJson;
}

interface RedoEntry {
  summary: string;
  at: number;
  /** The tree as it was just after the transaction ran (displaced by undo). */
  after: ShapeJson;
}

// ShapeJson and friends are structural interfaces without index signatures, so they are
// not assignable to JsonValue/JsonObject directly; these casts are the single place where
// the typed view and the generic JSON view of the same objects meet.
const asJson = (root: ShapeJson): JsonValue => root as unknown as JsonValue;
const asShape = (v: JsonValue): ShapeJson => v as unknown as ShapeJson;

function describeJsonType(v: JsonValue): string {
  if (v === null) return 'null';
  if (v instanceof VsNum) return 'a number';
  if (Array.isArray(v)) return 'an array';
  switch (typeof v) {
    case 'string':
      return 'a string';
    case 'boolean':
      return 'a boolean';
    default:
      return 'an object';
  }
}

export class ShapeDocument {
  /** Source path when opened from a file/corpus; undefined for created/anonymous docs. */
  readonly path: string | undefined;

  #root: ShapeJson;
  #undoStack: UndoEntry[] = [];
  #redoStack: RedoEntry[] = [];
  /** Monotonic transaction sequence number (not wall-clock). */
  #seq = 1;
  /** transact() nesting depth; only depth 0→1 transactions push history. */
  #depth = 0;

  private constructor(root: ShapeJson, path: string | undefined) {
    this.#root = root;
    this.path = path;
  }

  /**
   * Parse shape JSON text into a document. The root must be a single JSON object;
   * `elements`/`animations`, when present, must be arrays (a handful of vanilla block
   * shapes omit `elements` entirely — they parse fine and traverse as empty).
   */
  static parse(text: string, opts?: { path?: string }): ShapeDocument {
    const where = opts?.path ?? 'shape text';
    let value: JsonValue;
    try {
      value = parseVsJson(text);
    } catch (e) {
      if (e instanceof VsJsonParseError && opts?.path !== undefined) {
        throw new VsJsonParseError(`${opts.path}: ${e.message}`, e.offset, e.line, e.column);
      }
      throw e;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof VsNum) {
      throw new TypeError(
        `${where}: a shape file must contain a single top-level JSON object, but this document is ` +
          `${describeJsonType(value)} — wrap the shape fields in { ... }`,
      );
    }
    const root = value as Record<string, JsonValue>;
    for (const key of ['elements', 'animations'] as const) {
      const v = root[key];
      if (v !== undefined && !Array.isArray(v)) {
        throw new TypeError(
          `${where}: "${key}" must be an array, but it is ${describeJsonType(v)} — ` +
            `write it as "${key}": [ ... ]`,
        );
      }
    }
    return new ShapeDocument(asShape(value), opts?.path);
  }

  /**
   * Create a minimal model-creator-style document: editor block, texture dimensions,
   * empty textureSizes/textures maps, no elements. Key order matches GROUND-TRUTH §8.
   */
  static create(opts: { textureWidth: number; textureHeight: number }): ShapeDocument {
    for (const [key, v] of [
      ['textureWidth', opts.textureWidth],
      ['textureHeight', opts.textureHeight],
    ] as const) {
      if (!Number.isInteger(v) || v <= 0) {
        throw new RangeError(
          `ShapeDocument.create: ${key} must be a positive integer, got ${v} — typical values are 16, 32 or 64`,
        );
      }
    }
    const root: ShapeJson = {
      // Model-creator defaults for entity shapes (fox-male.json carries exactly these).
      editor: { allAngles: true, entityTextureMode: true },
      textureWidth: vsnum(opts.textureWidth),
      textureHeight: vsnum(opts.textureHeight),
      textureSizes: {},
      textures: {},
      elements: [],
    };
    return new ShapeDocument(root, undefined);
  }

  /** The live tree. Mutate only inside transact() (ops modules do this for you). */
  get root(): ShapeJson {
    return this.#root;
  }

  serialize(): string {
    return serializeVsJson(asJson(this.#root));
  }

  // -------------------------------------------------------------------------
  // Tree access (elements are addressed BY NAME; the validator enforces uniqueness,
  // duplicate names resolve to the first in document order)
  // -------------------------------------------------------------------------

  getElement(name: string): ElementJson | undefined {
    return this.#traverse((el) => (el.name === name ? el : undefined));
  }

  /**
   * Parent of the named element; null when the element sits at root level.
   * Throws (rather than returning an ambiguous null) when no such element exists.
   */
  parentOf(name: string): ElementJson | null {
    const hit = this.#traverse((el, path) =>
      el.name === name ? { parent: path.length > 0 ? path[path.length - 1]! : null } : undefined,
    );
    if (hit === undefined) {
      throw new Error(
        `parentOf(${JSON.stringify(name)}): no element with that name exists in ${this.path ?? 'this shape'} — ` +
          `names are case-sensitive; use walk() or shape_describe to list the valid element names`,
      );
    }
    return hit.parent;
  }

  /**
   * Pre-order depth-first visit of every element exactly once. `path` is the ancestor
   * chain from root level down to the element's parent (excluding the element itself);
   * it is a fresh array per call, safe to retain.
   */
  walk(cb: (el: ElementJson, path: ElementJson[]) => void): void {
    this.#traverse((el, path) => {
      cb(el, path.slice());
      return undefined; // ignore any value the callback returns — walk never stops early
    });
  }

  /**
   * Shared pre-order traversal; the visitor stops the traversal by returning a
   * non-undefined value. Guards against cycles/shared subtrees (a buggy reparent would
   * otherwise loop forever) and against non-object entries, with messages naming the spot.
   */
  #traverse<T>(visit: (el: ElementJson, path: ElementJson[]) => T | undefined): T | undefined {
    const path: ElementJson[] = [];
    const seen = new Set<ElementJson>();
    const go = (children: unknown, owner: string): T | undefined => {
      if (children === undefined) return undefined;
      if (!Array.isArray(children)) {
        throw new TypeError(`${owner} must be an array of element objects in ${this.path ?? 'this shape'}`);
      }
      for (let i = 0; i < children.length; i++) {
        const el = children[i] as ElementJson;
        if (el === null || typeof el !== 'object' || Array.isArray(el) || el instanceof VsNum) {
          throw new TypeError(
            `${owner}[${i}] in ${this.path ?? 'this shape'} is not an element object — ` +
              `each entry must be an object with at least "name", "from" and "to"`,
          );
        }
        if (seen.has(el)) {
          throw new Error(
            `element ${JSON.stringify(el.name)} appears more than once in the tree of ` +
              `${this.path ?? 'this shape'} (cycle or shared subtree) — repair the tree before traversing it`,
          );
        }
        seen.add(el);
        const out = visit(el, path);
        if (out !== undefined) return out;
        path.push(el);
        const fromChild = go(el.children, `element ${JSON.stringify(el.name)} "children"`);
        path.pop();
        if (fromChild !== undefined) return fromChild;
      }
      return undefined;
    };
    return go((this.#root as { elements?: unknown }).elements, '"elements"');
  }

  // -------------------------------------------------------------------------
  // Animations
  // -------------------------------------------------------------------------

  listAnimations(): AnimationJson[] {
    const anims = (this.#root as { animations?: unknown }).animations;
    return Array.isArray(anims) ? [...(anims as AnimationJson[])] : [];
  }

  /**
   * Look up by effective code: the animation's `code`, defaulting to its `name` when
   * `code` is absent (engine semantics, GROUND-TRUTH §5). Exact, case-sensitive match.
   */
  getAnimation(code: string): AnimationJson | undefined {
    for (const anim of this.listAnimations()) {
      const effective = typeof anim.code === 'string' ? anim.code : anim.name;
      if (effective === code) return anim;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Transactions / undo / redo / history
  // -------------------------------------------------------------------------

  /**
   * Run `fn` as one atomic edit. On throw the tree is restored to this transact's start
   * (byte-identical serialize) and the error is rethrown. Nested calls fold into the
   * outermost transaction: only it pushes the (single) undo/history entry, but each level
   * still rolls back to its own start on throw, so an outer fn that catches an inner
   * failure keeps a consistent tree. A committed transaction clears the redo stack —
   * EXCEPT when `fn` changed nothing (byte-identical serialize): read-only operations
   * (e.g. a doc_patch_json consisting only of 'test' ops, or a field-less element_edit)
   * push no history entry and leave the redo stack intact, so an agent that undoes,
   * verifies state with a no-op call, then redoes does not silently lose the redo chain.
   */
  transact<T>(summary: string, fn: () => T): T {
    const before = this.#snapshot();
    this.#depth++;
    try {
      const result = fn();
      this.#depth--;
      if (this.#depth === 0 && this.serialize() !== serializeVsJson(asJson(before))) {
        this.#undoStack.push({ summary, at: this.#seq++, before });
        if (this.#undoStack.length > MAX_UNDO) this.#undoStack.shift();
        this.#redoStack.length = 0;
      }
      return result;
    } catch (err) {
      this.#depth--;
      this.#root = before;
      throw err;
    }
  }

  /** Undo the most recent transaction. Returns its summary, or null if nothing to undo. */
  undo(): string | null {
    this.#assertNoOpenTransaction('undo');
    const entry = this.#undoStack.pop();
    if (entry === undefined) return null;
    this.#redoStack.push({ summary: entry.summary, at: entry.at, after: this.#root });
    this.#root = entry.before;
    return entry.summary;
  }

  /** Re-apply the most recently undone transaction. Returns its summary, or null. */
  redo(): string | null {
    this.#assertNoOpenTransaction('redo');
    const entry = this.#redoStack.pop();
    if (entry === undefined) return null;
    this.#undoStack.push({ summary: entry.summary, at: entry.at, before: this.#root });
    this.#root = entry.after;
    return entry.summary;
  }

  /**
   * Applied transactions, oldest first, `at` strictly increasing. Mirrors the undo stack:
   * undone entries leave the history (they live on the redo stack until redone or until a
   * new transaction clears them), and entries evicted past the 200 bound are forgotten.
   */
  history(): { summary: string; at: number }[] {
    return this.#undoStack.map((e) => ({ summary: e.summary, at: e.at }));
  }

  #snapshot(): ShapeJson {
    // cloneJsonValue keeps VsNum instances and the WeakMap layout metadata alive;
    // structuredClone would silently strip both and wreck byte-stable serialization.
    return asShape(cloneJsonValue(asJson(this.#root)));
  }

  #assertNoOpenTransaction(op: 'undo' | 'redo'): void {
    if (this.#depth > 0) {
      throw new Error(
        `${op}() cannot run inside an open transaction on ${this.path ?? 'this shape'} — ` +
          `let the transact() call finish (or throw) first`,
      );
    }
  }
}
