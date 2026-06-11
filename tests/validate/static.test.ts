/**
 * Fast (static) validation checks — one synthetic fixture per finding code, asserting the
 * stable code, the severity, and that the finding names the entities involved.
 */
import { describe, expect, it } from 'vitest';

import { validateDocument, JOINT_WARN_CAP } from '../../src/vs/validate.js';
import { VsNum, type Finding, type ShapeJson } from '../../src/vs/types.js';

/** Deep-wraps every number into a VsNum, mimicking the lossless parser's output. */
function wrapNums(value: unknown): unknown {
  if (typeof value === 'number') return new VsNum(value);
  if (Array.isArray(value)) return value.map(wrapNums);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = wrapNums(v);
    return out;
  }
  return value;
}

const shape = (raw: unknown): ShapeJson => wrapNums(raw) as ShapeJson;

/** A well-formed element with one in-bounds face referencing '#skin'. */
const okElement = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  from: [0, 0, 0],
  to: [4, 4, 4],
  faces: { north: { texture: '#skin', uv: [0, 0, 4, 4] } },
  ...extra,
});

const baseShape = (elements: unknown[], animations?: unknown[]): ShapeJson =>
  shape({
    textureWidth: 32,
    textureHeight: 32,
    textures: { skin: 'entity/test/skin' },
    elements,
    ...(animations !== undefined ? { animations } : {}),
  });

const byCode = (findings: Finding[], code: string): Finding[] =>
  findings.filter((f) => f.code === code);

const one = (findings: Finding[], code: string): Finding => {
  const hits = byCode(findings, code);
  expect(hits, `expected exactly one ${code}, got: ${JSON.stringify(findings)}`).toHaveLength(1);
  return hits[0]!;
};

describe('shape/* checks', () => {
  it('shape/inverted-box: from > to errors and names the element, axis and swap fix', () => {
    const doc = baseShape([okElement('bad', { from: [5, 0, 0], to: [3, 4, 4] })]);
    const f = one(validateDocument(doc), 'shape/inverted-box');
    expect(f.severity).toBe('error');
    expect(f.element).toBe('bad');
    expect(f.message).toContain("'bad'");
    expect(f.message).toContain('X');
    expect(f.fix).toContain('Swap');
    expect(f.fix).toContain('5');
    expect(f.fix).toContain('3');
  });

  it('shape/zero-thickness: from == to on one axis is a note (legal, vanilla planes)', () => {
    const doc = baseShape([okElement('ear', { from: [0, 0, 2], to: [4, 4, 2] })]);
    const f = one(validateDocument(doc), 'shape/zero-thickness');
    expect(f.severity).toBe('note');
    expect(f.element).toBe('ear');
    expect(f.message).toContain('Z');
    expect(byCode(validateDocument(doc), 'shape/inverted-box')).toHaveLength(0);
  });

  it('shape/zero-thickness: zero on all three axes notes that no faces are emitted', () => {
    const doc = baseShape([okElement('origin', { from: [8, 0, 8], to: [8, 0, 8] })]);
    const f = one(validateDocument(doc), 'shape/zero-thickness');
    expect(f.message).toContain('no faces');
  });

  it('shape/malformed-box: a 2-entry from array errors instead of crashing', () => {
    const doc = baseShape([okElement('broken', { from: [0, 0] })]);
    const f = one(validateDocument(doc), 'shape/malformed-box');
    expect(f.severity).toBe('error');
    expect(f.element).toBe('broken');
  });

  it('shape/dup-name: duplicate names error, naming both locations', () => {
    const doc = baseShape([
      okElement('body', { children: [okElement('leg')] }),
      okElement('leg'),
    ]);
    const f = one(validateDocument(doc), 'shape/dup-name');
    expect(f.severity).toBe('error');
    expect(f.element).toBe('leg');
    expect(f.message).toContain('2 elements');
    expect(f.message).toContain("under 'body'");
    expect(f.message).toContain('at root level');
    expect(f.fix).toContain('Rename');
  });
});

