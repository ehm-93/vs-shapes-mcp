# Spec: LLM-First Model Editor and Animator for Vintage Story

Working name: **Menagerie**. The unit of work is a creature, not a file. Input is a description ("a swamp deer, skittish, vanilla-styled"). Output is everything the game needs: shape JSON with animations, texture PNGs, and an entity JSON patch. A human steers by picking variants and giving notes. An LLM agent does all the bookkeeping.

This spec is grounded in the vanilla survival assets (verified against `shapes/entity/animal/mammal/fox/fox-male.json` and `entities/animal/mammal/fox-adult.json`).

## 1. Format facts the design must respect

These are observations from the actual files, listed because each one constrains the design.

1. A shape file is a single JSON document containing `textureWidth`/`textureHeight`, a `textures` map, an `elements` tree, and an `animations` array. Model and animations live together.
2. Elements are axis-aligned cuboids: `from`/`to` in units of 1/16 block, an optional `rotationOrigin` plus `rotationX/Y/Z` in degrees, and six `faces` each with a UV rect and optional `rotation` (0/90/180/270). `unwrapMode` and `unwrapRotation` are editor hints for auto-UV.
3. Elements nest. The fox runs five levels deep (body > neck > head > mouth > jaw). The element tree **is** the skeleton; there are no separate bones.
4. Element names are arbitrary strings with spaces and inconsistent conventions in vanilla (`"L ear"`, `"left front feet"`, `"R back leg"`). Animations reference elements **by name string**. A rename that doesn't cascade into every keyframe silently breaks animation.
5. Animations have `name`, `code`, `quantityframes`, `onActivityStopped` (e.g. `EaseOut`), `onAnimationEnd` (e.g. `Repeat`), and `keyframes`. Each keyframe has a `frame` index and an `elements` map of per-element `offsetX/Y/Z` and `rotationX/Y/Z`. The engine interpolates between keyframes. Frame rate is 30 fps by convention (`quantityframes: 30` for a 1 s loop).
6. Entity files are JSON5-flavored: unquoted keys, trailing commas, comments. They define `variantgroups` with `{placeholder}` substitution into shape and texture paths, `hitboxSize`, behaviors, and a `client.animations` list that wires shape animation codes to `blendMode` (`Average`, `AddAverage`), `easeInSpeed`/`easeOutSpeed`, `weight`, `animationSpeed`, and triggers (`triggeredBy: { defaultAnim: true }`, `onControls: ["dead"]`).
7. Entity textures are small PNGs under `textures/entity/...`. The PNG resolution exceeds the shape's UV space: the fox declares `textureWidth: 32` but ships a 64x64 PNG, scale factor k=2, which is why vanilla UV coords have half-unit values. Vanilla textures are softly shaded, not palette-limited (the fox has 2,274 distinct colors), so any quantizing import path must operate on small local regions, never the whole sheet.
8. Walk-style animations are authored in place; the game moves the entity. Ground contact correctness is therefore about stance-foot velocity relative to the root, not absolute position.

## 2. Architecture

Five components around one artifact store:

```
                 +--------------+
  user chat ---> |  Agent loop  | <--- reference corpus (vanilla index)
                 +------+-------+
                        | tool calls
        +---------------+------------------+
        |               |                  |
   Document API    Render service    Validation suite
        |               |                  |
        +-------+-------+--------+---------+
                |                |
          Artifact store    Texture compiler
       (shape, textures,
        entity patch, log)
```

- **Agent loop**: an LLM with the tool API below. Holds the conversation, plans edits, reads renders and validation results.
- **Document API**: typed, transactional operations over the shape document. The only writer. Owns name cascading, undo, and branching.
- **Render service**: headless renderer that replicates the game's look. The agent's eyes.
- **Texture compiler**: turns a declarative texture program into PNG pixels.
- **Validation suite**: deterministic checks run after every transaction. The agent only sees failures.
- **Reference corpus**: indexed vanilla shapes with precomputed stats, for retrieval and style conformance.

Everything is local-first: a CLI/daemon plus a thin web UI for the variant grid and render review. No game installation modification; output is a standard mod folder.

