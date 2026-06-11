import { describe, expect, it } from 'vitest';
import { cloneJsonValue, formatVsNumber, invalidateShadows, parseVsJson, serializeVsJson, vsnum, numValue } from '../../src/vs/json.js';
import type { JsonObject, JsonValue } from '../../src/vs/types.js';

describe('formatVsNumber', () => {
  it('formats double style with trailing .0 for integral values', () => {
    expect(formatVsNumber(4, 'double')).toBe('4.0');
    expect(formatVsNumber(-3, 'double')).toBe('-3.0');
    expect(formatVsNumber(0, 'double')).toBe('0.0');
    expect(formatVsNumber(-0, 'double')).toBe('-0.0');
    expect(formatVsNumber(0.5, 'double')).toBe('0.5');
    expect(formatVsNumber(-0.5, 'double')).toBe('-0.5');
    expect(formatVsNumber(1e-7, 'double')).toBe('1e-7');
  });

  it('formats int style as plain integers', () => {
    expect(formatVsNumber(270, 'int')).toBe('270');
    expect(formatVsNumber(-90, 'int')).toBe('-90');
    expect(formatVsNumber(-0, 'int')).toBe('0');
    // a non-integral value cannot lie about itself
    expect(formatVsNumber(2.5, 'int')).toBe('2.5');
  });

  it('formats auto style by integrality', () => {
    expect(formatVsNumber(16, 'auto')).toBe('16');
    expect(formatVsNumber(0.25, 'auto')).toBe('0.25');
  });

  it('rejects non-finite numbers with an actionable error', () => {
    expect(() => formatVsNumber(Number.NaN, 'auto')).toThrow(/non-finite/);
    expect(() => formatVsNumber(Infinity, 'double')).toThrow(/finite value/);
  });
});

describe('vsnum / numValue', () => {
  it('wraps and unwraps', () => {
    const n = vsnum(3.5);
    expect(numValue(n)).toBe(3.5);
    expect(n.raw).toBeUndefined();
  });
});

describe('serializeVsJson — fresh trees (canonical VS model-creator style)', () => {
  it('serializes a fresh shape document with CRLF, tabs, inline rules and field number styles', () => {
    const doc: JsonObject = {
      textureWidth: vsnum(32),
      textureHeight: vsnum(32),
      textureSizes: {},
      textures: { skin: 'entity/animal/fox' },
      elements: [
        {
          name: 'body',
          from: [vsnum(1), vsnum(0), vsnum(2.5)],
          to: [vsnum(9), vsnum(8), vsnum(10)],
          rotationOrigin: [vsnum(5), vsnum(4), vsnum(6)],
          rotationX: vsnum(-90),
          faces: {
            north: { texture: '#skin', uv: [vsnum(0), vsnum(4), vsnum(4), vsnum(8)], rotation: vsnum(270) },
          },
          children: [],
        },
      ],
      animations: [
        {
          name: 'walk',
          code: 'walk',
          quantityframes: vsnum(30),
          onAnimationEnd: 'Repeat',
          keyframes: [
            { frame: vsnum(0), elements: { body: { offsetX: vsnum(1), rotationZ: vsnum(0.5) } } },
          ],
        },
      ],
    };
    const expected =
      '{\r\n' +
      '\t"textureWidth": 32,\r\n' +
      '\t"textureHeight": 32,\r\n' +
      '\t"textureSizes": {\r\n' +
      '\t},\r\n' +
      '\t"textures": {\r\n' +
      '\t\t"skin": "entity/animal/fox"\r\n' +
      '\t},\r\n' +
      '\t"elements": [\r\n' +
      '\t\t{\r\n' +
      '\t\t\t"name": "body",\r\n' +
      '\t\t\t"from": [ 1.0, 0.0, 2.5 ],\r\n' +
      '\t\t\t"to": [ 9.0, 8.0, 10.0 ],\r\n' +
      '\t\t\t"rotationOrigin": [ 5.0, 4.0, 6.0 ],\r\n' +
      '\t\t\t"rotationX": -90.0,\r\n' +
      '\t\t\t"faces": {\r\n' +
      '\t\t\t\t"north": { "texture": "#skin", "uv": [ 0.0, 4.0, 4.0, 8.0 ], "rotation": 270 }\r\n' +
      '\t\t\t},\r\n' +
      '\t\t\t"children": []\r\n' +
      '\t\t}\r\n' +
      '\t],\r\n' +
      '\t"animations": [\r\n' +
      '\t\t{\r\n' +
      '\t\t\t"name": "walk",\r\n' +
      '\t\t\t"code": "walk",\r\n' +
      '\t\t\t"quantityframes": 30,\r\n' +
      '\t\t\t"onAnimationEnd": "Repeat",\r\n' +
      '\t\t\t"keyframes": [\r\n' +
      '\t\t\t\t{\r\n' +
      '\t\t\t\t\t"frame": 0,\r\n' +
      '\t\t\t\t\t"elements": {\r\n' +
      '\t\t\t\t\t\t"body": { "offsetX": 1.0, "rotationZ": 0.5 }\r\n' +
      '\t\t\t\t\t}\r\n' +
      '\t\t\t\t}\r\n' +
      '\t\t\t]\r\n' +
      '\t\t}\r\n' +
      '\t]\r\n' +
      '}';
    expect(serializeVsJson(doc)).toBe(expected);
  });

  it('honors the newline option for fresh trees', () => {
    const doc: JsonObject = { a: vsnum(1) };
    expect(serializeVsJson(doc, { newline: '\n' })).toBe('{\n\t"a": 1\n}');
    expect(serializeVsJson(doc)).toBe('{\r\n\t"a": 1\r\n}');
  });

  it('serializes a parsed-then-reserialized fresh doc identically (stability)', () => {
    const doc: JsonObject = { textures: { x: 'a/b' }, elements: [] };
    const once = serializeVsJson(doc);
    expect(serializeVsJson(parseVsJson(once))).toBe(once);
  });
});

