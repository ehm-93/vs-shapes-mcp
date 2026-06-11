# vs-shapes-mcp — v1 architecture

An MCP server that lets an LLM agent open, inspect, edit, animate, validate, and **render**
Vintage Story shape files. v1 implements SPEC.md build-order steps 1–4 plus a renderer:
document model, geometry/animation tools, validation suite, headless renderer, corpus access.
Texture compiler, UV broker, animation templates, entity scaffolding, and packaging are
explicitly out of scope for v1.

The agent loop is the MCP client (Claude). This server is the Document API, Render service,
Validation suite, and Reference corpus from SPEC §2.

## Stack

- TypeScript, ESM (`"type": "module"`), Node ≥ 22. No native deps (must run via `npx` clean).
- `@modelcontextprotocol/sdk` (stdio transport), `zod` for tool input schemas.
- `pngjs` for PNG decode/encode. `lossless-json` available if useful for the parser.
- `vitest` for tests; `tsx` for dev runs.
- Game install discovery: `--game-path <dir>` CLI arg, else `VINTAGE_STORY` env var, else
  `%APPDATA%/Vintagestory`. All corpus/texture reads resolve from
  `<game>/assets/survival` then `<game>/assets/game`.

## Layout and module ownership

```
src/
  index.ts             entry point: arg parsing, stdio server startup     (owner: server)
  server.ts            McpServer wiring, all tool registrations           (owner: server)
  session.ts           open-document registry, doc ids                    (owner: server)
  vs/
    types.ts           shape JSON + plain-object types                    (written up front, shared)
    json.ts            lossless parse/serialize, VS model-creator style   (owner: json)
    document.ts        ShapeDocument: tree access, transactions, undo     (owner: doc)
    elements.ts        geometry ops (add/edit/rename/reparent/mirror/...) (owner: doc)
    uv.ts              uv report + simple per-face auto-UV                (owner: doc)
    animation.ts       anim CRUD ops (create/set_key/adjust/retime/...)   (owner: doc)
    transform.ts       Mat4 + GetLocalTransformMatrix port                (owner: fk)
    fk.ts              pose evaluation: doc + (anim, frame) → world boxes/faces (owner: fk)
    validate.ts        validation suite                                   (owner: validate)
  render/
    raster.ts          z-buffered quad rasterizer onto RGBA buffer        (owner: render)
    camera.ts          orthographic cameras, fit-to-bounds                (owner: render)
    font.ts            tiny bitmap font for labels                        (owner: render)
    gpu.ts             WebGPU (Dawn) backend: same scene-job contract     (owner: views)
    backend.ts         SceneJob type + backend selection (gpu→software)   (owner: views)
    textures.ts        texture loading, k-scale, fallback flat colors     (owner: views)
    views.ts           view grid / filmstrip composition → PNG buffer     (owner: views)
  corpus/
    corpus.ts          game asset discovery, search, stats                (owner: corpus)
tests/                 vitest; one file per module + acceptance/
docs/ground-truth/     extracted engine facts (tesselator.md, format-empirics.md)
```

Each owner builds its own files and its own tests. Modules communicate ONLY through the
interfaces below; if an interface is wrong, fix it at integration, not by reaching into
another module's internals.

## Core data model (`vs/types.ts` — shared, authored up front)

The document tree is the parsed JSON kept as mutable plain objects, with all numbers wrapped
as `VsNum` (preserves the original literal until edited). See types.ts for the exact shapes:
`ShapeJson`, `ElementJson`, `FaceJson`, `AnimationJson`, `KeyFrameJson`,
`KeyFrameElementJson`, `VsNum`, plus plain-number mirrors (`ElementPlain`, etc.) returned by
query APIs.

## `vs/json.ts` (lossless JSON)

```ts
parseVsJson(text: string): JsonValue        // JsonValue = VsNum | string | boolean | null | JsonValue[] | { [k]: JsonValue }
serializeVsJson(value: JsonValue): string   // VS model-creator style (CRLF, tabs, inline rules)
vsnum(n: number): VsNum                     // wrap a fresh number
numValue(v: VsNum): number
formatVsNumber(n: number, style: 'double' | 'int' | 'auto'): string
```

