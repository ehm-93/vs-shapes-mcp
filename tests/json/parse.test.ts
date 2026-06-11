import { describe, expect, it } from 'vitest';
import { parseVsJson, serializeVsJson, VsJsonParseError } from '../../src/vs/json.js';
import { VsNum } from '../../src/vs/types.js';
import type { JsonObject } from '../../src/vs/types.js';

const rt = (text: string) => serializeVsJson(parseVsJson(text));

describe('parseVsJson — literal preservation', () => {
  it('preserves exact number literals through round-trip', () => {
    const text = '{ "a": 1.0, "b": 1, "c": -0.5, "d": 1e-7, "e": 270, "f": -0, "g": 5.008955855952477E-6, "h": -7.0E-4, "i": -0.0 }';
    expect(rt(text)).toBe(text);
  });

  it('wraps numbers as VsNum with raw + value', () => {
    const obj = parseVsJson('{"x": 1.0, "y": -0, "z": 1e-7}') as JsonObject;
    const x = obj['x'] as VsNum;
    expect(x).toBeInstanceOf(VsNum);
    expect(x.value).toBe(1);
    expect(x.raw).toBe('1.0');
    const y = obj['y'] as VsNum;
    expect(Object.is(y.value, -0)).toBe(true);
    expect(y.raw).toBe('-0');
    const z = obj['z'] as VsNum;
    expect(z.value).toBe(1e-7);
    expect(z.raw).toBe('1e-7');
  });

  it('distinguishes 1.0 from 1 even though values are equal', () => {
    const a = parseVsJson('1.0') as VsNum;
    const b = parseVsJson('1') as VsNum;
    expect(a.value).toBe(b.value);
    expect(serializeVsJson(a)).toBe('1.0');
    expect(serializeVsJson(b)).toBe('1');
  });

  it('preserves object key order, including integer-like keys', () => {
    // JS objects reorder integer-like keys in Object.keys; layout order must win.
    const text = '{ "zebra": 1, "2": 2, "alpha": 3, "0": 4 }';
    expect(rt(text)).toBe(text);
  });

  it('preserves escaped strings byte-for-byte and decodes their values', () => {
    const text = '{ "k\\u0041": "a\\nb\\t\\"q\\"\\u00e9\\/" }';
    const obj = parseVsJson(text) as JsonObject;
    expect(obj['kA']).toBe('a\nb\t"q"é/');
    expect(rt(text)).toBe(text);
  });

  it('accepts and preserves unquoted property names (vanilla block files)', () => {
    const text = '{\n    textures: {\n    },\n    elements: [ { glow: 128 } ]\n}';
    const obj = parseVsJson(text) as JsonObject;
    expect(Object.keys(obj)).toEqual(['textures', 'elements']);
    expect(rt(text)).toBe(text);
  });

  it('accepts and preserves trailing commas in objects and arrays (vanilla entity files)', () => {
    const obj = '{ "a": 1, "b": 2, }';
    const arr = '{ "a": [ 1, 2, ] }';
    expect(rt(obj)).toBe(obj);
    expect(rt(arr)).toBe(arr);
  });

  it('handles duplicate keys: last occurrence wins, all occurrences round-trip', () => {
    const text = '{ "a": 1, "b": { "x": 1.5 }, "a": 3 }';
    const obj = parseVsJson(text) as JsonObject;
    expect((obj['a'] as VsNum).value).toBe(3); // Newtonsoft/engine semantics
    expect(rt(text)).toBe(text);
  });

  it('preserves leading/trailing trivia, BOM, LF endings, trailing spaces', () => {
    const samples = [
      '﻿{ "a": 1 }',
      '\n\n{ "a": 1 }\n',
      '{\n\t"a": [ 1.0, 2.0 ], \n\t"b": 2\n}', // trailing space after comma, LF only
      '{\r\n\t"a": 1\r\n}\r\n',
      '{}',
      '{\r\n}',
      '{  }',
      '[]',
      '[ ]',
    ];
    for (const s of samples) expect(rt(s)).toBe(s);
  });

  it('round-trips a realistic model-creator style document', () => {
    const text =
      '{\r\n' +
      '\t"editor": {\r\n\t\t"allAngles": false\r\n\t},\r\n' +
      '\t"textureWidth": 16,\r\n' +
      '\t"textureSizes": {\r\n\t},\r\n' +
      '\t"textures": {\r\n\t\t"rope": "item/resource/rope"\r\n\t},\r\n' +
      '\t"elements": [\r\n' +
      '\t\t{\r\n' +
      '\t\t\t"name": "rope",\r\n' +
      '\t\t\t"from": [ 0.6, -0.4, -0.4 ], \r\n' +
      '\t\t\t"to": [ 1.6, 3.4, 3.4 ],\r\n' +
      '\t\t\t"faces": {\r\n' +
      '\t\t\t\t"north": { "texture": "#rope", "uv": [ 0.0, 0.0, 1.0, 3.5 ], "rotation": 270 }\r\n' +
      '\t\t\t}\r\n' +
      '\t\t}\r\n' +
      '\t]}';
    expect(rt(text)).toBe(text);
  });
});

