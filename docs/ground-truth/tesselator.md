# Tesselator / rendering ground truth

Extracted from the decompiled Vintage Story 1.22 client. Normative for `vs/fk.ts` and
`render/*` (same contract as docs/GROUND-TRUTH.md: when code disagrees with this doc, the
code is wrong; when this doc disagrees with the decompiled source, fix the doc).

Sources (read-only), cited below as `Lib:`, `API:`, `Ess:` plus shader asset paths:

- `Lib` = `%APPDATA%/Vintagestory/temp_decomp_lib/VintagestoryLib.decompiled.cs`
- `API` = `%APPDATA%/Vintagestory/temp_decomp_api/VintagestoryAPI.decompiled.cs`
- `Ess` = `%APPDATA%/Vintagestory/temp_decomp_essentials/VSEssentials.decompiled.cs`
- shaders: `%APPDATA%/Vintagestory/assets/game/shaders/**`, `assets/game/shaderincludes/**`

## 1. Pipeline overview

Entity shapes are meshed by the same `ShapeTesselator` (`Lib:154601`) as blocks/items.
`EntityShapeRenderer.TesselateShape` (`Ess:32039-32051`) builds a `TesselationMetaData`
(`WithJointIds = true`, `TypeForLogging = "entity"`) and calls
`capi.Tesselator.TesselateShape(meta, entityShape, ref meshdata)` →
`ShapeTesselator.TesselateShape(Shape, …)` (`Lib:154827`) →
`TesselateShapeElements` (`Lib:154874`, recursive over the element tree, matrix stack) →
`TesselateShapeElement` (`Lib:154955`, emits up to 6 quads per element).

Faces are resolved at shape load by `ShapeElement.TrimTextureNamesAndResolveFaces`
(`API:148698`): faces with `enabled: false` are dropped entirely (`API:148705`), the face
dictionary key is matched by its **first letter**, case-insensitively (`n/e/s/w/u/d`,
`API:148707`, `API:9084-9100` — `'n'`, `'North'` and `'north'` all resolve to NORTH; fk
reads only canonical full names, so the validator errors on non-canonical keys), and the
**first character** of `texture` is stripped **unconditionally**
(`value.Texture.Substring(1)`, `API:148715` — a texture written without `#`, e.g. `"skin"`,
is mangled to the dangling key `"kin"` in-game; the validator errors on missing `#`). The
result is stored in `FacesResolved` indexed by `BlockFacing` index. Face index order is
**N=0, E=1, S=2, W=3, UP=4, DOWN=5** (`API:8630`, facings defined `API:8600-8625`; north has
normal `(0,0,-1)`, i.e. north = −Z, east = +X, up = +Y).

## 2. Element local matrix (client tesselator)

`TesselateShapeElements` composes the per-element matrix on a double-precision stack
(`StackMatrix4`, post-multiplying glMatrix ops, `API:38554-38639`), with
`origin = rotationOrigin/16` (0 if absent):

```
push parent matrix                       (Lib:154898)
T(origin)            only if rotationOrigin present   (Lib:154902-154914)
Rx(RotationX°) · Ry(RotationY°) · Rz(RotationZ°)      (Lib:154915-154926, each skipped when 0)
S(ScaleX, ScaleY, ScaleZ)               only if ≠1    (Lib:154927-154930)
T(from/16 − origin)                      (Lib:154931; origin treated as 0 when absent)
```

The final translate always subtracts the origin components (zero when `rotationOrigin` is
absent), so the net composition is exactly
`M = T(origin) · Rx·Ry·Rz · S · T(from/16 − origin)` — identical to the static collapse of
`ShapeElement.GetLocalTransformMatrix` (`API:148741`, GROUND-TRUTH §2; `Mat4f.RotateByXYZ`
builds `Rx·Ry·Rz` as one matrix, same result). The element's quad vertices are generated in
**element-local box space `[0, (to−from)/16]` per axis** and then transformed by the stack
matrix (`elementMeshData.MatrixTransform(stackMatrix.Top)`, `Lib:154936`); children push on
top of the parent matrix (`Lib:154940-154950`), i.e. child `from`/`to` are relative to the
parent's `from` corner, rotated/scaled by the parent.

