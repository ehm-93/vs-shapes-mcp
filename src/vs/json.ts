/**
 * Lossless Vintage Story shape JSON.
 *
 * Parsing keeps the tree as plain mutable objects/arrays (numbers wrapped in {@link VsNum})
 * while every byte of layout — inter-token whitespace, raw key/string tokens, trailing
 * commas, duplicate-key occurrences — is remembered in module-private WeakMaps keyed by the
 * node identity. `serializeVsJson(parseVsJson(text))` is therefore byte-identical by
 * construction for any file that parses. Nodes created by editing tools (no layout
 * metadata) serialize in canonical VS model-creator style: CRLF + tabs, inline number
 * arrays `[ 1.0, 2.0 ]`, inline face / keyframe-element objects, field-appropriate number
 * formatting (see {@link FIELD_NUMBER_STYLE} and docs/ground-truth/format-empirics.md).
 *
 * Lenient features matching what Newtonsoft (and thus the engine) accepts AND that occur in
 * the vanilla 1.22 corpus: trailing commas (37 files, 21 under entity/), unquoted property
 * names (~17 block/ files), duplicate keys (10 files, 7 under entity/ — last occurrence
 * wins, earlier ones preserved as raw "shadow" text WHILE the key stays unedited; editing,
 * deleting or invalidating the live value drops the shadows so saved files never carry a
 * stale contradicting duplicate, see {@link invalidateShadows}). Comments are rejected with
 * a position-bearing error per ARCHITECTURE (only 18 block/metal/furnacesection files have
 * them). '+'-signed numbers are rejected (Newtonsoft rejects them; zero corpus occurrences).
 */

import { VsNum } from './types.js';
import type { JsonObject, JsonValue } from './types.js';

// ---------------------------------------------------------------------------
// Public number helpers
// ---------------------------------------------------------------------------

/** Wrap a fresh number (no source literal — formats per field convention on serialize). */
export const vsnum = (n: number): VsNum => new VsNum(n);

/** Unwrap a VsNum. */
export const numValue = (v: VsNum): number => v.value;

export type NumberStyle = 'double' | 'int' | 'auto';

/**
 * Format a fresh number the way the VS model creator writes the given style:
 * - 'double': integral values get a trailing `.0` (`4.0`, `-3.0`);
 * - 'int': plain decimal integer;
 * - 'auto': integral → int form, else shortest decimal.
 * Non-integral values always print their shortest round-trip decimal (`0.5`,
 * `-0.30000000000000004`, `1e-7`).
 */
export function formatVsNumber(n: number, style: NumberStyle): string {
  if (!Number.isFinite(n)) {
    throw new RangeError(
      `Cannot serialize non-finite number ${n} into shape JSON — replace it with a finite value before serializing`,
    );
  }
  if (Number.isInteger(n)) {
    if (style === 'double') {
      if (Object.is(n, -0)) return '-0.0'; // corpus writes -0.0 for tiny negative doubles
      // toFixed(1) falls back to exponent notation only beyond 1e21; String() is valid JSON there.
      return Math.abs(n) < 1e21 ? n.toFixed(1) : String(n);
    }
    return Object.is(n, -0) ? '0' : String(n);
  }
  return String(n);
}

/**
 * Field → canonical number style, derived from the vanilla corpus
 * (docs/ground-truth/format-empirics.md). Applied to fresh numbers (VsNum without a raw
 * literal) based on the nearest enclosing object key. Anything not listed uses 'auto'
 * (covers textureSizes entries, which are keyed by texture name and written as ints).
 */
const FIELD_NUMBER_STYLE: Readonly<Record<string, 'double' | 'int'>> = {
  // geometry + uv — always written with a decimal point in vanilla
  from: 'double',
  to: 'double',
  rotationOrigin: 'double',
  uv: 'double',
  rotationX: 'double',
  rotationY: 'double',
  rotationZ: 'double',
  // keyframe channels (offset/rotation observed as doubles; stretch/origin/scale do not
  // occur in the vanilla corpus — UNVERIFIED, chosen by analogy with offsets/rotations)
  offsetX: 'double',
  offsetY: 'double',
  offsetZ: 'double',
  originX: 'double',
  originY: 'double',
  originZ: 'double',
  stretchX: 'double',
  stretchY: 'double',
  stretchZ: 'double',
  scaleX: 'double',
  scaleY: 'double',
  scaleZ: 'double',
  // integers
  rotation: 'int', // face quarter-turns
  glow: 'int',
  frame: 'int',
  quantityframes: 'int',
  version: 'int',
  textureWidth: 'int',
  textureHeight: 'int',
  unwrapMode: 'int',
  unwrapRotation: 'int',
  reflectiveMode: 'int',
  windMode: 'int',
  windData: 'int',
  renderPass: 'int',
  zOffset: 'int',
};

