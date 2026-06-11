/**
 * Full-level (fk-based) validation checks: anim/hard-wrap and anim/foot-slide.
 *
 * Hard-wrap semantics under test (see validate.ts checkHardWrap): the engine always lerps
 * a Repeat loop from its last keyframe back to the first across gap = first + (q − last)
 * frames; only a ≤ 1-frame gap with materially different poses snaps.
 */
import { describe, expect, it } from 'vitest';

import {
  validateDocument,
  FOOT_SLIDE_TOL,
  HARD_WRAP_TOL_DEG,
} from '../../src/vs/validate.js';
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

const byCode = (findings: Finding[], code: string): Finding[] =>
  findings.filter((f) => f.code === code);

const rot = (x: number): Record<string, unknown> => ({ rotationX: x, rotationY: 0, rotationZ: 0 });
const off = (x: number, y = 0, z = 0): Record<string, unknown> => ({
  offsetX: x,
  offsetY: y,
  offsetZ: z,
});

describe('anim/hard-wrap', () => {
  /** One 'tail' element; one animation with keys at frame 0 and `lastFrame`, q = 10. */
  const wrapShape = (
    lastPose: Record<string, unknown>,
    opts: { lastFrame?: number; end?: string; firstPose?: Record<string, unknown> } = {},
  ): ShapeJson =>
    wrapNums({
      textureWidth: 16,
      textureHeight: 16,
      textures: { skin: 'x' },
      elements: [{ name: 'tail', from: [0, 0, 0], to: [4, 4, 4] }],
      animations: [
        {
          name: 'walk',
          quantityframes: 10,
          onAnimationEnd: opts.end ?? 'Repeat',
          keyframes: [
            { frame: 0, elements: { tail: opts.firstPose ?? rot(0) } },
            { frame: opts.lastFrame ?? 9, elements: { tail: lastPose } },
          ],
        },
      ],
    }) as ShapeJson;

  it('warns when the last keyframe sits 1 frame before the wrap and the pose differs', () => {
    const findings = validateDocument(wrapShape(rot(45)), { level: 'full' });
    const f = byCode(findings, 'anim/hard-wrap');
    expect(f, JSON.stringify(findings)).toHaveLength(1);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.animation).toBe('walk');
    expect(f[0]!.element).toBe('tail');
    expect(f[0]!.frame).toBe(9);
    expect(f[0]!.message).toContain('45');
    expect(f[0]!.message).toContain('Repeat');
    expect(f[0]!.fix).toBeDefined();
  });

  it('reports the dominant channel: an offset-only delta names the offset, in 1/16 units', () => {
    const findings = validateDocument(
      wrapShape(off(0.2), { firstPose: off(0) }),
      { level: 'full' },
    );
    const f = byCode(findings, 'anim/hard-wrap');
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain('offset differs by 0.2');
  });

  it('does not warn at fast level (fk checks are full-only)', () => {
    expect(byCode(validateDocument(wrapShape(rot(45))), 'anim/hard-wrap')).toHaveLength(0);
  });

  it('does not warn when the wrap gap is ≥ 2 frames (the engine blends across it)', () => {
    const findings = validateDocument(wrapShape(rot(45), { lastFrame: 8 }), { level: 'full' });
    expect(byCode(findings, 'anim/hard-wrap')).toHaveLength(0);
  });

  it(`does not warn when the pose delta is within tolerance (${HARD_WRAP_TOL_DEG}° rotation)`, () => {
    const findings = validateDocument(wrapShape(rot(0.5)), { level: 'full' });
    expect(byCode(findings, 'anim/hard-wrap')).toHaveLength(0);
  });

  it('does not warn for non-Repeat end handling (Hold pins the last pose, no wrap)', () => {
    const findings = validateDocument(wrapShape(rot(45), { end: 'Hold' }), { level: 'full' });
    expect(byCode(findings, 'anim/hard-wrap')).toHaveLength(0);
  });

  it('matches onAnimationEnd case-insensitively (Newtonsoft enum parsing)', () => {
    const findings = validateDocument(wrapShape(rot(45), { end: 'repeat' }), { level: 'full' });
    expect(byCode(findings, 'anim/hard-wrap')).toHaveLength(1);
  });

  it('skips fk evaluation (without throwing) for animations with fast errors', () => {
    // Partial channel triple at the last keyframe: the engine would NPE, and interpolatePose
    // throws — full level must report the static error and not crash.
    const doc = wrapNums({
      textureWidth: 16,
      textureHeight: 16,
      textures: {},
      elements: [{ name: 'tail', from: [0, 0, 0], to: [4, 4, 4] }],
      animations: [
        {
          name: 'walk',
          quantityframes: 10,
          onAnimationEnd: 'Repeat',
          keyframes: [
            { frame: 0, elements: { tail: rot(0) } },
            { frame: 9, elements: { tail: { rotationX: 45 } } },
          ],
        },
      ],
    }) as ShapeJson;
    const findings = validateDocument(doc, { level: 'full' });
    expect(byCode(findings, 'anim/partial-channel')).toHaveLength(1);
    expect(byCode(findings, 'anim/hard-wrap')).toHaveLength(0);
    expect(byCode(findings, 'anim/eval-failed')).toHaveLength(0);
  });
});

