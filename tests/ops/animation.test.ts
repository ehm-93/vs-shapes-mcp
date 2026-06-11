/**
 * Pins for vs/animation.ts: animation CRUD, keyframe triple enforcement / sorting /
 * bounds, channel adjustment, proportional retiming, and gait-cycle phase mirroring.
 */
import { describe, expect, it } from 'vitest';

import { ShapeDocument } from '../../src/vs/document.js';
import {
  adjustChannel,
  createAnimation,
  deleteAnimation,
  deleteKeyframe,
  editAnimationMeta,
  mirrorPhase,
  retimeAnimation,
  setKeyframe,
} from '../../src/vs/animation.js';
import { interpolatePose } from '../../src/vs/fk.js';

const docOf = (shape: unknown): ShapeDocument => ShapeDocument.parse(JSON.stringify(shape));

const face = (): unknown => ({ texture: '#skin', uv: [0, 0, 4, 4] });

const box = (name: string, x: number): unknown => ({
  name,
  from: [x, 0, 0],
  to: [x + 1, 4, 1],
  faces: { north: face() },
});

const rig = (): unknown => ({
  textureWidth: 32,
  textureHeight: 32,
  textures: { skin: 'entity/test/skin' },
  elements: [box('body', 4), box('FL', 0), box('FR', 2), box('BL', 6), box('BR', 8), box('tail', 10)],
  animations: [
    {
      name: 'Walk',
      code: 'walk',
      quantityframes: 30,
      onActivityStopped: 'EaseOut',
      onAnimationEnd: 'Repeat',
      keyframes: [
        { frame: 0, elements: { FL: { rotationX: 30.0, rotationY: 0.0, rotationZ: 0.0 } } },
        { frame: 10, elements: { FL: { rotationX: -30.0, rotationY: 0.0, rotationZ: 0.0 } } },
        { frame: 12, elements: { FL: { rotationX: -10.0, rotationY: 0.0, rotationZ: 0.0 } } },
      ],
    },
  ],
});

describe('createAnimation', () => {
  it('applies sensible defaults (EaseOut / Repeat) and vanilla key order', () => {
    const doc = docOf(rig());
    const anim = createAnimation(doc, { code: 'run', quantityFrames: 20 });
    expect(anim.name).toBe('run');
    expect(anim.code).toBe('run');
    expect(anim.quantityframes.value).toBe(20);
    expect(anim.onActivityStopped).toBe('EaseOut');
    expect(anim.onAnimationEnd).toBe('Repeat');
    expect(anim.keyframes).toEqual([]);
    expect(Object.keys(anim)).toEqual([
      'name', 'code', 'quantityframes', 'onActivityStopped', 'onAnimationEnd', 'keyframes',
    ]);
    expect(doc.getAnimation('run')).toBe(anim);
  });

  it('overrides defaults and enforces code uniqueness across code AND name', () => {
    const doc = docOf(rig());
    const anim = createAnimation(doc, {
      code: 'die',
      name: 'Death',
      quantityFrames: 15,
      onAnimationEnd: 'Hold',
      onActivityStopped: 'PlayTillEnd',
    });
    expect(anim.onAnimationEnd).toBe('Hold');
    expect(anim.onActivityStopped).toBe('PlayTillEnd');
    expect(() => createAnimation(doc, { code: 'walk', quantityFrames: 10 })).toThrow(
      /collides with the code of the existing animation 'walk'/,
    );
    // 'Walk' is the existing animation's NAME — codes default to names, so it is reserved too.
    expect(() => createAnimation(doc, { code: 'Walk', quantityFrames: 10 })).toThrow(
      /collides with the name/,
    );
  });

  it('rejects a non-positive or fractional quantityFrames', () => {
    const doc = docOf(rig());
    expect(() => createAnimation(doc, { code: 'x', quantityFrames: 0 })).toThrow(/positive integer/);
    expect(() => createAnimation(doc, { code: 'x', quantityFrames: 7.5 })).toThrow(/positive integer/);
  });
});

