# Engine ground truth

Facts extracted from the decompiled Vintage Story 1.22 sources. These are normative for this
codebase: when code here disagrees with this doc, the code is wrong; when this doc disagrees
with the decompiled source, the doc is wrong and must be fixed.

Decompiled sources (read-only, do not modify):

- `%APPDATA%/Vintagestory/temp_decomp_api/VintagestoryAPI.decompiled.cs` (API: ShapeElement, Animation, Mat4f)
- `%APPDATA%/Vintagestory/temp_decomp_lib/VintagestoryLib.decompiled.cs` (client: tesselator, atlas)
- `%APPDATA%/Vintagestory/temp_decomp_essentials/VSEssentials.decompiled.cs` (entity renderers/behaviors)
- `%APPDATA%/Vintagestory/temp_decomp/VSSurvivalMod.decompiled.cs`

Vanilla assets (read-only): `%APPDATA%/Vintagestory/assets/survival/` and `assets/game/`.
6,115 shape JSON files under `assets/survival/shapes/` — that is the acceptance corpus.

## 1. Units and coordinate system

- `from`/`to`/`rotationOrigin` are in **1/16 of a block**. The engine divides by 16 everywhere
  (`From[0] / 16f`, `RotationOrigin[0] / 16f`, keyframe `OffsetX / 16f`).
- Y is up. The engine is right-handed with `north = -Z` (VS convention; face name mapping in §4).
- Rotations are degrees in JSON, converted with `deg * PI / 180`.

## 2. Element local transform — `ShapeElement.GetLocalTransformMatrix`

`VintagestoryAPI.decompiled.cs:148741`. All `Mat4f` ops post-multiply in place
(`M = M · op`). Given `origin = rotationOrigin/16` (0,0,0 if absent), element fields
`RotationX/Y/Z` (degrees, default 0), `ScaleX/Y/Z` (default 1), and an animation pose `tf`
(`translate*` in blocks, `deg*` in degrees, `scale*` default 1):

**animVersion == 0 (the default, used by almost all vanilla):**

```
M = T(origin)
  · R(RotationX + tf.degX, RotationY + tf.degY, RotationZ + tf.degZ)
  · S(ScaleX·tf.scaleX, ScaleY·tf.scaleY, ScaleZ·tf.scaleZ)
  · T(from/16 + tf.translate − origin)
```

**animVersion == 1:**

```
M = T(origin)
  · S(ScaleX, ScaleY, ScaleZ)
  · R(RotationX, RotationY, RotationZ)
  · T(−origin + from/16 + tf.translate)
  · S(tf.scaleX, tf.scaleY, tf.scaleZ)
  · R(tf.degX, tf.degY, tf.degZ)
```

`animVersion` is the **animation's** `version` JSON field (Animation.Version), not the
shape's. The static pose (no animation) uses identity `tf`, where both formulas collapse to
`T(origin) · R(elem) · S(elem) · T(from/16 − origin)`.

Children accumulate: `world = parentWorld · local`, recursively
(`Animation.GenerateFrame`, :143603). Element box geometry in local space spans
`[0, (to−from)/16]` per axis (the `from` offset is inside the local matrix).

## 3. Rotation order — `Mat4f.RotateByXYZ`

`VintagestoryAPI.decompiled.cs:20294`. Builds the combined matrix `R = Rx · Ry · Rz` and
post-multiplies. A column vector is therefore rotated by **Z first, then Y, then X**.
Verified by expanding the matrix entries (e.g. `m00 = cy·cz`, `m10 = sx·sy·cz + cx·sz`,
`m20 = −cx·sy·cz + sx·sz`).

## 4. Faces

Face keys: `north, east, south, west, up, down`. Each face: `texture` (`#key` reference into
the shape's `textures` map), `uv: [u1, v1, u2, v2]` in shape-UV units (bounded by
`textureWidth`/`textureHeight`), optional `rotation` (0/90/180/270), optional `glow`,
`enabled`, `reflectiveMode`, `windMode`, `windData`. The exact vertex-corner ↔ UV-corner
mapping and face winding live in the client tesselator — see
`docs/ground-truth/tesselator.md` (extracted separately).

## 5. Animation data model

`Animation` (`VintagestoryAPI.decompiled.cs:143514`): JSON fields `name`, `code` (defaults to
`name` when absent), `version`, `quantityFrames`, `easeAnimationSpeed`,
`onActivityStopped` (default `Rewind`), `onAnimationEnd` (default `Repeat` — the enum's
member 0, `:143491`/`:143538`), `keyFrames`.
JSON key casing in files is lower camelCase (`quantityframes` also accepted — Newtonsoft is
case-insensitive; vanilla files write `quantityframes`). The validator flags off-canonical
casing (`shape/key-casing`) because this codebase reads exact-case keys.

`AnimationKeyFrame`: `frame` (int), `elements` (map: **element name string** → keyframe element).

`AnimationKeyFrameElement` (`:144039`): `offsetX/Y/Z`, `rotationX/Y/Z`, `stretchX/Y/Z`,
`originX/Y/Z` (parsed but unused by frame generation), `rotShortestDistanceX/Y/Z` (bools).

**Hard rule** (`:143606`): `quantityframes` must be **strictly greater** than every keyframe's
`frame`, or the engine throws on load.