## 3. Document model

The in-memory model is a typed wrapper over the shape JSON, not a new format. Round-trips byte-stable JSON (tab indentation, key order preserved) so diffs against vanilla-style files stay readable.

Additions the wrapper maintains as a sidecar (`.menagerie.json`, never shipped):

- **Stable IDs.** Every element gets a UUID. Display names remain the JSON `name` field. All internal references use IDs; serialization resolves to names. This makes rename-cascading mechanical (fact 4).
- **Roles.** Optional semantic tags per element: `role: foot.front.left`, `role: head`, `role: tail.tip`. Animation templates and validators target roles, not names, so they work across vanilla's inconsistent naming.
- **Symmetry pairs.** Declared L/R pairings (`L ear` <-> `R ear`). Mirror operations and the symmetry validator use these.
- **Intent notes.** Free-text annotations per element or animation ("ears oversized on purpose, it's a fennec"). Fed back into agent context on later sessions.

Transactions: every tool call that mutates the document is a transaction with a human-readable summary. The store keeps a linear history per branch and supports cheap branching (copy-on-write of the JSON tree). The variant grid in §9 is four branches.

## 4. Tool API (the agent's action space)

Grouped by service. All tools return structured JSON. Errors name the entities involved and, where possible, the feasible fix (the "errors are the product" rule).

### Query

| Tool | Returns |
|---|---|
| `shape.describe(level)` | `summary` (one paragraph), `tree` (names, depths, box sizes, roles), or `full` (one element subtree in detail) |
| `shape.measure(...)` | bounds of any element or the whole model, in 1/16-block units and in blocks; distances between element anchors |
| `shape.find(role \| name_glob)` | matching element IDs |
| `anim.describe(code)` | frame count, looping mode, which elements it touches, per-element rotation ranges |
| `uv.report()` | texture occupancy map, overlaps, out-of-bounds rects, unused texture area |

### Geometry

| Tool | Action |
|---|---|
| `shape.add_box(parent, name, from, to, opts)` | add element; auto-assigns UV via unwrap if `opts.autouv` |
| `shape.edit_box(id, patch)` | change `from`/`to`/`rotationOrigin`/`rotationX/Y/Z`; patch semantics, only listed fields change |
| `shape.rename(id, name)` | renames and cascades through every keyframe in every animation |
| `shape.reparent(id, new_parent)` | preserves world position by recomputing local coords |
| `shape.mirror(id_or_subtree, axis)` | creates or syncs the symmetry pair; registers the pairing |
| `shape.scale(subtree, factor, anchor)` | proportional scaling with rotationOrigin correction |
| `shape.delete(id)` | refuses if animations reference it, unless `force`, in which case keyframe entries are stripped and reported |

### Animation

| Tool | Action |
|---|---|
| `anim.create(code, template, params)` | instantiate a template (§7): `quadruped.walk`, `quadruped.run`, `idle.breathe`, `die.collapse`, `hurt.flinch`, etc. Params: cycle length, stride, gait (walk/trot/pace/bound), weight feel |
| `anim.set_key(code, frame, element, pose)` | set offset/rotation for one element at one frame |
| `anim.adjust(code, element, channel, fn)` | apply a function across all keyframes: scale amplitude, add phase offset, clamp |
| `anim.retime(code, new_frames)` | resample keyframes to a new length |
| `anim.mirror_phase(code)` | copy first half to second half with L/R swapped via symmetry pairs (gait cycles) |
| `anim.copy(code, from_creature)` | retarget an animation from a corpus creature with matching roles; reports unmapped elements |

### Texture

| Tool | Action |
|---|---|
| `tex.program.set(program)` | replace or patch the declarative texture program (§6) |
| `tex.compile()` | program -> PNG(s); returns palette and a rendered preview |
| `tex.import(png, region)` | accept hand-made or diffusion-made pixels into a named region; recorded as an opaque layer the program preserves |
| `uv.layout(strategy)` | repack all face UVs (per-element strips, vanilla-style); rewrites face rects and the texture program's region map together |

### Perception