describe('deleteAnimation / editAnimationMeta', () => {
  it('deletes by code with near-miss errors', () => {
    const doc = docOf(rig());
    deleteAnimation(doc, 'walk');
    expect(doc.getAnimation('walk')).toBeUndefined();
    expect(() => deleteAnimation(doc, 'wakl')).toThrow(/animation 'wakl' does not exist/);
  });

  it('renames the code and changes end handling', () => {
    const doc = docOf(rig());
    const anim = editAnimationMeta(doc, 'walk', { code: 'walk-fast', onAnimationEnd: 'Stop' });
    expect(anim.code).toBe('walk-fast');
    expect(anim.onAnimationEnd).toBe('Stop');
    expect(doc.getAnimation('walk-fast')).toBe(anim);
    expect(doc.getAnimation('walk')).toBeUndefined();
    createAnimation(doc, { code: 'idle', quantityFrames: 10 });
    expect(() => editAnimationMeta(doc, 'walk-fast', { code: 'idle' })).toThrow(/collides/);
  });

  it('refuses quantityFrames that are not strictly greater than the last keyframe', () => {
    const doc = docOf(rig());
    expect(() => editAnimationMeta(doc, 'walk', { quantityFrames: 12 })).toThrow(
      /not strictly greater than the last keyframe frame 12/,
    );
    const anim = editAnimationMeta(doc, 'walk', { quantityFrames: 13 });
    expect(anim.quantityframes.value).toBe(13);
  });
});

describe('setKeyframe', () => {
  it('writes the FULL channel triple (GROUND-TRUTH §6 — partial triples NPE the engine)', () => {
    const doc = docOf(rig());
    const entry = setKeyframe(doc, 'walk', 5, 'tail', { rotation: [12, 0, 0] })!;
    expect(entry.rotationX!.value).toBe(12);
    expect(entry.rotationY!.value).toBe(0); // present even though "zero"
    expect(entry.rotationZ!.value).toBe(0);
    expect(entry.offsetX).toBeUndefined(); // untouched channels stay absent
    // The triple interpolates cleanly through the engine port (would throw on partials).
    const pose = interpolatePose(doc.getAnimation('walk')!, 5).get('tail')!;
    expect(pose.degX).toBe(12);
  });

  it('keeps keyframes sorted by frame', () => {
    const doc = docOf(rig());
    setKeyframe(doc, 'walk', 20, 'tail', { offset: [0, 1, 0] });
    setKeyframe(doc, 'walk', 5, 'tail', { offset: [0, 2, 0] });
    const frames = doc.getAnimation('walk')!.keyframes.map((kf) => kf.frame.value);
    expect(frames).toEqual([0, 5, 10, 12, 20]);
  });

  it('rejects out-of-range and fractional frames naming the limit', () => {
    const doc = docOf(rig());
    expect(() => setKeyframe(doc, 'walk', 30, 'tail', { offset: [0, 0, 0] })).toThrow(
      /quantityframes is 30, so valid frames are 0\.\.29/,
    );
    expect(() => setKeyframe(doc, 'walk', -1, 'tail', { offset: [0, 0, 0] })).toThrow(/0\.\.29/);
    expect(() => setKeyframe(doc, 'walk', 1.5, 'tail', { offset: [0, 0, 0] })).toThrow(/integer/);
  });

  it('null clears a channel; empty entries and keyframes are pruned', () => {
    const doc = docOf(rig());
    setKeyframe(doc, 'walk', 5, 'tail', { offset: [1, 2, 3], rotation: [4, 5, 6] });
    setKeyframe(doc, 'walk', 5, 'tail', { rotation: null });
    const kf5 = doc.getAnimation('walk')!.keyframes.find((kf) => kf.frame.value === 5)!;
    const entry = kf5.elements['tail']!;
    expect(entry.rotationX).toBeUndefined();
    expect(entry.offsetX!.value).toBe(1);
    // Clearing the last channel prunes the entry AND the now-empty keyframe.
    expect(setKeyframe(doc, 'walk', 5, 'tail', { offset: null })).toBeNull();
    expect(doc.getAnimation('walk')!.keyframes.map((kf) => kf.frame.value)).toEqual([0, 10, 12]);
  });

  it('validates animation, element and pose with actionable messages', () => {
    const doc = docOf(rig());
    expect(() => setKeyframe(doc, 'wlak', 0, 'tail', { offset: [0, 0, 0] })).toThrow(
      /did you mean 'walk'/,
    );
    expect(() => setKeyframe(doc, 'walk', 0, 'tial', { offset: [0, 0, 0] })).toThrow(
      /did you mean 'tail'/,
    );
    expect(() => setKeyframe(doc, 'walk', 0, 'tail', {})).toThrow(/sets no channels/);
    expect(() => setKeyframe(doc, 'walk', 0, 'tail', { offset: [1, 2] as never })).toThrow(
      /three finite numbers/,
    );
  });
});