describe('anim/foot-slide', () => {
  /** One root 'foot' box; one animation keyed at every frame with the given offsets. */
  const gaitShape = (code: string, offsets: [number, number][], q = offsets.length): ShapeJson =>
    wrapNums({
      textureWidth: 16,
      textureHeight: 16,
      textures: { skin: 'x' },
      elements: [{ name: 'foot', from: [0, 0, 0], to: [2, 2, 2] }],
      animations: [
        {
          name: code,
          quantityframes: q,
          keyframes: offsets.map(([x, y], frame) => ({
            frame,
            elements: { foot: off(x, y) },
          })),
        },
      ],
    }) as ShapeJson;

  // Stance = frames 0–4 (y = 0, lowest 20% of travel); swing = frames 5–7 (y = 6/16).
  // Only MID-stance segments are scored (frames 1→2 and 2→3 here; lift-off/touch-down are
  // excluded), and FOOT_SLIDE_TOL is calibrated above the vanilla maximum (0.32
  // blocks/frame), so the slide must be egregious: the foot lurches 11/16 of a block in
  // one frame then stops dead — mid-stance deviation 0.34 blocks/frame.
  const slideOffsets: [number, number][] = [
    [0, 0],
    [-1, 0],
    [-12, 0], // lurch: −11/16 blocks in one frame…
    [-12, 0], // …then stops dead mid-stance
    [-13, 0],
    [-9, 6],
    [-4, 6],
    [0, 6],
  ];
  const cleanOffsets: [number, number][] = [
    [0, 0],
    [-1, 0],
    [-2, 0],
    [-3, 0], // constant −1/16 blocks per frame while planted
    [-4, 0],
    [-2.7, 6],
    [-1.3, 6],
    [0, 6],
  ];

  it('warns when stance-phase horizontal velocity varies, naming foot, animation and frame', () => {
    const findings = validateDocument(gaitShape('walk', slideOffsets), {
      level: 'full',
      footElements: ['foot'],
    });
    const f = byCode(findings, 'anim/foot-slide');
    expect(f, JSON.stringify(findings)).toHaveLength(1);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.animation).toBe('walk');
    expect(f[0]!.element).toBe('foot');
    // Worst segment lies inside the MID-stance window (frames 1–3).
    expect(f[0]!.frame).toBeGreaterThanOrEqual(1);
    expect(f[0]!.frame).toBeLessThanOrEqual(3);
    expect(f[0]!.message).toContain(`tolerance ${FOOT_SLIDE_TOL}`);
    expect(f[0]!.fix).toContain('constant');
  });

  it('stays silent when the planted foot moves at constant horizontal velocity', () => {
    const findings = validateDocument(gaitShape('walk', cleanOffsets), {
      level: 'full',
      footElements: ['foot'],
    });
    expect(byCode(findings, 'anim/foot-slide')).toHaveLength(0);
  });

  it('handles an all-stance cycle (foot never lifts): runs wrap across the loop boundary', () => {
    // y constant → every frame is stance (a cyclic run has no excluded lift-off/touch-down
    // segments); x sweeps back and forth hard → velocity flips between ±0.75 blocks/frame.
    const offsets: [number, number][] = [
      [0, 0],
      [-12, 0],
      [-24, 0],
      [-36, 0],
      [-24, 0],
      [-12, 0],
    ];
    const findings = validateDocument(gaitShape('run', offsets), {
      level: 'full',
      footElements: ['foot'],
    });
    expect(byCode(findings, 'anim/foot-slide')).toHaveLength(1);
  });

  it('only checks locomotion-looking codes (walk|run|trot|sprint|move)', () => {
    const attack = validateDocument(gaitShape('attack', slideOffsets), {
      level: 'full',
      footElements: ['foot'],
    });
    expect(byCode(attack, 'anim/foot-slide')).toHaveLength(0);
    const sprint = validateDocument(gaitShape('sprint-fast', slideOffsets), {
      level: 'full',
      footElements: ['foot'],
    });
    expect(byCode(sprint, 'anim/foot-slide')).toHaveLength(1);
  });

  it('ignores footElements at fast level', () => {
    const findings = validateDocument(gaitShape('walk', slideOffsets), {
      footElements: ['foot'],
    });
    expect(byCode(findings, 'anim/foot-slide')).toHaveLength(0);
  });

  it('throws on a footElements name that does not exist (options error, not a finding)', () => {
    expect(() =>
      validateDocument(gaitShape('walk', slideOffsets), {
        level: 'full',
        footElements: ['hoof'],
      }),
    ).toThrowError(/'hoof'.*'foot'/s);
  });
});