| Tool | Returns |
|---|---|
| `render.views(opts)` | PNG grid: default 8 yaw angles x 1 pitch, plus top and front orthographic; game lighting, optional vanilla-creature overlay at matched scale; optional hitbox wireframe |
| `render.anim(code, opts)` | filmstrip (N frames side by side) or GIF; optional ground line and stance-phase markers |
| `render.compare(branch_a, branch_b)` | side-by-side renders of two branches |

### Game integration

| Tool | Action |
|---|---|
| `game.entity.scaffold(params)` | generate the entity JSON: variantgroups, hitbox from measured bounds, behavior preset (passive grazer / skittish prey / predator), `client.animations` wiring with sane blend modes copied from the closest vanilla analog |
| `game.package()` | emit a loadable mod folder: `modinfo.json`, shapes, textures, entity files, optional lang entries |
| `validate.run()` | full suite (§8); also runs automatically after every transaction |
| `corpus.search(query)` | vanilla creatures matching a description, with stats (§10) |

Granularity follows the earlier principle: primitives with predictable semantics, plus templates whose expansion the agent can inspect (`anim.create` returns the keyframes it wrote, not magic).

## 4a. Escape hatch: rings

The curated tools are the paved road, not a wall. The agent must never be blocked by a missing tool, so the system exposes three rings, all writable, with the validation suite (not the API) as the guarantor of invariants.

**Ring 0: raw artifact.** `doc.read_json()` and `doc.patch_json(patch)` operate on the shape JSON directly with JSON-patch semantics, inside a normal transaction. After any raw edit, the sidecar reconciler re-links element IDs by name and geometry matching and flags ambiguities; this is the same machinery used to re-import files edited in the official model creator. Direct writes to atlas PNGs are detected by the broker via hash check and either absorbed as face-local diffs or the texture is marked **detached**, meaning the texture program is no longer source of truth for it. Detached mode is also how fully hand-made textures enter the pipeline.

**Ring 1: scripting sandbox.** `doc.exec(python)` runs agent-authored code against the typed document model, with `doc`, `anim`, `tex`, `broker`, and `corpus` handles in scope. Sandbox properties: no filesystem or network access, seeded RNG, time and memory caps, document-in document-out. The script runs inside a transaction; exceptions roll back. This is the home of procedural work the tool API will never enumerate: generating N tapered spine segments, custom secondary motion, one-off IK solves, batch UV surgery.

**Ring 2: curated tools.** The tools in §4 and the animation templates in §7 are implemented as scripts in a standard library the agent can read, fork, and modify. When a template misbehaves, the agent opens its source instead of guessing. **Promotion path:** a ring-1 script that proved useful gets named, parameterized, documented, and saved into the library as a new ring-2 tool. The tool library grows from use.

Two consequences:

- The validation suite becomes load-bearing. Every invariant previously implicit in tool behavior gets an explicit check: sidecar-to-tree consistency, animation name references, UV pixel alignment at scale k, and the no-stored-atlas-coordinates rule (now a lint over the sidecar and diff store, since scripts could violate it).
- Transactions record the script or patch that produced them, so the edit history is itself a program. Replaying the log regenerates the creature. The shipped artifact stays plain game JSON; the *history* is the parametric representation.

## 5. Render service

Headless, deterministic, and faithful to the engine, in this priority order:

1. **Geometry fidelity.** Cuboid construction from `from`/`to`, rotation about `rotationOrigin`, parent-child transform accumulation, and animation interpolation must match the engine. This is the part that must be verified against the actual game (the VS API and client model code are publicly readable); rotation order and interpolation easing are the two likely traps. Acceptance test: render every vanilla creature in its idle pose and diff against in-game screenshots to within small tolerance.
2. **Texture fidelity.** Per-face UV rects with quarter-turn rotations, nearest-neighbor sampling, alpha cutout.
3. **Lighting approximation.** The game's simple directional face shading is enough; no need for shadows or ambient occlusion.

Output conventions tuned for LLM consumption:

- Fixed camera set with stable naming so the agent can say "the 3/4 front-left view".
- Scale bar and ground plane in every render.
- A "20-block readability" thumbnail: the model rendered at the on-screen size it would have at typical sighting distance. Silhouette problems show up here first.
- Animation filmstrips default to 8 evenly spaced frames with the frame number burned in, because GIFs cost more tokens than strips and the agent mostly needs pose-at-phase, not motion blur.