// ---------------------------------------------------------------------------
// Hidden layout metadata
// ---------------------------------------------------------------------------
// The parsed tree looks like plain objects/arrays to every other module; layout lives in
// WeakMaps keyed by node identity so mutation through the tree keeps metadata attached.

interface LiveEntryLayout {
  kind: 'live';
  key: string;
  /** Gap before the key token (after '{' or after the preceding ','). */
  preKey: string;
  /** Exact source key token, only when it differs from JSON.stringify(key) (unquoted keys). */
  rawKey?: string;
  /** Gap between key token and ':'. */
  preColon: string;
  /** Gap between ':' and the value's first token. */
  preValue: string;
  /** Gap before the ',' that followed this entry in the source ('' if none). */
  preComma: string;
  hadComma: boolean;
  /** True when this was the last entry in the source object (trailing-comma bookkeeping). */
  wasLast: boolean;
  /** Exact source token for string values when it differs from canonical JSON.stringify. */
  rawString?: { raw: string; value: string };
  /**
   * Set only for keys that had duplicate occurrences in the source: the parse-time live
   * value (boxed so a null value is distinguishable from "absent"). Shadow entries for the
   * key are re-emitted only while `obj[key] === originalValue.v` — once the live value is
   * replaced, deleted + re-added, or invalidated via {@link invalidateShadows}, the stale
   * duplicate source text would contradict the document and is dropped instead.
   */
  originalValue?: { v: JsonValue };
}

/**
 * An earlier occurrence of a duplicated key. Its value is unreachable from the JS object
 * (last occurrence wins, matching Newtonsoft/engine semantics) so the exact source text is
 * kept and re-emitted verbatim. 10 vanilla files need this, 7 under entity/.
 */
interface ShadowEntryLayout {
  kind: 'shadow';
  key: string;
  preKey: string;
  rawKey: string;
  preColon: string;
  preValue: string;
  /** Exact source slice of the value (any JSON type, containers included). */
  rawValue: string;
  preComma: string;
  hadComma: boolean;
  wasLast: boolean;
}

type ObjectEntryLayout = LiveEntryLayout | ShadowEntryLayout;

interface ObjectLayout {
  /** Entries in source order (shadows interleaved at their original positions). */
  entries: ObjectEntryLayout[];
  byKey: Map<string, LiveEntryLayout>;
  /** Gap before '}' (for an empty object: the whole gap between braces). */
  preClose: string;
}

interface ArrayItemLayout {
  preValue: string;
  preComma: string;
  hadComma: boolean;
  rawString?: { raw: string; value: string };
}

interface ArrayLayout {
  items: ArrayItemLayout[];
  preClose: string;
}

interface DocTrivia {
  /** Whitespace (and BOM) before the first token. */
  leading: string;
  /** Whitespace after the last token (most vanilla files have none). */
  trailing: string;
  /** Dominant newline style of the source, used for fresh nodes inserted into this tree. */
  newline: '\r\n' | '\n';
}

const objectLayouts = new WeakMap<JsonObject, ObjectLayout>();
const arrayLayouts = new WeakMap<JsonValue[], ArrayLayout>();
const docTrivia = new WeakMap<object, DocTrivia>();

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Parse error carrying offset/line/column for tooling; message already names them. */
export class VsJsonParseError extends SyntaxError {
  constructor(
    message: string,
    readonly offset: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = 'VsJsonParseError';
  }
}

class Parser {
  pos = 0;

  constructor(readonly text: string) {}

  fail(offset: number, what: string, fix?: string): never {
    let line = 1;
    let lineStart = 0;
    const end = Math.min(offset, this.text.length);
    for (let i = 0; i < end; i++) {
      if (this.text.charCodeAt(i) === 10) {
        line++;
        lineStart = i + 1;
      }
    }
    const column = offset - lineStart + 1;
    const ctx = JSON.stringify(this.text.slice(Math.max(0, offset - 30), offset + 30));
    throw new VsJsonParseError(
      `Invalid shape JSON at line ${line}, column ${column}: ${what}${fix ? ` — ${fix}` : ''}. Context: ${ctx}`,
      offset,
      line,
      column,
    );
  }