describe('anim/hard-wrap — rotators and the engine default end handling', () => {
  const rotatorShape = (lastRotX: number, extra: Record<string, unknown> = {}): ShapeJson =>
    wrapNums({
      textureWidth: 16,
      textureHeight: 16,
      textures: { skin: 'x' },
      elements: [{ name: 'shaft', from: [0, 0, 0], to: [4, 4, 4] }],
      animations: [
        {
          name: 'spin',
          quantityframes: 10,
          onAnimationEnd: 'Repeat',
          keyframes: [
            { frame: 0, elements: { shaft: { rotationX: 0, rotationY: 0, rotationZ: 0 } } },
            {
              frame: 9,
              elements: {
                shaft: { rotationX: lastRotX, rotationY: 0, rotationZ: 0, ...extra },
              },
            },
          ],
        },
      ],
    }) as ShapeJson;

  it('a k·360° wrap is the same pose modulo 360 — continuous rotators are not snaps', () => {
    // devastation-gear pattern: 720° total rotation; raw delta 720, mod-360 delta 0.
    expect(byCode(validateDocument(rotatorShape(-720), { level: 'full' }), 'anim/hard-wrap'))
      .toHaveLength(0);
    // jonas gengearbox pattern: −348° with rotShortestDistance — mod-360 delta is 12°,
    // and the engine crosses it the short way; 12° > tolerance still warns…
    const f = byCode(validateDocument(rotatorShape(-348, { rotShortestDistanceX: true }), { level: 'full' }), 'anim/hard-wrap');
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain('12');
    expect(f[0]!.message).toContain('modulo 360');
    // …while −355° (mod-360 delta 5°) passes like the vanilla chicken/fish wraps do.
    expect(byCode(validateDocument(rotatorShape(-355), { level: 'full' }), 'anim/hard-wrap'))
      .toHaveLength(0);
  });

  it('a missing onAnimationEnd means Repeat (engine enum default) — the wrap is still checked', () => {
    const doc = wrapNums({
      textureWidth: 16,
      textureHeight: 16,
      textures: { skin: 'x' },
      elements: [{ name: 'tail', from: [0, 0, 0], to: [4, 4, 4] }],
      animations: [
        {
          name: 'loop',
          quantityframes: 10,
          // no onAnimationEnd: EnumEntityAnimationEndHandling member 0 = Repeat
          keyframes: [
            { frame: 0, elements: { tail: rot(0) } },
            { frame: 9, elements: { tail: rot(45) } },
          ],
        },
      ],
    }) as ShapeJson;
    expect(byCode(validateDocument(doc, { level: 'full' }), 'anim/hard-wrap')).toHaveLength(1);
  });
});