## 6. Texture compiler

Textures are authored as a program, compiled to pixels. The program is JSON the agent reads and writes:

```json
{
  "palette": {
    "fur":      "#a85f32",
    "fur_dark": "auto:shade(fur, -25%)",
    "belly":    "#e8d9c4",
    "eye":      "#1a1a1a"
  },
  "rules": [
    { "select": "element:*",                "fill": "fur" },
    { "select": "element:body face:down",   "fill": "belly" },
    { "select": "role:tail.tip",            "fill": "belly" },
    { "select": "element:head face:north",  "ops": [
        { "pixels": [[1,1],[3,1]], "color": "eye" }
    ]},
    { "select": "element:* face:down",      "ops": [ { "shade": -15 } ] },
    { "noise": { "select": "element:body", "color": "fur_dark", "density": 0.06, "seed": 7 } }
  ],
  "layers": [ { "import": "hand_detail_01", "mode": "over" } ]
}
```

Properties that matter:

- **Selectors target geometry, not pixels.** The compiler resolves selectors through the UV map, so re-laying-out UVs doesn't break the texture. This is the whole reason to compile rather than paint.
- **Deterministic.** Same program plus same UV layout gives identical pixels (seeded noise). Renders are reproducible across sessions.
- **Escape hatch.** Hand and tool-made pixel edits arrive through the UV broker (§6a) as sparse diffs in face-local coordinates, layered over the compiled baseline. Reprogramming or re-laying-out UVs replays the diffs.
- **Variant-aware.** Palette swaps produce the `{type}` variants (red fox / arctic fox pattern from vanilla) from one program.

## 6a. UV broker

Pixel editing happens in an external pixel-art tool operating on ordinary canvases. The broker is the bidirectional mapping between those canvases and the game's atlas plus shape JSON. "Split and merge" means two distinct things here; the broker does both.

**Scale detection.** The atlas pixel space is `k` times the shape's UV space (`k = png_width / textureWidth`; fox: 64/32 = 2). The broker detects k per texture and rasterizes UV rects to pixel rects at that scale. Any rect that doesn't land on integer pixels at scale k is a lint error.

**Sense one: atlas <-> workspace round trip.**

- `split(scope)` takes an element, subtree, or the whole sheet. For each face: crop the atlas rect at scale k, inverse-apply the face's UV rotation, place into an unfolded box net with normalized orientation (texture-up = world-up on every face). Emits a pixel-art document: one layer per element, one saved selection per face, palette quantized per scope only (local regions have few colors; the whole sheet does not, see format fact 7). A baseline snapshot is recorded.
- `merge(doc)` exports the document, forward-rotates each face region, writes into the atlas rects, then runs seam lint.
- **Edge table.** The broker records which workspace edges correspond to which 3D-adjacent face edges, including adjacencies the net layout could not make contiguous. Used for propagating fills and outlines across seams, and for seam lint: after merge, border pixel rows of 3D-adjacent faces are compared and mismatches above threshold are reported with both face names.

**Sense two: UV sharing management.** Vanilla shapes reuse atlas rects across faces and elements. Each shared rect gets a designated owner face; others are readers.

- **Fork on divergent write.** An edit through a reader face allocates fresh atlas space, rewrites that face's UVs in the shape JSON, copies the pixels, then applies the edit. This is what makes "darken only the left ear" safe when the ears share a rect.
- **Dedupe on pack.** At packaging time, hash every face's pixel region; identical regions collapse back to shared rects, UVs are rewritten, atlas space is reclaimed and the sheet repacked.

Both directions modify the shape JSON, not just the PNG, so the broker sits between the document model and the pixel tool rather than inside either.

**Diff persistence.** After merge, the broker diffs the result against the compiled texture-program baseline and stores only the sparse diff, keyed in face-local coordinates. Program re-runs and UV relayouts replay diffs into the new layout. The program remains the source of truth for everything untouched; hand work survives everything else.