  /** Consume whitespace, returning it verbatim; detects (and rejects) comments. */
  gap(): string {
    const t = this.text;
    const start = this.pos;
    let i = this.pos;
    while (i < t.length) {
      const c = t.charCodeAt(i);
      if (c === 32 || c === 9 || c === 13 || c === 10) i++;
      else break;
    }
    this.pos = i;
    if (t.charCodeAt(i) === 47 /* '/' */) {
      const n = t.charCodeAt(i + 1);
      if (n === 47 || n === 42) {
        this.fail(
          i,
          `a '${n === 47 ? '//' : '/*'}' comment was found`,
          'comments are not allowed in shape JSON; delete the comment and re-save the file',
        );
      }
    }
    return t.slice(start, i);
  }

  parseString(): { raw: string; value: string } {
    const t = this.text;
    const start = this.pos; // caller guarantees t[start] === '"'
    let i = start + 1;
    let value = '';
    let chunkStart = i;
    for (;;) {
      if (i >= t.length) {
        this.fail(start, 'unterminated string literal', `add the closing '"'`);
      }
      const c = t.charCodeAt(i);
      if (c === 34 /* '"' */) {
        value += t.slice(chunkStart, i);
        i++;
        break;
      }
      if (c === 92 /* '\\' */) {
        value += t.slice(chunkStart, i);
        const e = t.charCodeAt(i + 1);
        switch (e) {
          case 34: value += '"'; i += 2; break;
          case 92: value += '\\'; i += 2; break;
          case 47: value += '/'; i += 2; break;
          case 98: value += '\b'; i += 2; break;
          case 102: value += '\f'; i += 2; break;
          case 110: value += '\n'; i += 2; break;
          case 114: value += '\r'; i += 2; break;
          case 116: value += '\t'; i += 2; break;
          case 117: {
            const hex = t.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              this.fail(i, `invalid unicode escape '\\u${hex}'`, 'use exactly four hex digits, e.g. \\u00e9');
            }
            value += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            break;
          }
          default:
            this.fail(
              i,
              `invalid string escape '\\${t[i + 1] ?? '<end of file>'}'`,
              'valid escapes are \\" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX',
            );
        }
        chunkStart = i;
      } else {
        i++;
      }
    }
    this.pos = i;
    return { raw: t.slice(start, i), value };
  }

  parseNumber(): VsNum {
    const t = this.text;
    const start = this.pos;
    let i = start;
    let c = t.charCodeAt(i);
    // Only '-' is a valid sign: Newtonsoft's JsonTextReader rejects a leading '+'
    // ("Unexpected character encountered while parsing value: +"), so the engine cannot
    // load such a file, and the vanilla corpus has none — accepting it here would
    // silently re-save a file the game rejects.
    if (c === 45) {
      i++;
      c = t.charCodeAt(i);
    }
    let digits = false;
    while (c >= 48 && c <= 57) {
      i++;
      digits = true;
      c = t.charCodeAt(i);
    }
    if (c === 46 /* '.' */) {
      i++;
      c = t.charCodeAt(i);
      while (c >= 48 && c <= 57) {
        i++;
        digits = true;
        c = t.charCodeAt(i);
      }
    }
    if (!digits) {
      this.fail(start, `invalid number literal '${t.slice(start, i + 1)}'`, 'numbers need at least one digit');
    }
    if (c === 101 || c === 69 /* e/E */) {
      let j = i + 1;
      let ec = t.charCodeAt(j);
      if (ec === 43 || ec === 45) {
        j++;
        ec = t.charCodeAt(j);
      }
      let expDigits = false;
      while (ec >= 48 && ec <= 57) {
        j++;
        expDigits = true;
        ec = t.charCodeAt(j);
      }
      if (!expDigits) {
        this.fail(start, `invalid number exponent in '${t.slice(start, j)}'`, "an exponent like 'E-6' needs digits");
      }
      i = j;
    }
    this.pos = i;
    const raw = t.slice(start, i);
    return new VsNum(Number(raw), raw);
  }

  parseValue(): JsonValue {
    const t = this.text;
    const c = t.charCodeAt(this.pos);
    if (c === 123 /* '{' */) return this.parseObject();
    if (c === 91 /* '[' */) return this.parseArray();
    if (c === 34 /* '"' */) return this.parseString().value;
    if (c === 116 /* 't' */) { this.expectLiteral('true'); return true; }
    if (c === 102 /* 'f' */) { this.expectLiteral('false'); return false; }
    if (c === 110 /* 'n' */) { this.expectLiteral('null'); return null; }
    if (c === 43 /* '+' */) {
      this.fail(
        this.pos,
        `a '+'-signed number is not valid JSON`,
        `the engine's parser (Newtonsoft) rejects it too — drop the '+'`,
      );
    }
    if (c === 45 || c === 46 || (c >= 48 && c <= 57)) return this.parseNumber();
    if (Number.isNaN(c)) {
      this.fail(this.pos, 'unexpected end of file while expecting a value', 'the document is truncated');
    }
    this.fail(
      this.pos,
      `unexpected character ${JSON.stringify(t[this.pos])} while expecting a value`,
      'expected an object, array, string, number, true, false or null',
    );
  }

  private expectLiteral(lit: string): void {
    if (this.text.startsWith(lit, this.pos)) {
      const c = this.text.charCodeAt(this.pos + lit.length);
      const wordChar = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
      if (!wordChar) {
        this.pos += lit.length;
        return;
      }
    }
    this.fail(this.pos, `invalid literal — expected '${lit}'`, "bare words other than true/false/null are not valid values");
  }

  /** Lenient property-name token: double-quoted string or bare identifier (Newtonsoft-style). */
  private parseKey(): { key: string; rawKey: string } {
    const t = this.text;
    if (t.charCodeAt(this.pos) === 34) {
      const s = this.parseString();
      return { key: s.value, rawKey: s.raw };
    }
    let i = this.pos;
    while (i < t.length) {
      const c = t.charCodeAt(i);
      // stop at ':' whitespace and structural chars
      if (
        c === 58 || c === 32 || c === 9 || c === 13 || c === 10 ||
        c === 44 || c === 123 || c === 125 || c === 91 || c === 93 || c === 34 || c === 47
      ) {
        break;
      }
      i++;
    }
    if (i === this.pos) {
      this.fail(this.pos, `expected a property name but found ${JSON.stringify(t[this.pos] ?? '<end of file>')}`, 'use a double-quoted key like "name"');
    }
    const rawKey = t.slice(this.pos, i);
    this.pos = i;
    return { key: rawKey, rawKey };
  }

  parseObject(): JsonObject {
    const t = this.text;
    const openPos = this.pos;
    this.pos++; // '{'
    const obj: JsonObject = {};
    const layout: ObjectLayout = { entries: [], byKey: new Map(), preClose: '' };
    objectLayouts.set(obj, layout);

    let preEntry = this.gap();
    if (t.charCodeAt(this.pos) === 125 /* '}' */) {
      this.pos++;
      layout.preClose = preEntry;
      return obj;
    }

    interface RawEntry {
      key: string;
      rawKey: string;
      preKey: string;
      preColon: string;
      preValue: string;
      vStart: number;
      vEnd: number;
      value: JsonValue;
      preComma: string;
      hadComma: boolean;
    }
    const raws: RawEntry[] = [];

    for (;;) {
      if (this.pos >= t.length) {
        this.fail(openPos, "unterminated object — '{' was never closed", "add the matching '}'");
      }
      const preKey = preEntry;
      const { key, rawKey } = this.parseKey();
      const preColon = this.gap();
      if (t.charCodeAt(this.pos) !== 58 /* ':' */) {
        this.fail(this.pos, `expected ':' after property name ${JSON.stringify(key)}`, "write entries as \"key\": value");
      }
      this.pos++;
      const preValue = this.gap();
      const vStart = this.pos;
      const value = this.parseValue();
      const vEnd = this.pos;
      const afterValue = this.gap();
      const cc = t.charCodeAt(this.pos);
      if (cc === 44 /* ',' */) {
        this.pos++;
        const next = this.gap();
        raws.push({ key, rawKey, preKey, preColon, preValue, vStart, vEnd, value, preComma: afterValue, hadComma: true });
        if (t.charCodeAt(this.pos) === 125) {
          // trailing comma — Newtonsoft-lenient, present in 37 vanilla files
          this.pos++;
          layout.preClose = next;
          break;
        }
        preEntry = next;
        continue;
      }
      if (cc === 125 /* '}' */) {
        this.pos++;
        raws.push({ key, rawKey, preKey, preColon, preValue, vStart, vEnd, value, preComma: '', hadComma: false });
        layout.preClose = afterValue;
        break;
      }
      this.fail(this.pos, `expected ',' or '}' after the value of ${JSON.stringify(key)}`, 'separate object entries with commas');
    }

    // Duplicate keys: last occurrence wins (Newtonsoft/engine semantics); earlier
    // occurrences become raw-text shadow entries so the bytes survive round-trip.
    const lastIndexByKey = new Map<string, number>();
    const occurrences = new Map<string, number>();
    for (let i = 0; i < raws.length; i++) {
      lastIndexByKey.set(raws[i]!.key, i);
      occurrences.set(raws[i]!.key, (occurrences.get(raws[i]!.key) ?? 0) + 1);
    }
    for (let i = 0; i < raws.length; i++) {
      const r = raws[i]!;
      const wasLast = i === raws.length - 1;
      if (lastIndexByKey.get(r.key) === i) {
        const entry: LiveEntryLayout = {
          kind: 'live',
          key: r.key,
          preKey: r.preKey,
          preColon: r.preColon,
          preValue: r.preValue,
          preComma: r.preComma,
          hadComma: r.hadComma,
          wasLast,
        };
        if (occurrences.get(r.key)! > 1) entry.originalValue = { v: r.value };
        if (r.rawKey !== JSON.stringify(r.key)) entry.rawKey = r.rawKey;
        if (typeof r.value === 'string') {
          const rawTok = t.slice(r.vStart, r.vEnd);
          if (rawTok !== JSON.stringify(r.value)) entry.rawString = { raw: rawTok, value: r.value };
        }
        layout.entries.push(entry);
        layout.byKey.set(r.key, entry);
        obj[r.key] = r.value;
      } else {
        layout.entries.push({
          kind: 'shadow',
          key: r.key,
          preKey: r.preKey,
          rawKey: r.rawKey,
          preColon: r.preColon,
          preValue: r.preValue,
          rawValue: t.slice(r.vStart, r.vEnd),
          preComma: r.preComma,
          hadComma: r.hadComma,
          wasLast,
        });
      }
    }
    return obj;
  }

  parseArray(): JsonValue[] {
    const t = this.text;
    const openPos = this.pos;
    this.pos++; // '['
    const arr: JsonValue[] = [];
    const layout: ArrayLayout = { items: [], preClose: '' };
    arrayLayouts.set(arr, layout);

    let pre = this.gap();
    if (t.charCodeAt(this.pos) === 93 /* ']' */) {
      this.pos++;
      layout.preClose = pre;
      return arr;
    }
    for (;;) {
      if (this.pos >= t.length) {
        this.fail(openPos, "unterminated array — '[' was never closed", "add the matching ']'");
      }
      const vStart = this.pos;
      const value = this.parseValue();
      const vEnd = this.pos;
      const afterValue = this.gap();
      const item: ArrayItemLayout = { preValue: pre, preComma: '', hadComma: false };
      if (typeof value === 'string') {
        const rawTok = t.slice(vStart, vEnd);
        if (rawTok !== JSON.stringify(value)) item.rawString = { raw: rawTok, value };
      }
      arr.push(value);
      const cc = t.charCodeAt(this.pos);
      if (cc === 44 /* ',' */) {
        this.pos++;
        const next = this.gap();
        item.preComma = afterValue;
        item.hadComma = true;
        layout.items.push(item);
        if (t.charCodeAt(this.pos) === 93) {
          this.pos++;
          layout.preClose = next;
          break;
        }
        pre = next;
        continue;
      }
      if (cc === 93 /* ']' */) {
        this.pos++;
        layout.items.push(item);
        layout.preClose = afterValue;
        break;
      }
      this.fail(this.pos, `expected ',' or ']' inside an array`, 'separate array items with commas');
    }
    return arr;
  }
}

