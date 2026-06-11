/**
 * Pins for interpolatePose — the exact port of Animation.GenerateFrameForElement +
 * seekRight/LeftKeyFrame + lerpKeyFrameElement (VintagestoryAPI.decompiled.cs:143638–143747).
 * Expected values are hand-computed from the engine formulas in docs/GROUND-TRUTH.md §6.
 */
import { describe, expect, it } from 'vitest';

import { interpolatePose } from '../../src/vs/fk.js';
import { VsNum, type AnimationJson } from '../../src/vs/types.js';

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

const anim = (raw: unknown): AnimationJson => wrapNums(raw) as AnimationJson;

/** Keys at 0 and 20, quantityframes 30 — all three channels keyed on 'box'. */
const twoKeyAnim = anim({
  name: 'Test',
  code: 'test',
  quantityframes: 30,
  keyframes: [
    {
      frame: 0,
      elements: {
        box: {
          offsetX: 0,
          offsetY: 0,
          offsetZ: 0,
          rotationX: 0,
          rotationY: 0,
          rotationZ: 0,
          stretchX: 1,
          stretchY: 1,
          stretchZ: 1,
        },
      },
    },
    {
      frame: 20,
      elements: {
        box: {
          offsetX: 8,
          offsetY: 4,
          offsetZ: -2,
          rotationX: 90,
          rotationY: 45,
          rotationZ: -30,
          stretchX: 2,
          stretchY: 1,
          stretchZ: 0.5,
        },
      },
    },
  ],
});

describe('interpolatePose — two keyframes at 0 and 20, quantityframes 30', () => {
  it('frame 10 lerps linearly (t = 0.5), offsets divided by 16', () => {
    const pose = interpolatePose(twoKeyAnim, 10).get('box')!;
    expect(pose.translateX).toBe(8 / 16 / 2); // lerp(0/16, 8/16, 0.5)
    expect(pose.translateY).toBe(4 / 16 / 2);
    expect(pose.translateZ).toBe(-2 / 16 / 2);
    expect(pose.degX).toBe(45);
    expect(pose.degY).toBe(22.5);
    expect(pose.degZ).toBe(-15);
    expect(pose.scaleX).toBe(1.5);
    expect(pose.scaleY).toBe(1);
    expect(pose.scaleZ).toBe(0.75);
  });

  it('frame 25 wraps: left = 20, right = 0, span = 0 + (30 − 20) = 10, t = 0.5', () => {
    const pose = interpolatePose(twoKeyAnim, 25).get('box')!;
    expect(pose.translateX).toBe(0.25); // lerp(0.5, 0, 0.5)
    expect(pose.degX).toBe(45); // lerp(90, 0, 0.5)
    expect(pose.scaleX).toBe(1.5); // lerp(2, 1, 0.5)
  });

  it('frame 22 wraps with t = 0.2', () => {
    const pose = interpolatePose(twoKeyAnim, 22).get('box')!;
    expect(pose.translateX).toBeCloseTo(0.4, 12); // lerp(0.5, 0, 0.2)
    expect(pose.degX).toBeCloseTo(72, 12); // lerp(90, 0, 0.2)
    expect(pose.degZ).toBeCloseTo(-24, 12); // lerp(-30, 0, 0.2)
    expect(pose.scaleX).toBeCloseTo(1.8, 12); // lerp(2, 1, 0.2)
  });

  it('exactly AT keyframe frames returns the exact keyed values (t = 0 both branches)', () => {
    // At frame 0 the seek skips frame 0 (strict >), lands right=20 / left=0, t=0.
    const at0 = interpolatePose(twoKeyAnim, 0).get('box')!;
    expect(at0.translateX).toBe(0);
    expect(at0.degX).toBe(0);
    expect(at0.scaleX).toBe(1);
    // At frame 20 nothing is > 20, so right wraps to keyframe 0 and left=20; the wrap
    // branch gives t = mod(20−20, 30)/10 = 0 → exact frame-20 values.
    const at20 = interpolatePose(twoKeyAnim, 20).get('box')!;
    expect(at20.translateX).toBe(0.5);
    expect(at20.translateZ).toBe(-0.125);
    expect(at20.degX).toBe(90);
    expect(at20.degY).toBe(45);
    expect(at20.scaleX).toBe(2);
    expect(at20.scaleZ).toBe(0.5);
  });

  it('out-of-domain frames take the cyclic extension (frame mod quantityframes)', () => {
    const at30 = interpolatePose(twoKeyAnim, 30).get('box')!;
    const at0 = interpolatePose(twoKeyAnim, 0).get('box')!;
    expect(at30).toEqual(at0);
    const atMinus5 = interpolatePose(twoKeyAnim, -5).get('box')!;
    const at25 = interpolatePose(twoKeyAnim, 25).get('box')!;
    expect(atMinus5).toEqual(at25);
  });

  it('only keyframed elements appear in the result map', () => {
    const poses = interpolatePose(twoKeyAnim, 10);
    expect([...poses.keys()]).toEqual(['box']);
  });
});

