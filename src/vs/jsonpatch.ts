/**
 * RFC-6902 JSON Patch + RFC-6901 pointer navigation over the live lossless document tree,
 * plus the lossless⇄plain conversions the patch ops need. Extracted from server.ts so the
 * `doc_patch_json` tool and the `doc_script` sandbox's `patchJson`/`getJson` API share one
 * implementation. Every op mutates the tree in place; callers wrap the call in a
 * doc.transact so a thrown error rolls the whole patch back.
 */

import { cloneJsonValue, vsnum } from './json.js';
import { VsNum, type JsonObject, type JsonValue } from './types.js';

/** Lossless tree → plain JSON (VsNum → number); used by all query/JSON tools. */
export function toPlain(v: JsonValue): unknown {
  if (v instanceof VsNum) return v.value;
  if (Array.isArray(v)) return v.map(toPlain);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = toPlain(val);
    return out;
  }
  return v;
}

/** Plain JSON → lossless tree, wrapping every fresh number via vsnum. */
export function plainToJsonValue(v: unknown, where: string): JsonValue {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(`${where}: ${v} is not a finite number — JSON cannot carry NaN/Infinity`);
    }
    return vsnum(v);
  }
  if (Array.isArray(v)) return v.map((x, i) => plainToJsonValue(x, `${where}[${i}]`));
  if (typeof v === 'object') {
    const out: JsonObject = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue; // JSON has no undefined; skip like JSON.stringify
      out[k] = plainToJsonValue(val, `${where}.${k}`);
    }
    return out;
  }
  throw new Error(`${where}: a ${typeof v} is not a JSON value`);
}

function deepEqualPlain(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqualPlain(x, b[i]));
  }
  if (
    a !== null && b !== null &&
    typeof a === 'object' && typeof b === 'object' &&
    !Array.isArray(a) && !Array.isArray(b)
  ) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        deepEqualPlain((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}

const short = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

export interface PatchOpInput {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

function parsePointer(ptr: string, what: string): string[] {
  if (ptr === '') return [];
  if (!ptr.startsWith('/')) {
    throw new Error(
      `${what}: JSON pointer '${ptr}' must start with '/' (or be '' for the whole document) — ` +
        `e.g. '/elements/0/name'`,
    );
  }
  return ptr.slice(1).split('/').map((t) => t.replaceAll('~1', '/').replaceAll('~0', '~'));
}

const CANONICAL_INDEX = /^(0|[1-9][0-9]*)$/;

const isJsonObject = (v: JsonValue): v is JsonObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof VsNum);

const describeNode = (v: JsonValue): string => {
  if (v === null) return 'null';
  if (v instanceof VsNum) return `the number ${v.value}`;
  if (Array.isArray(v)) return `an array of length ${v.length}`;
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    return `an object with key${keys.length === 1 ? '' : 's'} ${keys.slice(0, 20).map((k) => `'${k}'`).join(', ')}${keys.length > 20 ? ', …' : ''}`;
  }
  return `the ${typeof v} ${JSON.stringify(v)}`;
};

/** One step of pointer navigation (read position: array '-' is invalid here). */
function childAt(cur: JsonValue, token: string, ptr: string): JsonValue {
  if (Array.isArray(cur)) {
    if (!CANONICAL_INDEX.test(token)) {
      throw new Error(
        `JSON pointer '${ptr}': '${token}' is not a valid array index ` +
          `(the array here has ${cur.length} item${cur.length === 1 ? '' : 's'}; indices are 0-based canonical integers)`,
      );
    }
    const idx = Number(token);
    if (idx >= cur.length) {
      throw new Error(
        `JSON pointer '${ptr}': index ${idx} is out of range — the array here has ` +
          `${cur.length} item${cur.length === 1 ? '' : 's'} (valid indices 0..${cur.length - 1})`,
      );
    }
    return cur[idx]!;
  }
  if (isJsonObject(cur)) {
    if (!Object.prototype.hasOwnProperty.call(cur, token)) {
      throw new Error(
        `JSON pointer '${ptr}': no key '${token}' here — this node is ${describeNode(cur)}`,
      );
    }
    return cur[token]!;
  }
  throw new Error(
    `JSON pointer '${ptr}': cannot step into '${token}' — this node is ${describeNode(cur)}, ` +
      `not an object or array`,
  );
}

export function getAt(root: JsonValue, ptr: string, what: string): JsonValue {
  let cur = root;
  for (const token of parsePointer(ptr, what)) cur = childAt(cur, token, ptr);
  return cur;
}