describe('serializeVsJson — hybrid (edits inside parsed trees)', () => {
  const source =
    '{\r\n' +
    '\t"textureWidth": 16,\r\n' +
    '\t"elements": [\r\n' +
    '\t\t{\r\n' +
    '\t\t\t"name": "body",\r\n' +
    '\t\t\t"from": [ 1.0, 2.0, 3.0 ],\r\n' +
    '\t\t\t"faces": {\r\n' +
    '\t\t\t\t"north": { "texture": "#skin", "uv": [ 0.0, 0.0, 4.0, 4.0 ] }\r\n' +
    '\t\t\t}\r\n' +
    '\t\t}\r\n' +
    '\t]\r\n' +
    '}';

  it('replacing one number changes only that literal', () => {
    const doc = parseVsJson(source) as JsonObject;
    const el = (doc['elements'] as JsonValue[])[0] as JsonObject;
    (el['from'] as JsonValue[])[1] = vsnum(7); // 'from' field → double style
    expect(serializeVsJson(doc)).toBe(source.replace('[ 1.0, 2.0, 3.0 ]', '[ 1.0, 7.0, 3.0 ]'));
  });

  it('adding a key to a parsed object matches sibling separators', () => {
    const doc = parseVsJson(source) as JsonObject;
    doc['textureHeight'] = vsnum(16);
    const out = serializeVsJson(doc);
    expect(out).toContain('\t"elements": [\r\n');
    expect(out.endsWith('\t],\r\n\t"textureHeight": 16\r\n}')).toBe(true);
  });

  it('adding a fresh face to a parsed faces object emits an inline face object', () => {
    const doc = parseVsJson(source) as JsonObject;
    const el = (doc['elements'] as JsonValue[])[0] as JsonObject;
    const faces = el['faces'] as JsonObject;
    faces['up'] = { texture: '#skin', uv: [vsnum(0), vsnum(0), vsnum(4), vsnum(4)], rotation: vsnum(90) };
    const out = serializeVsJson(doc);
    expect(out).toContain(
      '\t\t\t\t"north": { "texture": "#skin", "uv": [ 0.0, 0.0, 4.0, 4.0 ] },\r\n' +
        '\t\t\t\t"up": { "texture": "#skin", "uv": [ 0.0, 0.0, 4.0, 4.0 ], "rotation": 90 }\r\n',
    );
  });

  it('deleting a key drops it without disturbing neighbors', () => {
    const doc = parseVsJson('{ "a": 1, "b": 2, "c": 3 }') as JsonObject;
    delete doc['b'];
    expect(serializeVsJson(doc)).toBe('{ "a": 1, "c": 3 }');
  });

  it('appending to a parsed inline array reuses its spacing style', () => {
    const doc = parseVsJson('{ "uv": [ 1.0, 2.0 ] }') as JsonObject;
    (doc['uv'] as JsonValue[]).push(vsnum(3));
    expect(serializeVsJson(doc)).toBe('{ "uv": [ 1.0, 2.0, 3.0 ] }');
  });

  it('fresh nodes inside an LF-parsed document use LF', () => {
    const doc = parseVsJson('{\n\t"a": 1\n}') as JsonObject;
    doc['editor'] = { allAngles: false };
    expect(serializeVsJson(doc)).toBe('{\n\t"a": 1,\n\t"editor": {\n\t\t"allAngles": false\n\t}\n}');
  });

  it('falls back to fresh formatting when a VsNum value was mutated without clearing raw', () => {
    const doc = parseVsJson('{ "frame": 5 }') as JsonObject;
    const n = doc['frame'] as { value: number; raw?: string };
    n.value = 9; // stale raw '5'
    expect(serializeVsJson(doc)).toBe('{ "frame": 9 }');
  });
});