describe('deleteKeyframe', () => {
  it('deletes a whole frame or a single entry (ghost entries included)', () => {
    const doc = docOf(rig());
    setKeyframe(doc, 'walk', 10, 'tail', { offset: [0, 1, 0] });
    deleteKeyframe(doc, 'walk', 10, 'FL');
    const kf10 = doc.getAnimation('walk')!.keyframes.find((kf) => kf.frame.value === 10)!;
    expect(Object.keys(kf10.elements)).toEqual(['tail']);
    deleteKeyframe(doc, 'walk', 10, 'tail'); // last entry → keyframe pruned
    expect(doc.getAnimation('walk')!.keyframes.map((kf) => kf.frame.value)).toEqual([0, 12]);
    deleteKeyframe(doc, 'walk', 12);
    expect(doc.getAnimation('walk')!.keyframes.map((kf) => kf.frame.value)).toEqual([0]);
  });

  it('names existing frames / entries when the target is missing', () => {
    const doc = docOf(rig());
    expect(() => deleteKeyframe(doc, 'walk', 7)).toThrow(/existing keyframe frames: 0, 10, 12/);
    expect(() => deleteKeyframe(doc, 'walk', 10, 'tail')).toThrow(/keyframe entry 'tail'/);
  });
});

describe('adjustChannel', () => {
  it('clamps rotation triples to min/max across all keyframes', () => {
    const doc = docOf(rig());
    const result = adjustChannel(doc, 'walk', {
      elements: '*',
      channel: 'rotation',
      op: 'clamp',
      min: -20,
      max: 20,
    });
    expect(result).toEqual({ keyframesTouched: 3, entriesTouched: 3 });
    const xs = doc
      .getAnimation('walk')!
      .keyframes.map((kf) => kf.elements['FL']!.rotationX!.value);
    expect(xs).toEqual([20, -20, -10]); // 30 → 20, −30 → −20, −10 unchanged
  });

  it('scales offsets per-axis with a Vec3 value, only for the listed elements', () => {
    const doc = docOf(rig());
    setKeyframe(doc, 'walk', 0, 'tail', { offset: [1, 2, 3] });
    setKeyframe(doc, 'walk', 0, 'body', { offset: [1, 1, 1] });
    adjustChannel(doc, 'walk', { elements: ['tail'], channel: 'offset', op: 'scale', value: [2, 3, 4] });
    const kf0 = doc.getAnimation('walk')!.keyframes[0]!;
    const tail = kf0.elements['tail']!;
    expect([tail.offsetX!.value, tail.offsetY!.value, tail.offsetZ!.value]).toEqual([2, 6, 12]);
    const body = kf0.elements['body']!;
    expect([body.offsetX!.value, body.offsetY!.value, body.offsetZ!.value]).toEqual([1, 1, 1]);
    // 'add' on a channel an element does not set is a no-op for it (channels independent).
    const r = adjustChannel(doc, 'walk', { elements: ['body'], channel: 'stretch', op: 'add', value: 1 });
    expect(r.entriesTouched).toBe(0);
  });

  it('validates elements against the keyed names with near-misses', () => {
    const doc = docOf(rig());
    expect(() =>
      adjustChannel(doc, 'walk', { elements: ['FLL'], channel: 'rotation', op: 'add', value: 1 }),
    ).toThrow(/no keyframe entries in animation 'walk'.*did you mean 'FL'/s);
    expect(() =>
      adjustChannel(doc, 'walk', { elements: '*', channel: 'rotation', op: 'clamp' }),
    ).toThrow(/requires 'min' and\/or 'max'/);
    expect(() =>
      adjustChannel(doc, 'walk', { elements: '*', channel: 'rotation', op: 'scale' }),
    ).toThrow(/requires 'value'/);
  });
});