- Parse must preserve: key order, number literals (raw string), and nothing else (no
  comments in shape files; reject with a clear error if encountered).
- Serialize rules (from GROUND-TRUTH §8): CRLF; tabs; number arrays inline with
  `[ a, b, c ]` spacing; face objects inline; keyframe element objects inline (check corpus);
  empty object `{}` split across two lines when it is a standalone value; edited/fresh
  numbers format per field convention (from/to/uv/origin/offsets → `double` style with
  trailing `.0` when integral; frame/rotation-quarter-turns/ints → `int`). Field→style table
  derived empirically; keep it in json.ts and document it.
- **Acceptance: `serializeVsJson(parseVsJson(text))` is byte-identical for ≥ 99% of the
  6,115-file corpus**, and 100% for `shapes/entity/**`. The acceptance test
  (`tests/acceptance/roundtrip.test.ts`) reports the rate and writes the list of divergent
  files + first-diff context to `tests/acceptance/roundtrip-failures.txt` when below target.

## `vs/document.ts`

```ts
class ShapeDocument {
  static parse(text: string, opts?: { path?: string }): ShapeDocument
  static create(opts: { textureWidth: number; textureHeight: number }): ShapeDocument
  readonly root: ShapeJson                       // live tree (mutate only via ops/transactions)
  serialize(): string
  // element addressing is BY NAME (validator enforces uniqueness)
  getElement(name: string): ElementJson | undefined
  parentOf(name: string): ElementJson | null     // null = root level
  walk(cb: (el: ElementJson, path: ElementJson[]) => void): void
  listAnimations(): AnimationJson[]
  getAnimation(code: string): AnimationJson | undefined
  transact<T>(summary: string, fn: () => T): T   // snapshot/rollback on throw; pushes undo entry
  undo(): string | null                          // returns undone summary
  redo(): string | null
  history(): { summary: string; at: number }[]   // at = monotonic sequence number, not wall-clock
}
```

Transactions snapshot via structural clone of `root`; v1 does not need copy-on-write.
Every mutating MCP tool wraps its work in exactly one `transact`.

## `vs/elements.ts` (geometry ops — all run inside a transaction, all cascade correctly)

```ts
addElement(doc, opts: { parent?: string; name: string; from: Vec3; to: Vec3;
  rotationOrigin?: Vec3; rotation?: Partial<Vec3Named>; faces?: 'auto-uv' | 'none' | FaceSpec })
editElement(doc, name, patch: { from?; to?; rotationOrigin?; rotationX?; rotationY?; rotationZ?; })  // patch semantics
renameElement(doc, oldName, newName)            // cascades into every keyframe of every animation
reparentElement(doc, name, newParent: string | null, opts?: { preserveWorld?: boolean })  // default true: recompute from/to/origin via fk matrices
mirrorElement(doc, name, axis: 'x' | 'z', opts?: { newName?: string })  // deep-copy subtree mirrored about model center plane; auto L/R name swap (heuristics: 'L '/'R ' prefix, 'left'/'right' substrings, '-l'/'-r' suffixes); returns name map
scaleElement(doc, name | null, factor: number | Vec3, anchor: Vec3)     // null = whole model; scales from/to/rotationOrigin recursively; keyframe offsets too
deleteElement(doc, name, opts?: { force?: boolean })  // refuses (throws with the referencing anim codes) if animations reference the subtree, unless force — then strips those keyframe entries and reports them
duplicateElement(doc, name, newName)            // deep copy subtree, unique-ified child names
importElement(doc, fromDoc, name, opts?: { parent?: string })  // kitbash: copy subtree from another doc, remap texture keys, unique-ify names
```

Mirroring and reparenting need world matrices — depend on `vs/fk.ts`.

## `vs/animation.ts`