describe('duplicate-key shadows: stale text never survives an edit', () => {
  it('replacing a duplicated key drops the shadow occurrence (no contradicting old line)', () => {
    const obj = parseVsJson('{ "name": "a", "name": "b" }') as JsonObject;
    obj['name'] = 'replaced';
    expect(serializeVsJson(obj)).toBe('{ "name": "replaced" }');
  });

  it('an UNEDITED duplicated key still round-trips both occurrences byte-identically', () => {
    const text = '{ "name": "a", "z": 1, "name": "b" }';
    expect(serializeVsJson(parseVsJson(text))).toBe(text);
  });

  it('delete then re-add does not resurrect the deleted shadow', () => {
    const obj = parseVsJson('{ "name": "a", "name": "b", "z": 1 }') as JsonObject;
    delete obj['name'];
    expect(serializeVsJson(obj)).toBe('{ "z": 1 }');
    // The re-added key reuses its parse-time layout slot — but the shadow stays gone.
    obj['name'] = 'new';
    expect(serializeVsJson(obj)).toBe('{ "name": "new", "z": 1 }');
  });

  it('clones keep shadow tracking intact: unedited clones round-trip, edited clones drop shadows', () => {
    const text = '{ "a": { "x": 1 }, "a": { "x": 2 } }';
    const obj = parseVsJson(text) as JsonObject;
    const clone = cloneJsonValue(obj) as JsonObject;
    expect(serializeVsJson(clone)).toBe(text);
    clone['a'] = { x: vsnum(3) };
    expect(serializeVsJson(clone)).toContain('"x": 3');
    expect(serializeVsJson(clone)).not.toContain('"x": 2');
    // the original is untouched
    expect(serializeVsJson(obj)).toBe(text);
  });

  it('invalidateShadows drops shadows after an in-place mutation the serializer cannot see', () => {
    // The alewife-adult.json pattern: a duplicated element key in a keyframe map whose
    // live entry is mutated IN PLACE (anim_set_keyframe style) — identity unchanged.
    const text = '{ "Rear": { "rotationY": 20.0 }, "Rear": { "rotationY": 99.0 } }';
    const obj = parseVsJson(text) as JsonObject;
    (obj['Rear'] as JsonObject)['rotationY'] = vsnum(45);
    invalidateShadows(obj, 'Rear');
    const out = serializeVsJson(obj);
    expect(out).toContain('"rotationY": 45');
    expect(out).not.toContain('20.0'); // the stale duplicate of the line just edited is gone
  });
});

describe('adding keys to a parse-empty object emits canonical fresh style', () => {
  it('a source-empty {} gaining a key closes the brace on its own line (no glue)', () => {
    const obj = parseVsJson('{\r\n\t"textures": {}\r\n}') as JsonObject;
    (obj['textures'] as JsonObject)['skin'] = 'entity/foo';
    expect(serializeVsJson(obj)).toBe(
      '{\r\n\t"textures": {\r\n\t\t"skin": "entity/foo"\r\n\t}\r\n}',
    );
  });

  it('a parse-empty keyframe-element object gains channels INLINE (vanilla style)', () => {
    // The vanilla `"origin": {  }` pattern: setKeyframe reuses the parsed empty entry —
    // the result must match the inline keyframe-element convention, not glue `  }`.
    const text =
      '{\r\n\t"animations": [\r\n\t\t{\r\n\t\t\t"keyframes": [\r\n\t\t\t\t{\r\n\t\t\t\t\t"elements": {\r\n\t\t\t\t\t\t"origin": {  }\r\n\t\t\t\t\t}\r\n\t\t\t\t}\r\n\t\t\t]\r\n\t\t}\r\n\t]\r\n}';
    const obj = parseVsJson(text) as JsonObject;
    const anims = obj['animations'] as JsonValue[];
    const kf = (anims[0] as JsonObject)['keyframes'] as JsonValue[];
    const els = (kf[0] as JsonObject)['elements'] as JsonObject;
    const origin = els['origin'] as JsonObject;
    origin['rotationX'] = vsnum(5);
    origin['rotationY'] = vsnum(0);
    origin['rotationZ'] = vsnum(0);
    expect(serializeVsJson(obj)).toContain(
      '"origin": { "rotationX": 5.0, "rotationY": 0.0, "rotationZ": 0.0 }',
    );
  });

  it('untouched parse-empty objects still round-trip byte-identically', () => {
    for (const text of ['{ "t": {} }', '{ "t": {  } }', '{\r\n\t"t": {\r\n\t}\r\n}']) {
      expect(serializeVsJson(parseVsJson(text))).toBe(text);
    }
  });
});