describe('uv/* and tex/* checks', () => {
  it('uv/out-of-bounds: uv beyond textureWidth errors with the bounds and a clamp fix', () => {
    const doc = baseShape([
      okElement('body', { faces: { north: { texture: '#skin', uv: [0, 4, 40, 8] } } }),
    ]);
    const f = one(validateDocument(doc), 'uv/out-of-bounds');
    expect(f.severity).toBe('error');
    expect(f.element).toBe('body');
    expect(f.message).toContain("'north'");
    expect(f.message).toContain('32');
    expect(f.fix).toContain('[0, 4, 32, 8]');
  });

  it('uv/out-of-bounds: textureWidth/Height default to 16 when absent', () => {
    const doc = shape({
      textures: { skin: 'x' },
      elements: [okElement('body', { faces: { north: { texture: '#skin', uv: [0, 0, 20, 8] } } })],
    });
    const f = one(validateDocument(doc), 'uv/out-of-bounds');
    expect(f.message).toContain('16');
  });

  it('uv/inverted: u1 > u2 is a NOTE describing mirrored sampling (the engine accepts it)', () => {
    const doc = baseShape([
      okElement('body', { faces: { up: { texture: '#skin', uv: [8, 0, 4, 4] } } }),
    ]);
    const f = one(validateDocument(doc), 'uv/inverted');
    expect(f.severity).toBe('note'); // vanilla mirrors textures this way — never an error
    expect(f.element).toBe('body');
    expect(f.message).toContain("'up'");
    expect(f.message).toContain('MIRRORED');
    // No prescribed "reorder" fix: applying one would silently un-mirror intended art.
    expect(f.fix).toBeUndefined();
  });

  it('uv/malformed: a 3-entry uv warns (engine drops the face)', () => {
    const doc = baseShape([
      okElement('body', { faces: { north: { texture: '#skin', uv: [0, 0, 4] } } }),
    ]);
    const f = one(validateDocument(doc), 'uv/malformed');
    expect(f.severity).toBe('warn');
    expect(f.element).toBe('body');
  });

  it('uv/bad-rotation: negative rotation errors with the equivalent positive fix', () => {
    const doc = baseShape([
      okElement('body', {
        faces: { north: { texture: '#skin', uv: [0, 0, 4, 4], rotation: -90 } },
      }),
    ]);
    const f = one(validateDocument(doc), 'uv/bad-rotation');
    expect(f.severity).toBe('error');
    expect(f.element).toBe('body');
    expect(f.fix).toContain('270');
  });

  it('tex/dangling-key: an unmapped #key warns (non-empty map) and lists the available keys', () => {
    const doc = baseShape([
      okElement('body', { faces: { north: { texture: '#fur', uv: [0, 0, 4, 4] } } }),
    ]);
    const f = one(validateDocument(doc), 'tex/dangling-key');
    // warn, not error: the engine never throws here — the key may be supplied by the
    // consuming block/item/entity type; unresolved keys log + render the unknown-texture
    // placeholder (Lib:155604-155662).
    expect(f.severity).toBe('warn');
    expect(f.element).toBe('body');
    expect(f.message).toContain("'#fur'");
    expect(f.message).toContain("'skin'");
    expect(f.fix).toContain('#skin');
  });

  it('tex/dangling-key: with an EMPTY textures map it is a note (type-supplied textures pattern)', () => {
    const doc = shape({
      textureWidth: 32,
      textureHeight: 32,
      textures: {},
      elements: [okElement('body', { faces: { north: { texture: '#fur', uv: [0, 0, 4, 4] } } })],
    });
    const f = one(validateDocument(doc), 'tex/dangling-key');
    expect(f.severity).toBe('note');
    expect(f.message).toContain('block/item/entity type');
  });

  it("tex/missing-hash: a face texture without '#' errors (engine strips the first char unconditionally)", () => {
    const doc = baseShape([
      okElement('body', { faces: { north: { texture: 'skin', uv: [0, 0, 4, 4] } } }),
    ]);
    const findings = validateDocument(doc);
    const f = one(findings, 'tex/missing-hash');
    expect(f.severity).toBe('error');
    expect(f.element).toBe('body');
    expect(f.message).toContain("'kin'"); // the in-game mangled key (API:148715)
    expect(f.fix).toContain('#skin');
    // No double report for the same face: the dangling check is skipped.
    expect(byCode(findings, 'tex/dangling-key')).toHaveLength(0);
  });

  it("shape/face-key: non-canonical face keys error, naming the engine's first-letter resolution", () => {
    const doc = baseShape([
      okElement('body', {
        faces: {
          n: { texture: '#skin', uv: [0, 0, 4, 4] },
          North: { texture: '#skin', uv: [0, 0, 4, 4] },
        },
      }),
    ]);
    const findings = byCode(validateDocument(doc), 'shape/face-key');
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.severity).toBe('error');
      expect(f.message).toContain('first letter');
      expect(f.fix).toContain("'north'");
    }
  });

  it('uv/out-of-bounds honors the per-key textureSizes override (engine picks size per face key)', () => {
    // textureWidth 16 / textureHeight 8, but 'skin' is overridden to 16x16: v up to 12 is
    // valid in 16x16 space (the vanilla pile-tools1.json pattern) — flagging it was a
    // false positive in 95% of vanilla occurrences.
    const mk = (uv: number[]): ShapeJson =>
      shape({
        textureWidth: 16,
        textureHeight: 8,
        textureSizes: { skin: [16, 16] },
        textures: { skin: 'x' },
        elements: [okElement('body', { faces: { north: { texture: '#skin', uv } } })],
      });
    expect(byCode(validateDocument(mk([0, 10.5, 6, 12])), 'uv/out-of-bounds')).toHaveLength(0);
    // …while a rect beyond the override still errors, naming the override.
    const f = one(validateDocument(mk([0, 10.5, 6, 20])), 'uv/out-of-bounds');
    expect(f.message).toContain("textureSizes['skin']");
    expect(f.message).toContain('16×16');
  });

  it('tex/dangling-key: disabled faces are skipped (engine drops them at load)', () => {
    // Vanilla hawk.json keeps '#null' refs on enabled:false faces — must not error.
    const doc = baseShape([
      okElement('marker', {
        faces: { north: { texture: '#null', uv: [0, 0, 99, 99], enabled: false } },
      }),
    ]);
    const findings = validateDocument(doc);
    expect(byCode(findings, 'tex/dangling-key')).toHaveLength(0);
    expect(byCode(findings, 'uv/out-of-bounds')).toHaveLength(0);
  });
});