describe('parseVsJson — errors (position-bearing, actionable)', () => {
  const failsWith = (text: string, parts: (string | RegExp)[]) => {
    let err: unknown;
    try {
      parseVsJson(text);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VsJsonParseError);
    const msg = (err as Error).message;
    for (const p of parts) {
      if (typeof p === 'string') expect(msg).toContain(p);
      else expect(msg).toMatch(p);
    }
    return err as VsJsonParseError;
  };

  it('rejects // comments with line/column and a fix', () => {
    const e = failsWith('{\r\n    // generated\r\n\t"a": 1\r\n}', [
      'line 2',
      'column 5',
      'comment',
      'not allowed',
    ]);
    expect(e.line).toBe(2);
    expect(e.column).toBe(5);
  });

  it('rejects /* */ comments', () => {
    failsWith('{ "a": /* one */ 1 }', ['comment', 'not allowed']);
  });

  it('rejects trailing garbage after the document', () => {
    const e = failsWith('{ "a": 1 } extra', [
      'unexpected content after the end of the JSON document',
      'line 1',
      'exactly one top-level value',
    ]);
    expect(e.column).toBe(12);
  });

  it('rejects unterminated strings', () => {
    failsWith('{ "a": "oops }', ['unterminated string', `closing '"'`]);
  });

  it('rejects invalid escapes', () => {
    failsWith('{ "a": "x\\q" }', ['invalid string escape', '\\q']);
    failsWith('{ "a": "x\\u00zz" }', ['invalid unicode escape', 'four hex digits']);
  });

  it('rejects malformed literals and numbers', () => {
    failsWith('{ "a": tru }', ["expected 'true'"]);
    failsWith('{ "a": 1e }', ['exponent']);
    failsWith('{ "a": - }', ['number']);
  });

  it('rejects structural errors naming the offending key', () => {
    failsWith('{ "a" 1 }', [`expected ':' after property name "a"`]);
    failsWith('{ "a": 1 "b": 2 }', [`expected ',' or '}' after the value of "a"`]);
    failsWith('{ "a": [1 2] }', [`expected ',' or ']'`]);
  });

  it('rejects truncated documents', () => {
    failsWith('', ['empty']);
    failsWith('   ', ['empty']);
    failsWith('{ "a": ', ['end of file']);
    failsWith('{ "a": 1', [`expected ',' or '}'`]);
    failsWith('[1, 2', [`expected ',' or ']'`]);
  });
});

describe("'+'-signed numbers (Newtonsoft rejects them — so must we)", () => {
  it("rejects '+5' with a position-bearing error instead of silently re-saving an unloadable file", () => {
    // Newtonsoft (the engine's parser) throws 'Unexpected character encountered while
    // parsing value: +' — accepting it here would validate-clean and re-save a file the
    // game cannot load.
    expect(() => parseVsJson('{ "d": +5 }')).toThrowError(VsJsonParseError);
    expect(() => parseVsJson('{ "d": +5 }')).toThrowError(/\+/);
    expect(() => parseVsJson('{ "d": +5.25 }')).toThrowError(/Newtonsoft/);
  });

  it("still accepts '.5', '5.' and exponent signs (Newtonsoft/.NET double parsing does)", () => {
    expect((parseVsJson('{ "a": .5 }') as JsonObject)['a']).toMatchObject({ value: 0.5 });
    expect((parseVsJson('{ "a": 5. }') as JsonObject)['a']).toMatchObject({ value: 5 });
    expect((parseVsJson('{ "a": 1e+3 }') as JsonObject)['a']).toMatchObject({ value: 1000 });
    expect((parseVsJson('{ "a": -2 }') as JsonObject)['a']).toMatchObject({ value: -2 });
  });
});