function sniffNewline(text: string): '\r\n' | '\n' {
  const i = text.indexOf('\n');
  if (i === -1) return '\r\n';
  return i > 0 && text.charCodeAt(i - 1) === 13 ? '\r\n' : '\n';
}

/**
 * Parse shape JSON preserving key order, number literals ({@link VsNum.raw}), raw
 * string/key tokens, all inter-token whitespace, trailing commas and duplicate keys.
 * Throws {@link VsJsonParseError} (with line/column and context) on malformed input,
 * comments, or trailing garbage.
 */
export function parseVsJson(text: string): JsonValue {
  let leading = '';
  let body = text;
  if (body.charCodeAt(0) === 0xfeff) {
    leading = body[0]!;
    body = body.slice(1);
  }
  const p = new Parser(body);
  leading += p.gap();
  if (p.pos >= body.length) {
    p.fail(p.pos, 'the document is empty', 'a shape file contains one top-level JSON object');
  }
  const value = p.parseValue();
  const trailing = p.gap();
  if (p.pos < body.length) {
    p.fail(
      p.pos,
      'unexpected content after the end of the JSON document',
      'a shape file must contain exactly one top-level value — delete the extra content',
    );
  }
  if (value !== null && typeof value === 'object') {
    // Roots that are objects/arrays/VsNum can carry document trivia; bare string/bool/null
    // roots cannot (never the case for shape files, which are single objects).
    docTrivia.set(value, { leading, trailing, newline: sniffNewline(text) });
  }
  return value;
}