`meta.drawnHeight` (`API:48212`) is 1 except for partially-drawn *blocks* (liquid
containers, `Lib:155141`); for entities it is always 1 — ignore it.

An element whose size is zero on **all three** axes emits no faces (`Lib:154957-154962`);
zero thickness on one axis (ears, fins) still emits all six faces. Elements with no faces
still push their matrix and recurse into children (`Lib:154932`, `Lib:154940`).

## 3. Face vertex emission — `ModelCubeUtilExt.AddFace`

`TesselateShapeElement` computes `size = (to−from)/16` and `center = size/2`
(`Lib:154957`, `Lib:154963`) and calls
`ModelCubeUtilExt.AddFace(mesh, facing, center, size, originUv, sizeUv, …, uvRotation, …)`
(`Lib:155113`). `AddFace` (`API:57008-57069`) emits 4 vertices:
`pos[i] = center + size · CubeMeshUtil.CubeVertices[face·12 + i·3 ..+2] / 2`
(`API:57032`), where `CubeVertices` (`API:52335-52345`) holds ±1 corner factors. −1 maps to
local 0 and +1 maps to local `size`, so the box spans `[0, (to−from)/16]` (confirmed).

Per-face vertex order in element-local box coordinates (`sx,sy,sz` = size components),
with the UV-corner cycle index each vertex receives at `rotation: 0` (cycle defined in §4):

| face | v0 | v1 | v2 | v3 |
|---|---|---|---|---|
| north (z=0) | (0,0,0) | (0,sy,0) | (sx,sy,0) | (sx,0,0) |
| east (x=sx) | (sx,0,0) | (sx,sy,0) | (sx,sy,sz) | (sx,0,sz) |
| south (z=sz) | (sx,0,sz) | (sx,sy,sz) | (0,sy,sz) | (0,0,sz) |
| west (x=0) | (0,0,sz) | (0,sy,sz) | (0,sy,0) | (0,0,0) |
| up (y=sy) | (sx,sy,sz) | (sx,sy,0) | (0,sy,0) | (0,sy,sz) |
| down (y=0) | (0,0,sz) | (0,0,0) | (sx,0,0) | (sx,0,sz) |

(parsed from `CubeVertices`, `API:52335`; vj receives UV cycle index j — see §4.)

Triangles are `(v0,v1,v2)` and `(v0,v2,v3)` (`API:57035-57040`). **Winding is
counter-clockwise when the face is viewed from outside the box** (verified by cross
products: e.g. north `(v1−v0)×(v2−v1) = (0,0,−sx·sy)` = outward −Z). This matches the
`RenderFace.positions` contract in `src/vs/types.ts`.

## 4. UVs

`uv: [u1, v1, u2, v2]` in shape-UV units. `(u1,v1)` is the **top-left**, `(u2,v2)` the
**bottom-right** of the rectangle on the texture; **v grows downward on the PNG** (see §5
for the evidence chain). Unpacking in `TesselateShapeElement` (`Lib:155021-155024`):
`u1 = Uv[0]`, `v1 = Uv[3] + (Uv[1]−Uv[3])·drawnHeight = Uv[1]`, `u2 = Uv[2]`, `v2 = Uv[3]`.
Then `originUv = (u1, v2)` and `sizeUv = (u2−u1, v1−v2)` (note **negative** v-span;
`Lib:155052-155053`, atlas terms stripped).

Every face uses the same UV-coord pattern `CubeUvCoords` = `(1,0),(1,1),(0,1),(0,0)`
repeated 6× (`API:52363-52370`). With `uvAt(cu,cv) = originUv + sizeUv·(cu,cv)` that yields
the **UV corner cycle**:

```
C0 = (u2, v2)   bottom-right     C1 = (u2, v1)   top-right
C2 = (u1, v1)   top-left         C3 = (u1, v2)   bottom-left
```