describe('interpolatePose — channel independence', () => {
  // rotation keyed ONLY at frame 10; offsets keyed at 0 and 20; stretch never keyed.
  const channelAnim = anim({
    name: 'Channels',
    code: 'channels',
    quantityframes: 30,
    keyframes: [
      { frame: 0, elements: { leg: { offsetX: 0, offsetY: 0, offsetZ: 0 } } },
      { frame: 10, elements: { leg: { rotationX: 30, rotationY: 0, rotationZ: 0 } } },
      { frame: 20, elements: { leg: { offsetX: 16, offsetY: 0, offsetZ: 0 } } },
    ],
  });

  it('a single set rotation keyframe means left == right → rotation constant everywhere', () => {
    for (const frame of [0, 5, 10, 15, 20, 25, 29]) {
      const pose = interpolatePose(channelAnim, frame).get('leg')!;
      expect(pose.degX, `degX at frame ${frame}`).toBe(30);
      expect(pose.degY, `degY at frame ${frame}`).toBe(0);
      expect(pose.degZ, `degZ at frame ${frame}`).toBe(0);
    }
  });

  it('offsets lerp independently of the rotation keyframe in between', () => {
    // frame 5: between offset keys 0 and 20 → t = 0.25 (the rotation-only keyframe at
    // frame 10 must NOT participate in the offset channel seek).
    expect(interpolatePose(channelAnim, 5).get('leg')!.translateX).toBe(0.25);
    expect(interpolatePose(channelAnim, 15).get('leg')!.translateX).toBe(0.75);
    // frame 25: wrap left=20 right=0, span 10, t=0.5.
    expect(interpolatePose(channelAnim, 25).get('leg')!.translateX).toBe(0.5);
  });

  it('an unkeyed channel stays at its identity values', () => {
    const pose = interpolatePose(channelAnim, 7).get('leg')!;
    expect(pose.scaleX).toBe(1);
    expect(pose.scaleY).toBe(1);
    expect(pose.scaleZ).toBe(1);
  });
});

describe('interpolatePose — fractional frames', () => {
  const denseAnim = anim({
    name: 'Dense',
    code: 'dense',
    quantityframes: 30,
    keyframes: [
      { frame: 10, elements: { box: { offsetX: 0, offsetY: 0, offsetZ: 0, rotationX: 0, rotationY: 0, rotationZ: 0 } } },
      { frame: 11, elements: { box: { offsetX: 16, offsetY: 8, offsetZ: 0, rotationX: 40, rotationY: 0, rotationZ: 0 } } },
    ],
  });

  it('frame 10.5 between keys 10 and 11 lerps halfway', () => {
    const pose = interpolatePose(denseAnim, 10.5).get('box')!;
    expect(pose.translateX).toBe(0.5);
    expect(pose.translateY).toBe(0.25);
    expect(pose.degX).toBe(20);
  });

  it('integer frames are exact at the keys; fractional wrap interpolates the cycle tail', () => {
    expect(interpolatePose(denseAnim, 10).get('box')!.translateX).toBe(0);
    expect(interpolatePose(denseAnim, 11).get('box')!.translateX).toBe(1);
    // frame 20.5: wrap left=11 right=10, span = 10 + (30 − 11) = 29, t = 9.5/29.
    const pose = interpolatePose(denseAnim, 20.5).get('box')!;
    expect(pose.translateX).toBeCloseTo(1 + (0 - 1) * (9.5 / 29), 12);
    expect(pose.degX).toBeCloseTo(40 + (0 - 40) * (9.5 / 29), 12);
  });
});

describe('interpolatePose — engine-load invariants and errors', () => {
  it('throws on a partial channel triple, naming animation, element, and the missing parts', () => {
    const bad = anim({
      name: 'Bad',
      code: 'bad',
      quantityframes: 10,
      keyframes: [{ frame: 0, elements: { box: { offsetX: 8 } } }],
    });
    expect(() => interpolatePose(bad, 0)).toThrowError(/offset/);
    expect(() => interpolatePose(bad, 0)).toThrowError(/'box'/);
    expect(() => interpolatePose(bad, 0)).toThrowError(/'bad'/);
    expect(() => interpolatePose(bad, 0)).toThrowError(/offsetY, offsetZ/);
  });

  it('throws when quantityframes is not strictly greater than every keyframe frame', () => {
    const bad = anim({
      name: 'Overflow',
      code: 'overflow',
      quantityframes: 30,
      keyframes: [{ frame: 30, elements: { box: { rotationX: 1, rotationY: 0, rotationZ: 0 } } }],
    });
    expect(() => interpolatePose(bad, 0)).toThrowError(/quantityframes/);
    expect(() => interpolatePose(bad, 0)).toThrowError(/'overflow'/);
  });

  it('throws on an animation with no keyframes (engine refuses to load those)', () => {
    const bad = anim({ name: 'Empty', code: 'empty', quantityframes: 10, keyframes: [] });
    expect(() => interpolatePose(bad, 0)).toThrowError(/no keyframes/);
  });

  it('throws on a non-finite frame', () => {
    expect(() => interpolatePose(twoKeyAnim, Number.NaN)).toThrowError(/finite/);
  });

  it('animation code defaults to name in error messages when code is absent', () => {
    const bad = anim({ name: 'OnlyName', quantityframes: 5, keyframes: [] });
    expect(() => interpolatePose(bad, 0)).toThrowError(/'OnlyName'/);
  });
});