/**
 * Stops re-emitting the raw "shadow" text of earlier duplicate occurrences of `key` in
 * `obj`. The serializer drops shadows automatically when the key's live value is replaced
 * or deleted, but an IN-PLACE mutation of the live value (e.g. setKeyframe editing an
 * existing keyframe-element entry's channels) keeps the value's identity, which the
 * serializer cannot distinguish from "unedited" — editing ops that mutate a
 * possibly-duplicated entry call this so saved files do not keep a stale contradicting
 * duplicate of the line just edited. No-op for fresh objects or non-duplicated keys.
 */
export function invalidateShadows(obj: JsonObject, key: string): void {
  const live = objectLayouts.get(obj)?.byKey.get(key);
  if (live !== undefined) delete live.originalValue;
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

export interface SerializeOptions {
  /**
   * Newline used for fresh (layout-less) nodes. Defaults to the newline style sniffed when
   * the root was parsed, else CRLF (the model-creator default). Preserved layout always
   * keeps its original newlines regardless of this option.
   */
  newline?: '\r\n' | '\n';
}

const TABS: string[] = [''];
function tabs(n: number): string {
  while (TABS.length <= n) TABS.push(TABS[TABS.length - 1]! + '\t');
  return TABS[n]!;
}

interface EmitCtx {
  out: string[];
  nl: '\r\n' | '\n';
  /** Object-key path to the node being emitted (array indices are not pushed). */
  keys: string[];
}

/**
 * Serialize in VS model-creator style. Parsed nodes reproduce their source bytes exactly;
 * fresh nodes use the canonical conventions (CRLF/tabs, inline number arrays and face /
 * keyframe-element objects, field-appropriate number formatting).
 */
export function serializeVsJson(value: JsonValue, opts?: SerializeOptions): string {
  const trivia = value !== null && typeof value === 'object' ? docTrivia.get(value) : undefined;
  const ctx: EmitCtx = { out: [], nl: opts?.newline ?? trivia?.newline ?? '\r\n', keys: [] };
  emitValue(ctx, value, 0);
  return (trivia?.leading ?? '') + ctx.out.join('') + (trivia?.trailing ?? '');
}

function styleForPath(keys: string[]): NumberStyle {
  const field = keys[keys.length - 1];
  return (field !== undefined ? FIELD_NUMBER_STYLE[field] : undefined) ?? 'auto';
}

function numberText(v: VsNum, keys: string[]): string {
  // The raw literal is only trusted while it still matches the value; if a module mutated
  // `.value` in place without clearing `.raw`, fall back to fresh formatting.
  if (v.raw !== undefined && Number(v.raw) === v.value) return v.raw;
  return formatVsNumber(v.value, styleForPath(keys));
}

function emitValue(ctx: EmitCtx, v: JsonValue, depth: number): void {
  if (v instanceof VsNum) {
    ctx.out.push(numberText(v, ctx.keys));
    return;
  }
  switch (typeof v) {
    case 'string':
      ctx.out.push(JSON.stringify(v));
      return;
    case 'boolean':
      ctx.out.push(v ? 'true' : 'false');
      return;
    case 'number':
      // Plain numbers are not part of JsonValue, but tolerate sloppy callers gracefully.
      ctx.out.push(formatVsNumber(v, styleForPath(ctx.keys)));
      return;
    default:
      break;
  }
  if (v === null) {
    ctx.out.push('null');
    return;
  }
  if (Array.isArray(v)) {
    const lay = arrayLayouts.get(v);
    if (lay) emitParsedArray(ctx, v, lay, depth);
    else emitFreshArray(ctx, v, depth);
    return;
  }
  const lay = objectLayouts.get(v);
  if (lay) emitParsedObject(ctx, v, lay, depth);
  else emitFreshObject(ctx, v, depth);
}

// --- parsed nodes -----------------------------------------------------------

function emitParsedArray(ctx: EmitCtx, arr: JsonValue[], lay: ArrayLayout, depth: number): void {
  const out = ctx.out;
  out.push('[');
  if (arr.length === 0) {
    out.push(lay.preClose, ']');
    return;
  }
  const lastLay = lay.items[lay.items.length - 1];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i] as JsonValue;
    const it = lay.items[i];
    // Items beyond the original length inherit the last item's spacing style.
    out.push(it?.preValue ?? lastLay?.preValue ?? ' ');
    if (typeof v === 'string' && it?.rawString && it.rawString.value === v) {
      out.push(it.rawString.raw);
    } else {
      emitValue(ctx, v, depth + 1);
    }
    if (i < arr.length - 1) {
      out.push(it?.preComma ?? '', ',');
    } else if (it && it.hadComma && i === lay.items.length - 1) {
      out.push(it.preComma, ','); // preserve the source's trailing comma
    }
  }
  out.push(lay.preClose, ']');
}