**Correctness anchor.** `merge(split(x)) == x` bit-exact when no edits were made, run as a CI test over every vanilla entity texture. Passing it across the corpus proves the rotation, scale, and sharing conventions are decoded correctly.

## 7. Animation system

Three layers: templates, edits, checks.

**Templates** are parametric generators for the standard animation set, implemented as ring-2 library scripts (§4a) the agent can read and fork. Minimum library: `walk`, `run`, `idle`, `sit`, `lie`, `sleep`, `hurt`, `die`, `eat`, plus a `swim` and `fly` family later. Each template targets **roles** (`foot.front.left`, `spine.1`, `head`, `tail.*`) so it works on any rigged shape. Parameters are language-shaped: cycle seconds, gait pattern, stride length, weight ("heavy" lowers frequency, raises body bob amplitude, delays foot lift), head bob on/off. A template expands to ordinary keyframes; nothing downstream knows templates exist.

Templates are derived from vanilla. Build step one is fitting the template parameters to every vanilla creature's animations and checking that the regenerated animation is close to the original. That both validates the templates and produces per-creature parameter values the corpus can serve as style references ("the vanilla wolf walks at X stride, Y bob").

**Edits** go through `anim.set_key` and `anim.adjust`. The agent rarely authors a full cycle by hand; it instantiates a template and adjusts.

**Checks**, run by the validator on any animation marked as locomotion:

- **Foot slide.** Forward-kinematics the element tree per frame, track each `foot.*` role's bottom-center world position. During each foot's stance phase (lowest 20% of its height trajectory), its horizontal velocity must be constant within tolerance. Reported as a per-foot score plus the worst frame, so the agent knows exactly where to look.
- **Cycle closure.** Pose at the final frame must match frame 0 within tolerance for `onAnimationEnd: Repeat` animations.
- **Gait sanity.** Phase offsets between feet match the declared gait (walk: 0/0.5/0.25/0.75; bound: pairs together).
- **Ground clamp.** No stance foot below y=0, no body element intersecting the ground during locomotion.
- **Rotation sanity.** Per-joint rotation ranges within configurable anatomical limits, defaults learned from the corpus (vanilla knees don't exceed roughly +-130 degrees).

## 8. Validation suite

Runs after every transaction; full run before packaging. All findings carry entity names, locations, and where computable, the feasible fix. Severity: `error` blocks packaging, `warn` surfaces to the agent, `note` is logged.

Shape:
- JSON validates against the shape schema; unknown keys warned, not stripped.
- Every `from` <= `to` per axis; zero-thickness boxes allowed (vanilla uses them for ears) but flagged as `note`.
- Every face UV rect within `textureWidth`/`textureHeight`; overlapping UV rects across different elements warned unless declared shared.
- Element names unique within the file (animations key on them).
- Symmetry pairs geometrically consistent (mirror within tolerance) unless annotated asymmetric.

Animation:
- Every element name in every keyframe exists in the tree (the silent-rename failure, made loud).
- `quantityframes` > max keyframe `frame`.
- Locomotion checks from §7.

Texture:
- Compiled texture dimensions match `textureWidth`/`textureHeight` ratio expectations and are powers of two.
- Palette size under a configurable cap (vanilla-style: warn above ~24 colors per creature).

Entity wiring:
- Every animation `code` referenced in `client.animations` exists in the shape.
- Every `{placeholder}` in shape/texture paths resolves for every variant combination, and every resolved path exists in the output set.
- `hitboxSize` encloses the model's idle-pose bounds within tolerance, and the model doesn't exceed the hitbox by more than the engine tolerates.
- Behavior preset references only behaviors that exist in the target game version.

Game-load smoke test (optional, highest confidence): launch a headless or windowed VS instance with the packaged mod and a test world, spawn the entity, capture log errors. Slow, so it runs on demand and before release, not per edit.

## 9. Interaction model

The human is the taste function. Two loop shapes:

**Variant grid.** Open-ended requests ("make me a heron") fan out to four branches with deliberately different parameter choices (proportion, stylization level, palette). Each renders the standard view grid. The human picks one; the other branches stay in history as rejected-variant context the agent can cite later ("you disliked the long-neck version").

**Converse and render.** On the chosen branch, every user note becomes one or more transactions, then an automatic re-render of the views that changed (geometry edit: full grid; animation edit: filmstrip; texture edit: two views). The user sees before/after pairs, not just after.

Session memory is the artifact: intent notes, the transaction log with summaries, and rejected variants all live in the sidecar, so a fresh agent instance can resume a creature cold.

## 10. Reference corpus

An index built once from the installed game's `assets/survival`:

- Every shape parsed; per-creature stats precomputed: element count, tree depth, bounding box, per-role box dimensions, texture size, palette, animation list with fitted template parameters (§7).
- Embedding index over creature descriptions for `corpus.search`.
- Style priors derived from the population: typical leg thickness as a fraction of body height, typical element counts by creature size class, palette saturation ranges. The validator's `note`-level style warnings ("element count 3x higher than any vanilla creature of this size") come from these.

The corpus rebuilds against whatever game version is installed, so the tool tracks the game without shipping its assets.

## 11. Outputs

`game.package()` emits a standard mod:

```
mymod/
  modinfo.json
  assets/mymod/
    shapes/entity/animal/.../swampdeer-male.json
    textures/entity/animal/.../brown-male.png
    entities/animal/.../swampdeer-adult.json
    lang/en.json            (creature name entries)
```

Shape JSON is emitted vanilla-style (tabs, key order, `editor` block included) so it opens cleanly in the official model creator. That is the compatibility contract: a human can always take the artifact into the existing tooling, and a file edited there can be re-imported (the sidecar re-links elements by name and geometry matching, flagging ambiguities).

## 12. Non-goals (v1)

- Humanoid clothing/armor shapes and the player skin system.
- Particle effects, sounds, AI task tuning beyond the behavior presets.
- Non-cuboid geometry. The format doesn't have it; neither do we.
- Free pixel painting in-tool. Imports cover it.
- Multi-creature scenes.

## 13. Build order

1. **Parser and document model.** Round-trip every vanilla shape byte-stable. JSON5 reader for entity files. Sidecar, IDs, transactions.
2. **Renderer.** Acceptance-tested against in-game screenshots of vanilla creatures. This is the long pole; nothing downstream is trustworthy without it.
3. **Validation suite** minus animation kinematics.
4. **Tool API + agent loop**, with the ring-1 scripting sandbox and ring-0 patch access from the start; geometry and query tools first. The sandbox comes early because curated tools and templates are built as library scripts on top of it. At this point the tool can already do useful resizing/kitbashing of vanilla shapes.
5. **Texture compiler** and UV layout.
6. **Animation templates** fitted to vanilla, kinematic checks, filmstrip rendering.
7. **Entity scaffolding, packaging, corpus, variant-grid UI.**
8. **Game-load smoke test** harness.

## 14. Risks and open questions

- **Engine fidelity.** Rotation order, interpolation easing, and `unwrapMode` semantics must be confirmed from the game/client source rather than inferred. Budget real time for step 2's acceptance test; everything rests on it.
- **Texture program expressiveness.** The selector/rule design is a hypothesis, and the soft-shading finding raises the bar: vanilla textures carry thousands of colors, so program rules need gradient and dither ops, not just flat fills, or the broker's diff layers end up carrying most of the texture. Prototype against the fox face mask before committing to the rule schema.
- **Template retargeting across body plans.** Role-based templates should transfer between quadrupeds; birds and fish will need their own families and may expose role-taxonomy gaps.
- **Validator completeness.** The escape hatch (§4a) shifts invariant enforcement from API behavior to detection. Any invariant without a corresponding check is now silently breakable by a ring-0 or ring-1 edit. The mitigation is mechanical: every invariant added anywhere in this spec must land as a validator in §8, and the CI corpus run exercises them against raw-patched vanilla files.
- **Version drift.** Entity behavior schemas change across game versions. The behavior presets and validator need a per-version capability table; the corpus rebuild handles shapes automatically.
- **License.** The corpus indexes the user's installed assets locally and ships nothing from them. Outputs must contain only generated content. Keep it that way.