describe('interpolatePose — rotShortestDistance (single-animation shortest-path lerp)', () => {
  // ElementPose.Add (API:146322): when the LEFT keyframe carries rotShortestDistance for
  // an axis, that axis lerps deg = left + AngleDegDistance(left, right) · t — for single
  // animations too (the flags are NOT cross-animation-only).

  /** The vanilla gencore.json 'active' pattern: rotationX 0 @0 → −348 @29, q = 30, flag on @29. */
  const gencore = anim({
    name: 'active',
    quantityframes: 30,
    keyframes: [
      { frame: 0, elements: { ShaftUD: { rotationX: 0, rotationY: 0, rotationZ: 0 } } },
      {
        frame: 29,
        elements: {
          ShaftUD: {
            rotationX: -348,
            rotationY: 0,
            rotationZ: 0,
            rotShortestDistanceX: true,
          },
        },
      },
    ],
  });

  it('continues the short way through the wrap: gencore frame 29.5 is −354°, not −174°', () => {
    // Wrap segment [29, 30): left = kf@29 (flag set), right = kf@0.
    // AngleDegDistance(−348, 0) = −12 → −348 + (−12)·0.5 = −354. A plain lerp would give
    // −174 — 180° apart, the exact divergence the renderer used to show at the loop seam.
    expect(interpolatePose(gencore, 29.5).get('ShaftUD')!.degX).toBeCloseTo(-354, 10);
  });

  it('the inner segment [0, 29] still plain-lerps (the flag sits on the LEFT keyframe of each segment)', () => {
    // Left of frames 0..28 is kf@0, which has NO flag → plain lerp 0 → −348.
    expect(interpolatePose(gencore, 14.5).get('ShaftUD')!.degX).toBeCloseTo((-348 * 14.5) / 29, 10);
  });

  it('hurdygurdy pattern: 0 → 359 with the flag on the left key moves −1° total, not +359°', () => {
    const crank = anim({
      name: 'crank',
      quantityframes: 30,
      keyframes: [
        {
          frame: 0,
          elements: {
            Crank: { rotationX: 0, rotationY: 0, rotationZ: 0, rotShortestDistanceZ: true },
          },
        },
        { frame: 20, elements: { Crank: { rotationX: 0, rotationY: 0, rotationZ: 359 } } },
      ],
    });
    // AngleDegDistance(0, 359) = −1 → at integer frame 10 (t = 0.5) the crank sits at
    // −0.5°, NOT 179.5° — this divergence hits INTEGER frames, not just the seam.
    expect(interpolatePose(crank, 10).get('Crank')!.degZ).toBeCloseTo(-0.5, 10);
    // Unflagged axes keep the plain lerp.
    expect(interpolatePose(crank, 10).get('Crank')!.degX).toBe(0);
  });
});

describe("interpolatePose — onAnimationEnd 'Hold' end-clamp", () => {
  /** The vanilla salmon 'death' pattern: last keyframe at 28, quantityframes 30. */
  const mkDeath = (onAnimationEnd?: string) =>
    anim({
      name: 'death',
      quantityframes: 30,
      ...(onAnimationEnd !== undefined ? { onAnimationEnd } : {}),
      keyframes: [
        { frame: 0, elements: { Chest: { rotationX: 0, rotationY: 0, rotationZ: 0 } } },
        { frame: 28, elements: { Chest: { rotationX: -83, rotationY: 0, rotationZ: 0 } } },
      ],
    });

  it('Hold parks frames in [q−1, q) at the LAST keyframe pose (engine API:146147/:147168)', () => {
    expect(interpolatePose(mkDeath('Hold'), 29).get('Chest')!.degX).toBe(-83);
    expect(interpolatePose(mkDeath('Hold'), 29.7).get('Chest')!.degX).toBe(-83);
    // Newtonsoft parses enums case-insensitively.
    expect(interpolatePose(mkDeath('hold'), 29).get('Chest')!.degX).toBe(-83);
  });

  it('frames below q−1 keep the transient wrap-lerp (the engine lerps them while playing)', () => {
    // Frame 28.5 lies in the wrap segment [28, 30): span = 0 + (30 − 28) = 2, t = 0.25.
    expect(interpolatePose(mkDeath('Hold'), 28.5).get('Chest')!.degX).toBeCloseTo(-62.25, 10);
  });

  it('without Hold, frame q−1 wrap-lerps toward frame 0 (Repeat behavior, t = 0.5)', () => {
    expect(interpolatePose(mkDeath(), 29).get('Chest')!.degX).toBeCloseTo(-41.5, 10);
    expect(interpolatePose(mkDeath('Repeat'), 29).get('Chest')!.degX).toBeCloseTo(-41.5, 10);
  });
});