Vertex `j` receives corner `C[(r + j) mod 4]` where `r = floor(rotation / 90) mod 4`
(`Lib:155051` `(int)(Rotation/90f)`, `Lib:155113` `% 4`, `API:57031`).

- At `rotation: 0` the texture is applied **unmirrored as seen from outside the face**, PNG
  top row (`v1`) along the face's "natural top". Per-face UV axes in element-local space
  (direction in which u resp. v grow):

  | face | u grows along | v grows along |
  |---|---|---|
  | north | −X | −Y |
  | east | −Z | −Y |
  | south | +X | −Y |
  | west | +Z | −Y |
  | up | +X | +Z |
  | down | −X | +Z |

  (Derived from the tables in §3; side faces: PNG top = face top. Up face: PNG top = north
  edge, PNG right = east edge. Down face: PNG top = north edge, PNG right = **west** edge —
  unmirrored when viewed from below.)
- **`rotation: 90` turns the texture 90° clockwise as seen from outside the face**
  (content at the PNG rect's top-left moves to the face's top-right); 180/270 likewise.
  Rotation values other than multiples of 90 truncate (`(int)` cast); negative values
  underflow the engine's UV table (crash on the north face, wrong pattern elsewhere) —
  treat as invalid.
- A face with **no `uv`** gets auto-UV `[0, 0, w, h]` where `(w,h)` is the element's size
  ×16 projected on the face axis: Y-axis faces (up/down) → `(sizeX, sizeZ)·16`, X-axis
  (east/west) → `(sizeZ, sizeY)·16`, Z-axis (north/south) → `(sizeX, sizeY)·16`
  (`Lib:154992-155012`).
- A `uv` array whose length ≠ 4 logs a warning and the face is skipped (`Lib:155016-155019`).
- Degenerate-rect guard: after scaling to atlas pixels, if `v1·k == v2·k` then the v2 side
  is nudged by `+1/32` atlas px; same for u (`Lib:155043-155050`). Cosmetic; a renderer may
  ignore it.
- The UV span is clamped so it cannot exceed the texture's atlas slot
  (`Lib:155054-155055`) — not applicable when sampling standalone PNGs.
- A face referencing a texture code missing from the texture source throws
  `ArgumentNullException` (`Lib:155029-155032`).

## 5. textureWidth / textureHeight / textureSizes → PNG scaling

Shape defaults: `TextureWidth = 16`, `TextureHeight = 16` (`API:147714`, `API:147720`);
`TextureSizes` is a per-texture-key override map `key → [w, h]` (`API:147723`). The
tesselator picks the size per face texture key: `meta.TexturesSizes.TryGetValue(key)` else
`[shape.TextureWidth, shape.TextureHeight]` (`Lib:155033-155036`, populated
`Lib:154856-154858`).

Scale factor (`Lib:155037-155042`):
`kx = (tap.x2−tap.x1)·atlasWidth / textureSizeW`, and since
`(tap.x2−tap.x1)·atlasWidth` = source PNG width in pixels (atlas insertion is 1:1,
`Lib:136265-136303`, `Lib:136335-136348`), this is exactly

```
kx = pngWidth / textureWidth        ky = pngHeight / textureHeight
pngPixelU = shapeU · kx             pngPixelV = shapeV · ky
```

So a 64×64 PNG under `textureWidth/Height: 32` has `k = 2`: shape-UV `(4, 8)` = PNG pixel
`(8, 16)`. UV-rect bounds in shape units are `textureWidth`/`textureHeight`, regardless of
PNG resolution.