function emitParsedObject(ctx: EmitCtx, obj: JsonObject, lay: ObjectLayout, depth: number): void {
  const out = ctx.out;
  type Plan =
    | { kind: 'shadow'; e: ShadowEntryLayout }
    | { kind: 'live'; key: string; e: LiveEntryLayout | undefined };
  const plans: Plan[] = [];
  const planned = new Set<string>();
  for (const e of lay.entries) {
    // Entries whose key was deleted from the object (or set to undefined) are dropped,
    // shadows included — deleting a key removes every source occurrence.
    if (!Object.prototype.hasOwnProperty.call(obj, e.key) || obj[e.key] === undefined) continue;
    if (e.kind === 'shadow') {
      // A shadow (earlier duplicate occurrence) is re-emitted only while the key's live
      // value is still the parse-time one. Once the value is replaced, deleted + re-added,
      // or mutated in place (ops call invalidateShadows), the stale duplicate text would
      // contradict the document — drop it instead of resurrecting it.
      const live = lay.byKey.get(e.key);
      if (live?.originalValue !== undefined && obj[e.key] === live.originalValue.v) {
        plans.push({ kind: 'shadow', e });
      }
    } else if (!planned.has(e.key)) {
      plans.push({ kind: 'live', key: e.key, e });
      planned.add(e.key);
    }
  }
  // Keys added after parse are appended at the end, in insertion order where possible
  // (NB: JS reorders integer-like keys in Object.keys — source order above is unaffected
  // because it comes from the layout, not the object).
  for (const key of Object.keys(obj)) {
    if (!planned.has(key) && obj[key] !== undefined) {
      plans.push({ kind: 'live', key, e: undefined });
      planned.add(key);
    }
  }

  if (lay.entries.length === 0 && plans.length > 0) {
    // The object was empty in the source, so there is no entry layout to splice fresh
    // keys into — emitting them against the parsed empty gap would glue the closing brace
    // to the last value. Emit the whole object in canonical fresh style instead (inline
    // for face / keyframe-element contexts, multi-line elsewhere).
    emitFreshObject(ctx, obj, depth);
    return;
  }
  out.push('{');
  if (plans.length === 0) {
    out.push(lay.preClose, '}');
    return;
  }
  const inferred = inferEntryGaps(lay, depth, ctx.nl);
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]!;
    const isLastPlan = i === plans.length - 1;
    if (plan.kind === 'shadow') {
      const e = plan.e;
      out.push(e.preKey, e.rawKey, e.preColon, ':', e.preValue, e.rawValue);
      pushObjectComma(out, e, isLastPlan);
    } else {
      const e = plan.e;
      out.push(
        e?.preKey ?? inferred.preKey,
        e?.rawKey ?? JSON.stringify(plan.key),
        e?.preColon ?? '',
        ':',
        e?.preValue ?? inferred.preValue,
      );
      const v = obj[plan.key] as JsonValue;
      if (typeof v === 'string' && e?.rawString && e.rawString.value === v) {
        out.push(e.rawString.raw);
      } else {
        ctx.keys.push(plan.key);
        emitValue(ctx, v, depth + 1);
        ctx.keys.pop();
      }
      pushObjectComma(out, e, isLastPlan);
    }
  }
  out.push(lay.preClose, '}');
}