describe('anim/* static checks', () => {
  const key = (frame: number, elements: Record<string, unknown>): Record<string, unknown> => ({
    frame,
    elements,
  });
  const fullRot = (x: number): Record<string, unknown> => ({
    rotationX: x,
    rotationY: 0,
    rotationZ: 0,
  });

  it('anim/dup-code: two animations with the same effective code (code defaults to name)', () => {
    const doc = baseShape(
      [okElement('body')],
      [
        { name: 'walk', quantityframes: 10, keyframes: [key(0, { body: fullRot(0) })] },
        { name: 'Walk 2', code: 'walk', quantityframes: 10, keyframes: [key(0, { body: fullRot(0) })] },
      ],
    );
    const f = one(validateDocument(doc), 'anim/dup-code');
    expect(f.severity).toBe('error');
    expect(f.animation).toBe('walk');
    expect(f.message).toContain("'walk'");
    expect(f.message).toContain("'Walk 2'");
  });

  it('anim/no-keyframes: an empty keyframes array errors (engine throws at load)', () => {
    const doc = baseShape([okElement('body')], [{ name: 'idle', quantityframes: 10, keyframes: [] }]);
    const f = one(validateDocument(doc), 'anim/no-keyframes');
    expect(f.severity).toBe('error');
    expect(f.animation).toBe('idle');
  });

  it('anim/frame-overflow: quantityframes ≤ max keyframe frame errors with the raise fix', () => {
    const doc = baseShape(
      [okElement('body')],
      [
        {
          name: 'walk',
          quantityframes: 10,
          keyframes: [key(0, { body: fullRot(0) }), key(10, { body: fullRot(45) })],
        },
      ],
    );
    const f = one(validateDocument(doc), 'anim/frame-overflow');
    expect(f.severity).toBe('error');
    expect(f.animation).toBe('walk');
    expect(f.frame).toBe(10);
    expect(f.message).toContain('strictly greater');
    expect(f.fix).toContain('11');
  });

  it('anim/dangling-ref: a keyframe name missing from the tree errors with code, frame and nearest name', () => {
    const doc = baseShape(
      [okElement('body'), okElement('tail')],
      [
        {
          name: 'walk',
          quantityframes: 20,
          keyframes: [
            key(5, { bodyy: fullRot(10) }),
            key(8, { bodyy: fullRot(20), tail: fullRot(0) }),
          ],
        },
      ],
    );
    const f = one(validateDocument(doc), 'anim/dangling-ref');
    expect(f.severity).toBe('error');
    expect(f.animation).toBe('walk');
    expect(f.element).toBe('bodyy');
    expect(f.frame).toBe(5);
    expect(f.message).toContain("'bodyy'");
    expect(f.message).toContain("Nearest existing element: 'body'");
    expect(f.message).toContain('also at frame 8'); // grouped, not one finding per keyframe
    expect(f.fix).toContain("'body'");
  });

  it('anim/partial-channel: a lone rotationX errors naming the missing components (neutral 0)', () => {
    const doc = baseShape(
      [okElement('leg')],
      [
        {
          name: 'walk',
          quantityframes: 10,
          keyframes: [key(0, { leg: fullRot(0) }), key(5, { leg: { rotationX: 30 } })],
        },
      ],
    );
    const f = one(validateDocument(doc), 'anim/partial-channel');
    expect(f.severity).toBe('error');
    expect(f.animation).toBe('walk');
    expect(f.element).toBe('leg');
    expect(f.frame).toBe(5);
    expect(f.message).toContain('rotationY');
    expect(f.message).toContain('rotationZ');
    expect(f.fix).toContain('neutral value 0');
  });

  it('anim/partial-channel: a partial stretch triple suggests the neutral value 1', () => {
    const doc = baseShape(
      [okElement('leg')],
      [
        {
          name: 'walk',
          quantityframes: 10,
          keyframes: [key(0, { leg: { stretchX: 1.5, stretchY: 1 } })],
        },
      ],
    );
    const f = one(validateDocument(doc), 'anim/partial-channel');
    expect(f.message).toContain('stretchZ');
    expect(f.fix).toContain('neutral value 1');
  });

  it(`anim/joint-cap: ${JOINT_WARN_CAP} distinct animated elements REACH the cap and warn (engine '>=', API:143582); ${JOINT_WARN_CAP - 1} stay silent`, () => {
    const mk = (count: number): ShapeJson => {
      const names = Array.from({ length: count }, (_, i) => `e${i + 1}`);
      return baseShape(
        names.map((n) => okElement(n)),
        [
          {
            name: 'walk',
            quantityframes: 2,
            keyframes: [key(0, Object.fromEntries(names.map((n) => [n, fullRot(0)])))],
          },
        ],
      );
    };
    // A legacy cap-31 client throws when the joint count REACHES 31 — exactly 31 warns.
    const f = one(validateDocument(mk(JOINT_WARN_CAP)), 'anim/joint-cap');
    expect(f.severity).toBe('warn');
    expect(f.message).toContain(String(JOINT_WARN_CAP));
    expect(f.message).toContain('46');
    expect(byCode(validateDocument(mk(JOINT_WARN_CAP - 1)), 'anim/joint-cap')).toHaveLength(0);
  });

  it("anim/joint-cap: an existing-but-unkeyed 'head' costs one extra joint (entity animators require it)", () => {
    // 30 keyframed elements + an unkeyed 'head' element = 31 joints in-game (API:155457,
    // ResolveAndFindJoints API:148122) — refused by a legacy cap-31 client.
    const names = Array.from({ length: JOINT_WARN_CAP - 1 }, (_, i) => `e${i + 1}`);
    const doc = baseShape(
      [...names.map((n) => okElement(n)), okElement('head')],
      [
        {
          name: 'walk',
          quantityframes: 2,
          keyframes: [key(0, Object.fromEntries(names.map((n) => [n, fullRot(0)])))],
        },
      ],
    );
    const f = one(validateDocument(doc), 'anim/joint-cap');
    expect(f.message).toContain("'head'");
  });

  it('anim/joint-cap: dangling keyframe names get no joint and do not count', () => {
    // 30 real animated elements + 5 dangling refs: dangling-ref errors, but no joint-cap.
    const names = Array.from({ length: JOINT_WARN_CAP - 1 }, (_, i) => `e${i + 1}`);
    const keyed = Object.fromEntries(names.map((n) => [n, fullRot(0)]));
    for (let i = 0; i < 5; i++) keyed[`ghost${i}`] = fullRot(0);
    const doc = baseShape(names.map((n) => okElement(n)), [
      { name: 'walk', quantityframes: 2, keyframes: [key(0, keyed)] },
    ]);
    const findings = validateDocument(doc);
    expect(byCode(findings, 'anim/joint-cap')).toHaveLength(0);
    expect(byCode(findings, 'anim/dangling-ref')).toHaveLength(5);
  });
});