**V direction evidence:** atlas insertion copies bitmap row `j` to atlas row `y1 + j`
(`Lib:136295-136302`); the atlas pixel buffer is uploaded row 0 first, so GL texture v
increases with bitmap row index; shape v maps linearly onto `[y1, y2]`
(`Lib:155052-155053`). Bitmap row 0 = PNG top row (standard decode order —
UNVERIFIED at the decode call site, but this is the universal VS model-creator convention:
uv origin is the PNG's top-left). Empirical test: render the fox shape and compare eye/ear
patch placement against an in-game screenshot or the model creator.

## 6. Face brightness / shading

### 6a. What the game actually does for entities (exact)

Entity meshes carry a **packed normal per vertex** in the flags int (bits 13–24,
`vertexflagbits.ash`, `API:123937-123943`):

- `shade: true` (default, `API:148492`): the face's own facing normal
  (`Lib:155064-155066`).
- `shade: false`: shade mode Off; the **UP** normal is packed instead
  (`Lib:155072-155076`), and the mesh's `XyzFaces` entry is 0 (`API:57050`).
- `gradientShade: true`: per-vertex mix — vertices in the upper half of the (pre-transform)
  element get the UP normal, lower-half vertices get `normalize(0.5·up + faceNormal)`
  (`Lib:155068-155070`, `API:57014-57026`, `API:56997-57006`).

The static element rotation rotates these packed normals when the stack matrix is applied
(`MeshData.MatrixTransform(double[])` re-packs rotated flag normals, `API:53827-53839`),
and the animation joint matrix rotates them again in the vertex shader
(`entityanimated.vsh`: `normal = (animModelMat * vec4(unpackNormal(renderFlags),0)).xyz`).
So the lighting normal is the **world-space face normal** (or world-space "up of the
element" when `shade: false`).

Brightness is computed **in the fragment shader** (`entityanimated.fsh` →
`applyFogAndShadowWithNormal(texColor, fogAmount, normal, 1.0, intensity, …)` in
`shaderincludes/fogandlight.fsh`):

```
nb = max( minNormalShade,
          0.5 + 0.5 · dot(N, L),     // L = lightPosition uniform
          N.y · 0.95 )
rgb *= min(shadowMapBrightness, nb)
```

with `normalShadeIntensity = 1` and `minNormalShade = intensity` = **0.45** without shadow
maps, `0.34 + (1 − shadowIntensity)/8` with (`entityanimated.fsh`, the
`#if SHADOWQUALITY` block). `L` = `LightPosition3D` = the **normalized sun (or moon)
direction**, time-of-day dependent (`Lib:175938-175941`, bound at `Lib:174632`). The
`getBrightnessFromNormal` variant in `shaderincludes/normalshading.fsh` (chunk shaders) adds
a `+0.2·northness` bonus; the entity path does **not**.

The vertex color (`applyLight`, `fogandlight.vsh`) carries day/block light only — it is
independent of the normal and uniform across the entity; a neutral renderer treats it as
white.

### 6b. The game's flat per-face constants (for static renders)

Where the engine needs fixed per-face shading without a shader (voxelized item meshes
`Lib:155228-155232`, particle/microblock cubes `Lib:172626`), it uses
`CubeMeshUtil.DefaultBlockSideShadings = [1, 0.75, 0.6, 0.45]` (Top, Front/Left,
Back/Right, Bottom; `API:52317`) mapped per facing (`API:52322-52330`):

| facing | north | east | south | west | up | down |
|---|---|---|---|---|---|---|
| brightness | 0.6 | 0.75 | 0.6 | 0.75 | **1.0** | 0.45 |

(`BlockFacing.GetFaceBrightness` interpolates this table for rotated faces by angular
proximity of the rotated normal to each axis facing, `API:8920-8938`.)

**Renderer guidance:** use the table above (rotating faces re-derive brightness from the
world normal via the §6a formula or `GetFaceBrightness`-style interpolation). The §6a
formula with a fixed `L` (e.g. noon `L=(0,1,0)` → up 1.0, all sides 0.5, down 0.45) is the
higher-fidelity option. The ARCHITECTURE.md fallback guess (N/S 0.8, E/W 0.6) does NOT
match the engine constants — N/S 0.6, E/W 0.75 are the real values.

### 6c. Glow

Face `glow` (0–255, `API:148929`) plus the general glow level is packed into flags bits
0–7 (`Lib:155057`). Shader: `glowLevel = (flags & 0xFF) / 256` becomes (a) a floor on the
vertex-light brightness (`applyLight`: final brightness ≥ `bGlow`) and (b) the bloom output
(`entityanimated.fsh`: `outGlow.r = glowLevel + …`). Renderer approximation: clamp the face
brightness to at least `glow/256` and skip directional shading when glow ≈ 255.

## 7. Entity render state (what a faithful renderer must mirror)

From the entity opaque pass `OnRenderOpaque3D` (`Lib:174607-174649`):

- **Backface culling OFF** (`GlDisableCullFace`, `Lib:174611`, `Lib:174633`) — required:
  vanilla zero-thickness parts (ears) are visible from both sides.
- Blending ON (`Lib:174612`, `Lib:174637`), depth test ON (`Lib:174613`).
- **Alpha cutout: `alphaTest = 0.05`** (`Lib:174631`; fragment discard when
  `outColor.a < alphaTest`, `entityanimated.fsh`). I.e. texel alpha < ~13/255 → discard.
  (The renderer matches this exactly: software `alpha < 13`, WGSL `a < 0.05` — both
  discard the same texel set, 12/255 ≈ 0.047 < 0.05 < 13/255 ≈ 0.051.)
- Single pass: all entity faces render in one opaque (alpha-tested, blended) pass.
  `element.renderPass` (default −1, `API:148559`) is stored per face in the mesh
  (`API:57061-57068`) but the entity draw path never branches on it — it only selects chunk
  render passes for **blocks**. Ignore for entities.
- `element.zOffset` (`API:148562`) is packed into flags bits 8–10 (`Lib:155057`) and only
  consumed by the chunk/decal vertex shaders as a tiny anti-z-fighting bias toward the
  camera (`chunkopaque.vsh:107-110`: `gl_Position.w += zOffset · 0.00025 / ((z+3)·0.05)`);
  `entityanimated.vsh` ignores it → **no-op for entities**. A renderer may implement it as
  a small depth bias (a few 1e-4 of clip w per step) or ignore it.
- `disableRandomDrawOffset` adds 1024 to the stored render pass (`Lib:154967-154971`) —
  block-only concern, ignore.
- Face `windMode`/`windData`/`reflectiveMode` write flag bits 25–31 / 11
  (`Lib:155058-155112`) driving vertex warp and specular noise — irrelevant to a static
  renderer.

Whole-mesh modifiers from the entity's `client.shape` composite (baked at tesselation,
`Lib:154860-154871`): `Scale` scales about `(0.5, 0, 0.5)`; `rotateX/Y/Z` rotate about the
block center `(0.5, 0.5, 0.5)`; `offsetX/Y/Z` translate. (Quirk: `loadModelMatrix` adds
`rotateX/Y/Z` *again* at render time, `Ess:32603-32636` — apparent double application,
UNVERIFIED whether intended; vanilla creatures don't set these, so ignore for v1.)

## 8. Model facing convention

VS yaw: AI seek sets `desiredYaw = atan2(dx, dz)` (`Ess:2690`) and forward motion is
`(sin yaw, 0, cos yaw)` (`EntityControls.CalcMovementVectors`, `API:135509-135518`) — yaw 0
walks **south (+Z)**, yaw +90° east… counter-clockwise seen from above.

The entity model matrix applies `RotateY(yaw + (rotateY + 90°))` (`Ess:32620`,
`Ess:32634-32635`; player variant `Ess:31595`) and finally `Translate(−0.5, 0, −0.5)`
(`Ess:32648`, `Ess:31645`). `Mat4f.RotateY(θ)` maps `+X → (cosθ, 0, −sinθ)`
(`API:20147-20179`), so with θ = yaw+90°: **model −X → (sin yaw, 0, cos yaw) = the travel
direction**. Therefore:

- **A creature conventionally faces −X (west) in shape/model space.** Verified on vanilla
  shapes: fox-male head occupies model-x ≈ 1.0–3.5 vs tail ≈ 11.6+; wolf eurasian-adult
  snout at model-x ≈ −10, tail tip ≈ +30.
- Creature's **left side = +Z** (model space): fox/wolf "L …" elements sit at z > 8.
- The ground anchor (the entity's position, feet level) is model point
  `(0.5, 0, 0.5)` in blocks = shape coords `(8, 0, 8)` in 1/16 units (the final
  `Translate(−0.5, 0, −0.5)`).
- `entity.Properties.Client.Size` scales the model about that anchor (`Ess:32645-32648`).

For the render module's compass views (camera looks AT the named side, north = −Z): the
**'w' view shows a creature's face head-on**; 'n' shows its right flank.

## 9. Worked example — fox-male.json `body`, north face

`assets/survival/shapes/entity/animal/mammal/fox/fox-male.json`: `textureWidth/Height` 32,
texture `skin → entity/animal/mammal/fox/red-male` (PNG is 64×64 → k = 2). Root element
`body`: `from [4,4,6]`, `to [8,8,10]`, `rotationOrigin [6,6,8]`, `rotationZ 1`; north face
`uv [0.0, 4.0, 4.0, 8.0]`, `rotation 270`.

Identity pose (no animation; the static `rotationZ: 1°` applies). Local matrix:
`M = T(0.375, 0.375, 0.5) · Rz(1°) · T(−0.125, −0.125, −0.125)`; box size
`(0.25, 0.25, 0.25)`. North-face emission order (§3) and world-space corners in blocks
(cos 1° = 0.9998476952, sin 1° = 0.0174524064):

| vtx | local box | world (blocks) | UV corner (32-unit space) | PNG px (k=2) |
|---|---|---|---|---|
| v0 | (0, 0, 0) | (0.2522005889, 0.2478374873, 0.375) | (0, 8) | (0, 16) |
| v1 | (0, 0.25, 0) | (0.2478374873, 0.4977994111, 0.375) | (4, 8) | (8, 16) |
| v2 | (0.25, 0.25, 0) | (0.4977994111, 0.5021625127, 0.375) | (4, 4) | (8, 8) |
| v3 | (0.25, 0, 0) | (0.5021625127, 0.2522005889, 0.375) | (0, 4) | (0, 8) |

UV assignment: `r = 270/90 = 3`, vertex j gets cycle `C[(3+j) mod 4]` with
`C = [(4,8), (4,4), (0,4), (0,8)]` (= `[(u2,v2),(u2,v1),(u1,v1),(u1,v2)]`), so
v0→C3=(0,8), v1→C0=(4,8), v2→C1=(4,4), v3→C2=(0,4): the PNG rect's top edge (v=4) lies
along the +X edge of the face — the texture is turned 270° clockwise as seen from north
(−Z) looking at the face. Winding v0→v1→v2 is CCW from outside (normal −Z). Shading normal
at identity: `Rz(1°)·(0,0,−1) = (0,0,−1)`.

(Without the 1° roll the corners would be the axis-aligned
`(0.25|0.5, 0.25|0.5, 0.375)`; the table above is the exact engine result.)

## 10. Checklist for `fk.posedFaces` / `render`

1. World matrix per element: GROUND-TRUTH §2 (animation) ≡ §2 here (static); identical.
2. For each enabled face (absent and `enabled:false` faces are skipped at load): emit the
   4 local corners from the §3 table, transform by the element world matrix → CCW-from-
   outside quad; triangles (0,1,2)+(0,2,3).
3. UV per vertex: cycle `[(u2,v2),(u2,v1),(u1,v1),(u1,v2)]`, index `(rotation/90 + j) % 4`.
4. Sample PNG at `(u·kx, v·ky)`, k = pngSize/textureSize (per-key `textureSizes` override),
   v downward; nearest-neighbor; alpha < 0.05·255 ≈ 13 → discard; no backface culling.
5. Brightness: flat table N/S 0.6, E/W 0.75, U 1.0, D 0.45 on the world-space normal
   (or §6a formula); `shade:false` → treat normal as world-space element-up (≈ 0.95–1.0);
   `glow` → brightness floor `glow/255`.
6. Creature faces model −X; entity anchor at model `(0.5, 0, 0.5)`.