function pushObjectComma(out: string[], e: ObjectEntryLayout | undefined, isLastPlan: boolean): void {
  if (!isLastPlan) {
    out.push(e?.preComma ?? '', ',');
  } else if (e && e.hadComma && e.wasLast) {
    out.push(e.preComma, ','); // the source ended with a trailing comma — keep it
  }
}

function inferEntryGaps(lay: ObjectLayout, depth: number, nl: string): { preKey: string; preValue: string } {
  const last = lay.entries[lay.entries.length - 1];
  if (last) return { preKey: last.preKey, preValue: last.preValue };
  return { preKey: nl + tabs(depth + 1), preValue: ' ' };
}

// --- fresh nodes (canonical VS model-creator style) --------------------------

function isScalar(v: JsonValue): boolean {
  return v === null || typeof v !== 'object' || v instanceof VsNum;
}

/** Face objects and keyframe-element objects are written inline in vanilla files. */
function isInlineObjectContext(keys: string[]): boolean {
  const parent = keys[keys.length - 2];
  if (parent === 'faces') return true;
  return parent === 'elements' && keys[keys.length - 3] === 'keyframes';
}

function emitFreshArray(ctx: EmitCtx, arr: JsonValue[], depth: number): void {
  const out = ctx.out;
  if (arr.length === 0) {
    out.push('[]');
    return;
  }
  if (arr.every(isScalar)) {
    out.push('[ ');
    for (let i = 0; i < arr.length; i++) {
      if (i > 0) out.push(', ');
      emitValue(ctx, arr[i] as JsonValue, depth + 1);
    }
    out.push(' ]');
    return;
  }
  out.push('[');
  for (let i = 0; i < arr.length; i++) {
    out.push(ctx.nl, tabs(depth + 1));
    emitValue(ctx, arr[i] as JsonValue, depth + 1);
    if (i < arr.length - 1) out.push(',');
  }
  out.push(ctx.nl, tabs(depth), ']');
}