```ts
createAnimation(doc, opts: { code: string; name?: string; quantityFrames: number;
  onAnimationEnd?: 'Repeat' | 'Hold' | 'Stop' | 'EaseOut'; onActivityStopped?: string })
deleteAnimation(doc, code)
editAnimationMeta(doc, code, patch)             // rename code, retime quantityFrames (with keyframe rescale opt), end-handling
setKeyframe(doc, code, frame: number, element: string, pose: {
  offset?: Vec3 | null; rotation?: Vec3 | null; stretch?: Vec3 | null })   // null clears that channel; absent leaves untouched; setting writes the FULL triple (GROUND-TRUTH §6)
deleteKeyframe(doc, code, frame, element?: string)   // whole frame or one element's entry
adjustChannel(doc, code, opts: { elements: string[] | '*'; channel: 'offset' | 'rotation' | 'stretch';
  op: 'scale' | 'add' | 'clamp'; value: number | Vec3; min?: Vec3; max?: Vec3 })
retimeAnimation(doc, code, newQuantityFrames: number)  // proportional keyframe re-placement, collision-safe rounding
mirrorPhase(doc, code, pairs: [string, string][])      // copy first half onto second half with element pairs swapped and X-rotation/offset sign conventions for gait cycles
```

## `vs/transform.ts` + `vs/fk.ts` (the engine port — fidelity-critical)

```ts
// transform.ts — column-major Float64Array(16), post-multiply semantics like Mat4f
mat4Identity(); mat4Mul(a, b); mat4Translate(m, x, y, z); mat4Scale(m, x, y, z);
mat4RotateByXYZ(m, radX, radY, radZ);            // exact port of Mat4f.RotateByXYZ
mat4TransformVec3(m, v): Vec3
localTransformMatrix(el: ElementPlain, animVersion: 0 | 1, pose?: PoseTf): Mat4  // exact port per GROUND-TRUTH §2

// fk.ts
interpolatePose(anim: AnimationPlain, frame: number): Map<elementName, PoseTf>  // exact port of GenerateFrameForElement incl. wraparound + channel independence (GROUND-TRUTH §6); frame may be fractional for filmstrips
elementMatrices(doc, opts?: { anim?: string; frame?: number }): Map<elementName, Mat4>  // world matrix per element
posedFaces(doc, opts?): RenderFace[]            // all visible faces, world-space quads + uv info (corner mapping per docs/ground-truth/tesselator.md)
modelBounds(doc, opts?): { min: Vec3; max: Vec3 }   // world AABB of posed geometry, in blocks
footContacts(doc, animCode, opts: { elements: string[] }): per-frame world bottom-center positions  // for the foot-slide validator

interface RenderFace {
  positions: [Vec3, Vec3, Vec3, Vec3];   // world-space quad, consistent winding (document which)
  uvRect: [number, number, number, number];
  uvRotation: 0 | 90 | 180 | 270;
  textureKey: string;                    // '#skin' → 'skin'
  facing: 'north'|'east'|'south'|'west'|'up'|'down';
  glow?: number;
}
```

## `vs/validate.ts`

```ts
validateDocument(doc, opts?: { level?: 'fast' | 'full' }): Finding[]
interface Finding { severity: 'error' | 'warn' | 'note'; code: string; message: string;
  element?: string; animation?: string; frame?: number; fix?: string }
```

Checks (each with a stable `code`):
- `from`/`to` ordering per axis (zero-thickness allowed → `note`).
- Unique element names (error — animations key on them).
- Face UV rects within the face's effective texture size (per-key `textureSizes` override
  else textureWidth/Height); inverted rects (`u1 > u2`) are a *note* — the engine samples
  them mirrored, a vanilla idiom.
- Every keyframe element name exists in the tree (error; this is the silent-rename failure).
- `quantityframes` > max keyframe frame (error, engine throws otherwise).
- Partial channel triples in keyframe elements (error, engine NPEs — GROUND-TRUTH §6).
- Animated joint count reaching 31 (warn; the engine throws at `count >= cap`, and an
  existing-but-unkeyed `head` costs one extra joint — GROUND-TRUTH §5).
