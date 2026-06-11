import { describe, expect, it } from 'vitest';
import { cloneJsonValue, parseVsJson, serializeVsJson, vsnum } from '../../src/vs/json.js';
import { VsNum } from '../../src/vs/types.js';
import type { JsonObject, JsonValue } from '../../src/vs/types.js';

const SOURCE =
  '{\r\n' +
  '\t"textureWidth": 16,\r\n' +
  '\t"dup": 1, "dup": 2,\r\n' + // duplicate key → shadow entry in layout
  '\t"elements": [\r\n' +
  '\t\t{ "name": "a", "from": [ 1.0, 2.0, 3.0 ], }\r\n' + // trailing comma
  '\t]\r\n' +
  '}';

describe('cloneJsonValue', () => {
  it('clones VsNum as real instances (instanceof holds) with raw preserved', () => {
    const doc = parseVsJson(SOURCE) as JsonObject;
    const clone = cloneJsonValue(doc) as JsonObject;
    const orig = doc['textureWidth'] as VsNum;
    const copy = clone['textureWidth'] as VsNum;
    expect(copy).toBeInstanceOf(VsNum);
    expect(copy).not.toBe(orig);
    expect(copy.value).toBe(16);
    expect(copy.raw).toBe('16');
  });

  it('clone serializes byte-identically, including layout metadata (dups, trailing commas)', () => {
    const doc = parseVsJson(SOURCE);
    const clone = cloneJsonValue(doc);
    expect(serializeVsJson(clone)).toBe(SOURCE);
    expect(serializeVsJson(doc)).toBe(SOURCE);
  });

  it('clone is fully independent: mutations do not leak either way', () => {
    const doc = parseVsJson(SOURCE) as JsonObject;
    const clone = cloneJsonValue(doc) as JsonObject;

    // mutate the clone
    clone['textureWidth'] = vsnum(64);
    const cloneEl = ((clone['elements'] as JsonValue[])[0]) as JsonObject;
    (cloneEl['from'] as JsonValue[])[0] = vsnum(9);
    cloneEl['name'] = 'renamed';
    delete clone['dup'];
    (clone['elements'] as JsonValue[]).push({ name: 'b', from: [vsnum(0), vsnum(0), vsnum(0)] });

    // original is untouched
    expect(serializeVsJson(doc)).toBe(SOURCE);

    // and mutating the original does not affect the clone's serialization
    const before = serializeVsJson(clone);
    (doc['elements'] as JsonValue[]).length = 0;
    doc['textureWidth'] = vsnum(128);
    expect(serializeVsJson(clone)).toBe(before);
  });

  it('clones fresh (layout-less) trees and primitives', () => {
    expect(cloneJsonValue(null)).toBeNull();
    expect(cloneJsonValue('x')).toBe('x');
    expect(cloneJsonValue(true)).toBe(true);
    const fresh: JsonObject = { a: vsnum(1), b: [vsnum(2)], c: { d: 'e' } };
    const clone = cloneJsonValue(fresh) as JsonObject;
    expect(serializeVsJson(clone)).toBe(serializeVsJson(fresh));
    (clone['b'] as JsonValue[]).push(vsnum(3));
    expect((fresh['b'] as JsonValue[]).length).toBe(1);
  });

  it('snapshot/restore round: serializing a clone after heavy edits to the source', () => {
    const doc = parseVsJson(SOURCE) as JsonObject;
    const snapshot = cloneJsonValue(doc);
    // trash the original
    for (const k of Object.keys(doc)) delete doc[k];
    expect(serializeVsJson(snapshot)).toBe(SOURCE);
  });
});