function emitFreshObject(ctx: EmitCtx, obj: JsonObject, depth: number): void {
  const out = ctx.out;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (keys.length === 0) {
    // standalone empty objects span two lines, closing brace at the property's indent
    out.push('{', ctx.nl, tabs(depth), '}');
    return;
  }
  if (isInlineObjectContext(ctx.keys)) {
    out.push('{ ');
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if (i > 0) out.push(', ');
      out.push(JSON.stringify(k), ': ');
      ctx.keys.push(k);
      emitValue(ctx, obj[k] as JsonValue, depth + 1);
      ctx.keys.pop();
    }
    out.push(' }');
    return;
  }
  out.push('{');
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    out.push(ctx.nl, tabs(depth + 1), JSON.stringify(k), ': ');
    ctx.keys.push(k);
    emitValue(ctx, obj[k] as JsonValue, depth + 1);
    ctx.keys.pop();
    if (i < keys.length - 1) out.push(',');
  }
  out.push(ctx.nl, tabs(depth), '}');
}

// ---------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------

/**
 * Deep clone preserving VsNum instances (real `VsNum` from types.ts — instanceof holds)
 * and all hidden layout metadata, so `serializeVsJson(cloneJsonValue(v))` equals
 * `serializeVsJson(v)` while the clone is fully independent (used for undo snapshots).
 */
export function cloneJsonValue(v: JsonValue): JsonValue {
  const cloned = cloneNode(v);
  if (v !== null && typeof v === 'object' && cloned !== null && typeof cloned === 'object') {
    const trivia = docTrivia.get(v);
    if (trivia) docTrivia.set(cloned, { ...trivia });
  }
  return cloned;
}

function cloneNode(v: JsonValue): JsonValue {
  if (v instanceof VsNum) return new VsNum(v.value, v.raw);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const out: JsonValue[] = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = cloneNode(v[i] as JsonValue);
    const lay = arrayLayouts.get(v);
    if (lay) {
      arrayLayouts.set(out, {
        items: lay.items.map((it) => ({
          preValue: it.preValue,
          preComma: it.preComma,
          hadComma: it.hadComma,
          ...(it.rawString ? { rawString: { ...it.rawString } } : {}),
        })),
        preClose: lay.preClose,
      });
    }
    return out;
  }
  const out: JsonObject = {};
  for (const k of Object.keys(v)) {
    const val = v[k];
    if (val !== undefined) out[k] = cloneNode(val);
  }
  const lay = objectLayouts.get(v);
  if (lay) {
    const entries: ObjectEntryLayout[] = lay.entries.map((e) =>
      e.kind === 'live'
        ? {
            ...e,
            ...(e.rawString ? { rawString: { ...e.rawString } } : {}),
            // The parse-time-value identity check must keep holding in the clone: when
            // the live value is still the original, point originalValue at the CLONED
            // value; when it was already edited, keep the (now matchless) old reference.
            ...(e.originalValue !== undefined
              ? {
                  originalValue: {
                    v: v[e.key] === e.originalValue.v ? out[e.key]! : e.originalValue.v,
                  },
                }
              : {}),
          }
        : { ...e },
    );
    const byKey = new Map<string, LiveEntryLayout>();
    for (const e of entries) if (e.kind === 'live') byKey.set(e.key, e);
    objectLayouts.set(out, { entries, byKey, preClose: lay.preClose });
  }
  return out;
}