/** Resolve a pointer to its parent container + final token (write position). */
function resolveParent(
  root: JsonValue,
  ptr: string,
  what: string,
): { parent: JsonValue; token: string } {
  const tokens = parsePointer(ptr, what);
  if (tokens.length === 0) {
    throw new Error(
      `${what}: the whole-document pointer '' cannot be written to (the document root object ` +
        `is fixed) — target a subpath like '/elements' or '/textures/skin' instead`,
    );
  }
  let cur = root;
  const parentPtr = `/${tokens.slice(0, -1).join('/')}`;
  for (let i = 0; i < tokens.length - 1; i++) cur = childAt(cur, tokens[i]!, parentPtr);
  return { parent: cur, token: tokens[tokens.length - 1]! };
}

function patchAdd(root: JsonValue, ptr: string, value: JsonValue, what: string): void {
  const { parent, token } = resolveParent(root, ptr, what);
  if (Array.isArray(parent)) {
    if (token === '-') {
      parent.push(value);
      return;
    }
    if (!CANONICAL_INDEX.test(token)) {
      throw new Error(
        `${what} at '${ptr}': '${token}' is not a valid array index — use a canonical integer ` +
          `0..${parent.length} (the length appends) or '-' to append`,
      );
    }
    const idx = Number(token);
    if (idx > parent.length) {
      throw new Error(
        `${what} at '${ptr}': index ${idx} is past the end — the array has ${parent.length} ` +
          `item${parent.length === 1 ? '' : 's'}; use ${parent.length} or '-' to append`,
      );
    }
    parent.splice(idx, 0, value);
    return;
  }
  if (isJsonObject(parent)) {
    parent[token] = value; // RFC 6902: add over an existing member replaces it
    return;
  }
  throw new Error(`${what} at '${ptr}': the parent is ${describeNode(parent)}, not an object or array`);
}

/** replace assigns in place so an existing object key keeps its insertion (serialize) order. */
function patchReplace(root: JsonValue, ptr: string, value: JsonValue, what: string): void {
  const { parent, token } = resolveParent(root, ptr, what);
  childAt(parent, token, ptr); // existence check with a precise error (RFC: target must exist)
  if (Array.isArray(parent)) {
    parent[Number(token)] = value;
    return;
  }
  (parent as JsonObject)[token] = value;
}

/** remove that returns the removed value (move = remove + add of that value). */
function patchRemove(root: JsonValue, ptr: string, what: string): JsonValue {
  const { parent, token } = resolveParent(root, ptr, what);
  if (Array.isArray(parent)) {
    const removed = childAt(parent, token, ptr);
    parent.splice(Number(token), 1);
    return removed;
  }
  if (isJsonObject(parent)) {
    const removed = childAt(parent, token, ptr);
    delete parent[token];
    return removed;
  }
  throw new Error(`${what} at '${ptr}': the parent is ${describeNode(parent)}, not an object or array`);
}

export function applyPatch(root: JsonValue, patch: PatchOpInput[]): void {
  for (let i = 0; i < patch.length; i++) {
    const op = patch[i]!;
    const what = `doc_patch_json op ${i + 1}/${patch.length} (${op.op})`;
    switch (op.op) {
      case 'add':
      case 'replace': {
        if (!('value' in op) || op.value === undefined) {
          throw new Error(`${what}: '${op.op}' requires a 'value'`);
        }
        const value = plainToJsonValue(op.value, `${what} value`);
        if (op.op === 'replace') patchReplace(root, op.path, value, what);
        else patchAdd(root, op.path, value, what);
        break;
      }
      case 'remove':
        patchRemove(root, op.path, what);
        break;
      case 'move': {
        if (op.from === undefined) throw new Error(`${what}: 'move' requires 'from'`);
        if (op.path === op.from) break; // moving a value onto itself is a no-op
        if (op.path.startsWith(`${op.from}/`)) {
          throw new Error(
            `${what}: cannot move '${op.from}' into its own child '${op.path}' — ` +
              `that would detach the subtree from the document`,
          );
        }
        getAt(root, op.from, what); // existence check with a good error before mutating
        const moved = patchRemove(root, op.from, what);
        patchAdd(root, op.path, moved, what);
        break;
      }
      case 'copy': {
        if (op.from === undefined) throw new Error(`${what}: 'copy' requires 'from'`);
        const copied = cloneJsonValue(getAt(root, op.from, what));
        patchAdd(root, op.path, copied, what);
        break;
      }
      case 'test': {
        if (!('value' in op)) throw new Error(`${what}: 'test' requires a 'value'`);
        const actual = toPlain(getAt(root, op.path, what));
        if (!deepEqualPlain(actual, op.value ?? null)) {
          throw new Error(
            `${what} failed at '${op.path}': the document has ${short(actual)} but the patch ` +
              `expected ${short(op.value)} — the whole patch was rolled back (no changes applied)`,
          );
        }
        break;
      }
    }
  }
}