describe('clean fixture', () => {
  it('a well-formed shape with one animation produces zero findings at full level', () => {
    const doc = baseShape(
      [okElement('body'), okElement('tail', { from: [4, 0, 0], to: [8, 2, 2] })],
      [
        {
          name: 'idle',
          code: 'idle',
          quantityframes: 30,
          onAnimationEnd: 'Repeat',
          keyframes: [
            {
              frame: 0,
              elements: { tail: { rotationX: 0, rotationY: 0, rotationZ: 0 } },
            },
            {
              frame: 15,
              elements: { tail: { rotationX: 10, rotationY: 0, rotationZ: 0 } },
            },
          ],
        },
      ],
    );
    expect(validateDocument(doc, { level: 'full' })).toEqual([]);
  });
});

describe('shape/malformed-tree, key casing, step-parent, robustness', () => {
  it('shape/malformed-tree: a non-array elements value is an ERROR, never a silent clean pass', () => {
    const doc = shape({ textures: {}, elements: 'oops' });
    const f = one(validateDocument(doc), 'shape/malformed-tree');
    expect(f.severity).toBe('error');
    expect(f.message).toContain('"elements"');
    expect(f.message).toContain('string');
  });

  it('shape/malformed-tree: non-object element entries and non-array animations error too', () => {
    const doc = shape({ textures: {}, elements: [42], animations: { nope: true } });
    const findings = byCode(validateDocument(doc), 'shape/malformed-tree');
    expect(findings.length).toBe(2);
    expect(findings[0]!.message).toContain('"elements"[0]');
    expect(findings[1]!.message).toContain('"animations"');
  });

  it('shape/key-casing: off-case known keys error naming both casings (engine reads them, this tool does not)', () => {
    const doc = shape({
      textures: { skin: 'x' },
      elements: [okElement('body')],
      animations: [
        {
          name: 'walk',
          quantityFrames: 10, // the C# casing — fine in-game, read as 0 here
          keyframes: [
            { frame: 0, elements: { body: { OffsetX: 0, offsetY: 0, offsetZ: 0 } } },
          ],
        },
      ],
    });
    const findings = byCode(validateDocument(doc), 'shape/key-casing');
    expect(findings.length).toBe(2);
    const q = findings.find((f) => f.message.includes("'quantityFrames'"))!;
    expect(q.severity).toBe('error');
    expect(q.message).toContain("'quantityframes'");
    expect(q.message).toContain('case-insensitively');
    const o = findings.find((f) => f.message.includes("'OffsetX'"))!;
    expect(o.element).toBe('body');
    expect(o.fix).toContain("'offsetX'");
  });

  it('shape/key-casing: canonical vanilla casing produces zero findings', () => {
    const doc = baseShape(
      [okElement('body')],
      [
        {
          name: 'walk',
          quantityframes: 10,
          keyframes: [{ frame: 0, elements: { body: { offsetX: 0, offsetY: 0, offsetZ: 0 } } }],
        },
      ],
    );
    expect(byCode(validateDocument(doc), 'shape/key-casing')).toHaveLength(0);
  });

  it('shape/step-parent: root elements with stepParentName get one explanatory note', () => {
    const doc = baseShape([
      okElement('Horn attachment', { stepParentName: 'head' }),
      okElement('Other'),
    ]);
    const f = one(validateDocument(doc), 'shape/step-parent');
    expect(f.severity).toBe('note');
    expect(f.message).toContain("'Horn attachment' → 'head'");
    expect(f.message).toContain('step-parented onto another shape');
  });

  it('anim/unsorted-keyframes: out-of-frame-order keyframe arrays warn (engine self-inconsistent)', () => {
    const doc = baseShape(
      [okElement('body')],
      [
        {
          name: 'walkback',
          quantityframes: 40,
          keyframes: [
            { frame: 30, elements: { body: { rotationX: 0, rotationY: 0, rotationZ: 0 } } },
            { frame: 35, elements: { body: { rotationX: 1, rotationY: 0, rotationZ: 0 } } },
            { frame: 32, elements: { body: { rotationX: 2, rotationY: 0, rotationZ: 0 } } },
            { frame: 38, elements: { body: { rotationX: 3, rotationY: 0, rotationZ: 0 } } },
          ],
        },
      ],
    );
    const f = one(validateDocument(doc), 'anim/unsorted-keyframes');
    expect(f.severity).toBe('warn');
    expect(f.animation).toBe('walkback');
    expect(f.message).toContain('32');
    expect(f.fix).toContain('Sort');
  });

  it('validateDocument never throws on degenerate input: {} validates as an empty tree', () => {
    expect(validateDocument({} as ShapeJson)).toEqual([]);
  });
});