describe('retimeAnimation', () => {
  it('re-places keyframes proportionally (round-to-nearest) and updates quantityframes', () => {
    const doc = docOf(rig());
    deleteKeyframe(doc, 'walk', 12);
    const result = retimeAnimation(doc, 'walk', 15);
    expect(result.mapping).toEqual([
      { from: 0, to: 0 },
      { from: 10, to: 5 },
    ]);
    const anim = doc.getAnimation('walk')!;
    expect(anim.quantityframes.value).toBe(15);
    expect(anim.keyframes.map((kf) => kf.frame.value)).toEqual([0, 5]);
  });

  it('clamps the rounded frame below the new quantityframes', () => {
    const doc = docOf(rig());
    deleteKeyframe(doc, 'walk', 10);
    deleteKeyframe(doc, 'walk', 12);
    setKeyframe(doc, 'walk', 29, 'FL', { rotation: [1, 0, 0] });
    const result = retimeAnimation(doc, 'walk', 15); // 29·15/30 = 14.5 → 15 → clamp 14
    expect(result.mapping).toEqual([
      { from: 0, to: 0 },
      { from: 29, to: 14 },
    ]);
  });

  it('throws naming the colliding keyframes when rounding collapses two onto one frame', () => {
    const doc = docOf(rig());
    expect(() => retimeAnimation(doc, 'walk', 8)).toThrow(
      /frames 10 and 12 \(of 30\) would both land on frame 3/,
    );
    // Nothing was mutated by the failed retime.
    const anim = doc.getAnimation('walk')!;
    expect(anim.quantityframes.value).toBe(30);
    expect(anim.keyframes.map((kf) => kf.frame.value)).toEqual([0, 10, 12]);
  });
});

describe('mirrorPhase — synthetic 4-leg walk', () => {
  const walkShape = (): unknown => ({
    textures: { skin: 's' },
    elements: [box('FL', 0), box('FR', 2), box('BL', 6), box('BR', 8), box('tail', 10)],
    animations: [
      {
        name: 'walk8',
        code: 'walk8',
        quantityframes: 8,
        keyframes: [
          {
            frame: 0,
            elements: {
              FL: { rotationX: 30.0, rotationY: 0.0, rotationZ: 0.0, offsetX: 0.0, offsetY: 1.0, offsetZ: 0.0 },
              FR: { rotationX: -30.0, rotationY: 0.0, rotationZ: 0.0 },
              BL: { rotationX: -25.0, rotationY: 0.0, rotationZ: 0.0 },
              BR: { rotationX: 25.0, rotationY: 0.0, rotationZ: 0.0 },
              tail: { rotationX: 5.0, rotationY: 0.0, rotationZ: 0.0 },
            },
          },
          {
            frame: 2,
            elements: {
              FL: { rotationX: 0.0, rotationY: 0.0, rotationZ: 0.0 },
              FR: { rotationX: 0.0, rotationY: 0.0, rotationZ: 0.0 },
            },
          },
        ],
      },
    ],
  });

  it('copies the first half onto the second half with each pair swapped, unpaired as-is', () => {
    const doc = docOf(walkShape());
    const result = mirrorPhase(doc, 'walk8', [
      ['FL', 'FR'],
      ['BL', 'BR'],
    ]);
    expect(result.framesWritten).toEqual([4, 6]);
    const anim = doc.getAnimation('walk8')!;
    expect(anim.keyframes.map((kf) => kf.frame.value)).toEqual([0, 2, 4, 6]);
    const kf0 = anim.keyframes[0]!.elements;
    const kf4 = anim.keyframes.find((kf) => kf.frame.value === 4)!.elements;
    // a's values land on b and vice versa — no sign flips.
    expect(kf4['FR']!.rotationX!.value).toBe(30);
    expect(kf4['FR']!.offsetY!.value).toBe(1); // the whole entry travels (offset included)
    expect(kf4['FL']!.rotationX!.value).toBe(-30);
    expect(kf4['FL']!.offsetY).toBeUndefined();
    expect(kf4['BR']!.rotationX!.value).toBe(-25);
    expect(kf4['BL']!.rotationX!.value).toBe(25);
    // Unpaired element copied as-is.
    expect(kf4['tail']!.rotationX!.value).toBe(5);
    // Deep copies: the target entry is not the same object as the source entry.
    expect(kf4['FR']).not.toBe(kf0['FL']);
    // The half-cycle then loops cleanly through the engine port: pose(0) == pose(8 → 0).
    const p0 = interpolatePose(anim, 0).get('FL')!;
    const p4 = interpolatePose(anim, 4).get('FL')!;
    expect(p0.degX).toBe(30);
    expect(p4.degX).toBe(-30);
  });

  it('replaces existing keyframes in the second half', () => {
    const doc = docOf(walkShape());
    setKeyframe(doc, 'walk8', 4, 'tail', { rotation: [99, 0, 0] });
    mirrorPhase(doc, 'walk8', [['FL', 'FR']]);
    const kf4 = doc.getAnimation('walk8')!.keyframes.find((kf) => kf.frame.value === 4)!;
    expect(kf4.elements['tail']!.rotationX!.value).toBe(5); // overwritten by the mirror
  });

  it('requires an even quantityframes and well-formed pairs', () => {
    const doc = docOf(walkShape());
    editAnimationMeta(doc, 'walk8', { quantityFrames: 9 });
    expect(() => mirrorPhase(doc, 'walk8', [['FL', 'FR']])).toThrow(/even cycle/);
    editAnimationMeta(doc, 'walk8', { quantityFrames: 8 });
    expect(() => mirrorPhase(doc, 'walk8', [['FL', 'FL']])).toThrow(/same element twice/);
    expect(() =>
      mirrorPhase(doc, 'walk8', [
        ['FL', 'FR'],
        ['FL', 'BL'],
      ]),
    ).toThrow(/more than one pair/);
    expect(() => mirrorPhase(doc, 'walk8', [['FL', 'FRR']])).toThrow(/did you mean 'FR'/);
  });
});