- Duplicate animation codes (error).
- Cycle closure for EVERY `onAnimationEnd: Repeat` animation — including block machinery,
  and a missing `onAnimationEnd` means Repeat (the engine enum default) — (warn): pose at
  last interpolated frame vs frame 0 within tolerance, rotations compared modulo 360°
  (uses fk).
- Texture refs: face textures must start with `#` (error — the engine strips the first
  character unconditionally); a `#key` missing from the `textures` map is a warn (map
  non-empty) or note (map empty — the consuming block/item/entity type supplies textures;
  the engine never throws for a map miss).
- `full` adds foot-slide check when roles are passed (v1: only via explicit elements list).

`fast` runs after every transaction (automatic, included in every mutating tool's response).

## `render/*`

```ts
renderViews(doc, opts: {
  views?: ('n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'nw'|'top'|'bottom')[];  // compass side of the model the camera looks AT (north = −Z); default ['n','e','sw','top']
  anim?: string; frame?: number;
  size?: number;            // px per view tile, default 320
  overlayHitbox?: { x: number; y: number };  // wireframe box, blocks
  texturesRoot?: string;    // extra dir to resolve texture pngs (mod assets); game assets always fallback
}): Promise<Buffer>          // single composited PNG grid, labeled tiles, ground grid + N-axis marker + scale bar

renderFilmstrip(doc, opts: { anim: string; frames?: number /*default 8*/; view?: ViewName /*default 'e'*/;
  size?: number }): Promise<Buffer>   // one row, frame numbers burned in, ground line
```

**Two rasterization backends behind one contract** (`render/backend.ts`):

```ts
interface SceneJob {
  width: number; height: number; clear: [r, g, b, a];
  // geometry pre-transformed on CPU via camera.ts into screen space:
  // x,y px; z depth (smaller = nearer); identical input to both backends
  tris: { v: [ScreenVertex, ScreenVertex, ScreenVertex]; tex: TexRef; shade: number }[];
  lines: { a: ScreenVertex; b: ScreenVertex; rgba: RGBA; depthTest: boolean }[];
}
interface RenderBackend {
  renderScene(job: SceneJob): Promise<Uint8ClampedArray>;  // W*H*4 RGBA
  name: 'webgpu' | 'software';
  dispose(): void;
}
selectBackend(pref?: 'webgpu' | 'software' | 'auto'): Promise<RenderBackend>
// auto (default): try webgpu (Dawn `webgpu` npm pkg, lazy singleton device);
// on any init failure fall back to software with a one-line console.error note.
// Override via --renderer flag / VS_SHAPES_RENDERER env. Tests that assert golden
// bytes pin the software backend; GPU tests are structural + same-process determinism.
```

- WebGPU backend (`gpu.ts`): rgba8unorm target + depth32float, one draw per distinct
  texture (nearest sampler, alpha < 0.05 discard in WGSL — the engine's entity alphaTest), line-list pipeline for grid/
  wireframe, copyTextureToBuffer readback. `device.destroy()` in dispose (vitest must not
  hang). A working Dawn init/render/readback example for this exact package version is in
  scratch.spike-webgpu.mjs at the repo root.
- Software backend: thin adapter over `raster.ts`.
- Text labels/scale bar are always composited CPU-side onto the returned buffer (font.ts),
  after the backend pass.

- Orthographic projection. Camera fit: model AABB across ALL requested frames + 10% margin.
- Painter-correct via per-pixel z-buffer; quads split into 2 triangles; nearest-neighbor
  texture sampling; alpha < 0.05·255 ≈ 13 = cutout (the engine's entity alphaTest 0.05,
  tesselator.md §7); back faces NOT culled (vanilla has zero-thickness ears visible from
  both sides).
- Face shading: the engine's flat constants — north/south 0.6, east/west 0.75, up 1.0,
  down 0.45 (CubeMeshUtil.DefaultBlockSideShadings, tesselator.md §6b) — interpolated over
  each face's world-space normal GetFaceBrightness-style, so rotated/posed elements and
  `shade: false` (element-up normal) brighten like in-game.
- Texture resolution: shape texture value `entity/animal/...` →
  `<texturesRoot|game assets>/textures/<path>.png`; k = png_width / textureWidth; nearest
  sample at k-scale. Missing texture → deterministic flat color from hash(textureKey) +
  10% per-face shade variation, and the view grid prints a "missing texture" footnote.
- Labels via built-in 5×7 bitmap font (font.ts) — view name per tile, frame numbers on strips.

## `corpus/corpus.ts`

```ts
initCorpus(gamePath: string): Corpus           // lazy index; throws a clear error if path invalid
corpus.list(glob?: string): { path: string; domain: string }[]
corpus.search(query: string): ScoredHit[]      // substring/token match over path segments; no embeddings in v1
corpus.stats(path: string): { elements: number; depth: number; bounds; animations: { code; quantityFrames }[]; textureWidth; textureHeight; textures: Record<string,string> }
corpus.read(path: string): string              // raw text for ShapeDocument.parse
corpus.resolveTexturePng(texturePath: string): string | null   // absolute png path
```

## `server.ts` — MCP tools

Stateful session: `session.ts` keeps `Map<docId, ShapeDocument>`; `docId` is `d1`, `d2`, …
Every mutating tool returns `{ summary, validation: { errors, warnings } }` (notes omitted
unless asked) as JSON text content. Render tools return image content + a text caption.
Errors become `CallToolResult`s with `isError: true` carrying actionable messages naming
the entities involved (SPEC: errors are the product) — never protocol-level `McpError`s,
which the SDK would stringify into a misleading `MCP error -326xx:` prefix. Tool names and
grouping:

| Tool | Maps to |
|---|---|
| `shape_open` (path) / `shape_create` / `shape_save` (docId, path?) | document lifecycle; `shape_open` also accepts `corpus:` prefix paths |
| `shape_list_open` | session registry |
| `doc_undo` / `doc_redo` / `doc_history` | document |
| `shape_describe` (level: summary\|tree\|element) | query |
| `shape_measure` (elements?) | query: bounds in 1/16-block and blocks |
| `shape_find` (glob) | query |
| `element_add` / `element_edit` / `element_rename` / `element_reparent` / `element_mirror` / `element_scale` / `element_delete` / `element_duplicate` / `element_import` | elements.ts |
| `anim_list` / `anim_describe` | query |
| `anim_create` / `anim_delete` / `anim_edit_meta` / `anim_set_keyframe` / `anim_delete_keyframe` / `anim_adjust` / `anim_retime` / `anim_mirror_phase` | animation.ts |
| `uv_report` / `uv_set_face` / `uv_auto` | uv.ts |
| `render_views` / `render_filmstrip` | render |
| `validate_run` (level) | validate |
| `corpus_search` / `corpus_describe` / (open via `shape_open` `corpus:` path) | corpus |
| `doc_get_json` (jsonPointer?) / `doc_patch_json` (RFC-6902 patch) | escape hatch; patch runs in a transaction, full validation after |

zod schemas: every tool input fully described (`.describe()` on every field) — the schema IS
the agent-facing documentation. Vec3s as `[x, y, z]` number tuples.

## Testing

- Unit tests per module (vitest), colocated under `tests/`.
- `tests/acceptance/roundtrip.test.ts` — corpus byte-stability (gate: ≥99% all shapes,
  100% `shapes/entity/**`). Skips cleanly (with a console note) if the game install is absent.
- `tests/acceptance/fk.test.ts` — fox walk pose: interpolate a mid-cycle frame, assert leg
  rotations move and bounds stay sane; static fox bounds match `from`/`to` extremes.
- `tests/acceptance/render.test.ts` — render fox views + filmstrip: PNG decodes, expected
  dimensions, >5% non-background pixels, deterministic across two runs.
- `tests/acceptance/mcp.test.ts` — end-to-end through `InMemoryTransport` + SDK Client:
  open fox from corpus → describe → rename element (verify keyframe cascade) → set keyframe →
  render → undo → save to temp dir → re-parse equals.

Scripts: `npm run build` (tsc), `npm test` (vitest run), `npm run dev` (tsx src/index.ts),
`npm run typecheck` (tsc --noEmit).