**Joint cap** (`:143582`): the engine throws when the joint count **reaches**
`GlobalConstants.MaxAnimatedElements` (`jointsById.Count >= Max` — a count equal to the cap
already fails; default cap is low — the error message suggests raising the client setting
to 46). Entity animator load paths additionally pass `head` as `requireJointsForElements`
(`:155457`), so an existing-but-unkeyed `head` element costs one extra joint
(`ResolveAndFindJoints`, `:148122-148136`). Validator warns when the effective count ≥ 31.

**stepParentName** (`Shape.StepParentShape`, `:147876`): an attach-time overlay mechanism —
the element is re-parented under the named element of the PARENT shape when this shape is
overlaid onto it. Loading/rendering a shape standalone never consults it; fk intentionally
ignores it (validator emits a `shape/step-parent` note).

## 6. Keyframe interpolation — `Animation.GenerateFrameForElement` (:143638)

- Three **independent channels** per element: 0 = offset, 1 = rotation, 2 = stretch.
  A keyframe element participates in a channel only if any of that channel's three
  components is non-null (`PositionSet`/`RotationSet`/`StretchSet`, :144102).
- Interpolation is **plain linear lerp** per component (`GameMath.Lerp`). No easing curves.
- The lerp reads all three components of a channel via `.Value` (`:143675`) — i.e. the engine
  assumes that when a channel is set, **all three components are present**. A keyframe element
  with e.g. only `offsetX` would NPE in the engine. Validator: error on partial channel triples.
- Keyframe seek wraps around the cycle (`seekRightKeyFrame`/`seekLeftKeyFrame`,
  :143713/:143735): the "right" keyframe is the first one (in array order) with
  `frame > current` that has the channel set, else the first set one (wrap); the "left" is
  the nearest set one scanning backwards (wrap). When wrapping
  (`right.Frame < left.Frame`): `span = right.Frame + (quantityFrames − left.Frame)`,
  `t = mod(frame − left.Frame, quantityFrames) / span`.
- Offsets are divided by 16 into block units; rotations stay degrees; stretch is a scale factor.
- `rotShortestDistance*` flags are carried per-pose from the left keyframe (`:143661-143663`)
  and the runtime lerp between generated keyframe frames (`ElementPose.Add`, `:146322-146354`)
  then takes the **shortest angular path** for each flagged axis:
  `deg = left + GameMath.AngleDegDistance(left, right) · l` (`AngleDegDistance` `:15323` =
  `((end − start) % 360 + 540) % 360 − 180`). This applies to **single-animation playback**
  (the `l`-lerp is between two keyframe frames of ONE animation; `weight` handles
  cross-animation mixing) — continuous rotators (gencore, gengearbox, hurdygurdy…) depend on
  it at the cycle wrap. An earlier revision of this doc claimed the flags only affect
  cross-animation blending; that was wrong.
- **Hold end-clamp** (`ClientAnimator.calculateMatrices`, `:146147-146151`): when
  `onAnimationEnd == Hold` and `(int)CurrentFrame + 1 == QuantityFrames`, the `next` frame is
  replaced by `prev`, and `RunningAnimation` parks `CurrentFrame` at `QuantityFrames − 1`
  (`:147168-147179`) — the held resting pose is the LAST keyframe's generated frame, not a
  wrap-lerp toward frame 0.
- **Unsorted keyframe arrays**: the runtime segment lookup (`getLeftRightResolvedFrame`,
  `:143749-143772`) scans the keyframe ARRAY from the end for `FrameNumber <= frame` — array
  order, not frame order — and disagrees with the generation-time per-channel seek on
  out-of-order arrays (4 vanilla animations: elk/moose `walkback`). This codebase follows the
  generation-time mechanism and warns (`anim/unsorted-keyframes`).

## 7. Entity / shape integration facts (from SPEC + vanilla files)

- Animations are addressed from entity files by `code`, with `blendMode`, `easeInSpeed`,
  `easeOutSpeed`, `triggeredBy`. Out of scope for v1 except validation that codes exist.
- Frame rate convention is 30 fps (`quantityframes: 30` ≈ 1 s).
- Walk animations are authored in place; the game moves the entity.

## 8. File format empirics (fox-male.json and corpus)

- **CRLF** line endings, **tab** indentation.
- Number arrays inline with spaces: `[ 4.0, 4.0, 6.0 ]`.
- Doubles serialized with trailing `.0` (`4.0`, `1.0`); face `rotation` and `frame` as ints.
- Face objects inline on one line: `"north": { "texture": "#skin", "uv": [ 0.0, 4.0, 4.0, 8.0 ], "rotation": 270 },`.
- Empty objects as `{` CRLF `}` (see `"textureSizes": {`/`}`).
- Top-level key order in model-creator files: `editor`, `textureWidth`, `textureHeight`,
  `textureSizes`, `textures`, `elements`, `animations`.
- Element key order: `name`, `from`, `to`, `unwrapMode?`, `unwrapRotation?`, `uv?`,
  `rotationOrigin?`, `rotationX/Y/Z?`, `faces`, `children?`.
- These are *observed* conventions; the byte-stable round-trip test over the 6,115-file corpus
  is the real referee. Document any divergent file classes found
  (hand-edited files, older model-creator versions) in `docs/ground-truth/format-empirics.md`.