describe('setKeyframe on duplicate-key source files (shadow invalidation)', () => {
  it('editing an in-place entry drops the stale duplicate line from the saved file', () => {
    // The vanilla alewife-adult.json pattern: the keyframe element map duplicates a key;
    // last occurrence wins (Newtonsoft), the earlier one is preserved as raw shadow text.
    // After anim_set_keyframe edits the entry IN PLACE, the saved file must not still
    // carry the contradicting old pose line.
    const text =
      '{\r\n\t"textures": { "skin": "x" },\r\n\t"elements": [\r\n\t\t{ "name": "Rear", "from": [ 0.0, 0.0, 0.0 ], "to": [ 1.0, 1.0, 1.0 ], "faces": { "north": { "texture": "#skin", "uv": [ 0.0, 0.0, 1.0, 1.0 ] } } }\r\n\t],\r\n\t"animations": [\r\n\t\t{\r\n\t\t\t"name": "run",\r\n\t\t\t"quantityframes": 30,\r\n\t\t\t"keyframes": [\r\n\t\t\t\t{\r\n\t\t\t\t\t"frame": 10,\r\n\t\t\t\t\t"elements": {\r\n\t\t\t\t\t\t"Rear": { "rotationX": 0.0, "rotationY": 20.0, "rotationZ": 0.0 },\r\n\t\t\t\t\t\t"Rear": { "rotationX": 0.0, "rotationY": 30.0, "rotationZ": 0.0 }\r\n\t\t\t\t\t}\r\n\t\t\t\t}\r\n\t\t\t]\r\n\t\t}\r\n\t]\r\n}';
    const doc = ShapeDocument.parse(text);
    // Unedited: both occurrences survive byte-identically.
    expect(doc.serialize()).toBe(text);
    setKeyframe(doc, 'run', 10, 'Rear', { rotation: [0, 99, 0] });
    const out = doc.serialize();
    expect(out).toContain('"rotationY": 99');
    expect(out).not.toContain('"rotationY": 20'); // the stale shadow is gone
    expect(out).not.toContain('"rotationY": 30');
    expect((out.match(/"Rear": \{ "rotation/g) ?? []).length).toBe(1);
  });
});
