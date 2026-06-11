# Shape JSON format empirics (vanilla 1.22 corpus survey)

Measured over all 6,115 `*.json` files under `assets/survival/shapes/**` (block: ~3.5k,
entity + item the rest). These numbers drive `src/vs/json.ts`: the hybrid serializer
preserves parsed layout byte-for-byte and uses the *canonical* conventions below only for
fresh nodes created by editing tools.

## Whole-file conventions

| Property | Count | Notes |
|---|---|---|
| CRLF line endings | 4,455 | the model-creator default |
| LF line endings | 1,660 | git-normalized / hand-edited files; **no mixed-EOL files** |
| UTF-8 BOM | 0 | |
| Trailing newline at EOF | 130 | the other 5,985 end right after the final `}` |
| Tab indentation | 6,025 | canonical |
| Space indentation | 82 | 4-space, older MrCrayfish-model-creator exports |
| Mixed tab/space | 8 | |
| Lines with trailing whitespace | 2,096 files contain at least one | e.g. `"from": [ ... ], ` — space *after* the comma before EOL |

Canonical fresh style therefore: **CRLF + tabs**, no trailing newline. `serializeVsJson`
sniffs the parsed file's newline style for fresh nodes inserted into an existing tree and
accepts a `newline` override option.

## Deviant file classes (strict `JSON.parse` fails on 72 files)

1. **`//` comments** — 18 files, all `block/metal/furnacesection/*` ("Model generated using
   MrCrayfish's Model Creator" header). Per ARCHITECTURE these are **rejected** with a
   position-bearing error; they are the only expected round-trip failures (18/6115 = 0.29%).
2. **Unquoted property names** — ~17 files, all under `block/` (e.g.
   `block/wood/log/section-ne.json` `textures: {`, `block/stone/stove-lit.json` `glow: 128`,
   `block/plant/leaves/branchy*.json` `seasonColorMap: "..."`). Newtonsoft parses these in
   lenient mode, so the engine loads them. The parser accepts them and preserves the
   unquoted key token verbatim.
3. **Trailing commas** — 37 files, **including 21 under `entity/`** (seraph clothing,
   tobias, villageraccessories, goat/sheep variants) and 7 under `item/wearable/`.
   Accepted and preserved (gap before the comma + the comma itself are part of layout).

Additionally (valid JSON but lossy for naive parsers):

4. **Duplicate object keys** — 10 files, 7 under `entity/` (alewife/chub/salmon fish,
   bighorn baby, glovesflap). Newtonsoft semantics: **last occurrence wins**. The parser
   keeps the last value live in the JS object and stores earlier occurrences as raw text
   "shadow entries" in layout metadata so serialization reproduces every occurrence
   byte-for-byte. Shadow entries are dropped if the (live) key is deleted from the object.

## Number formatting per field (token style counts)

`int` = no decimal point, `dot` = has `.`, `exp` = scientific notation (`5.008955855952477E-6`,
`-7.0E-4` — capital `E`, produced by C# `double.ToString`; ~400 occurrences total).

| Field | int | dot | exp | Canonical style |
|---|---|---|---|---|
| `uv` (face + element hint) | 1 | 2,943,165 | 0 | double (`4.0`) |
| `from` / `to` | 0 | 855,984 | 24 | double |
| `rotationOrigin` | 0 | 409,641 | 24 | double |
| `rotationX/Y/Z` (element + keyframe) | 1 | 1,227,598 | 321 | double |
| `offsetX/Y/Z` (keyframes) | 0 | 427,423 | 23 | double |
| `windMode` / `windData` | 267,470 | 0 | 0 | int |
| face `rotation` | 81,825 | 6 | 0 | int |
| `frame` | 49,545 | 0 | 0 | int |
| `unwrapMode` / `unwrapRotation` | 13,020 | 0 | 0 | int |
| `renderPass` | 7,321 | 0 | 0 | int |
| `quantityframes` | 6,096 | 0 | 0 | int |
| `textureWidth` / `textureHeight` | 12,040 | 0 | 0 | int |
| `glow` | 3,748 | 0 | 0 | int |
| `reflectiveMode` | 1,485 | 0 | 0 | int |
| `zOffset` | 154 | 0 | 0 | int |
| `textureSizes` entries (keyed by texture name) | all int | 0 | 0 | auto (integers stay ints) |
| `stretchX/Y/Z`, `originX/Y/Z`, `scaleX/Y/Z`, `version` | **0 occurrences in the corpus** | | | double for stretch/origin/scale (analogous to offsets/rotations — UNVERIFIED against model-creator output), int for `version` |

Negative zero appears as a real literal: `offsetY: -0.0` ×283, `offsetX` ×124, `offsetZ` ×14
(C# formatting of tiny negative doubles). Preserved via `VsNum.raw`.

## quantityframes casing

Only one variant in the entire corpus: `quantityframes` (all-lowercase), 6,096 occurrences.
No `quantityFrames` (the C# property casing) was found in any vanilla file.

## Layout conventions per node type

- **Number arrays** (`from`/`to`/`uv`/`rotationOrigin`): always inline, always
  `[ N, N, N ]` spacing (single space after `[`, before `]`, `, ` separators) —
  1,031,942/1,031,942 sampled arrays. ~750 empty arrays exist elsewhere.
- **Face objects**: inline on one line 724,785× vs expanded 237× →
  canonical inline: `{ "texture": "#skin", "uv": [ 0.0, 4.0, 4.0, 8.0 ], "rotation": 270 }`.
- **Keyframe element objects**: inline 390,351×, expanded 0× → canonical inline.
- **`attachmentpoints` objects**: expanded 393×, inline 0× → canonical expanded.
- **Empty objects**: standalone-value empties split across two lines, closing brace at the
  *property's* indent level (`"textureSizes": {` CRLF `\t}`): gap styles `\r\n\t` ×2,953,
  `\r\n\t\t\t` ×2,040, LF variants ×1,917+. An inline empty style `{  }` (two spaces)
  appears 1,745× inside inline face/keyframe contexts.
- **Top-level key order** (model-creator): `editor`, `textureWidth`, `textureHeight`,
  `textureSizes`, `textures`, `elements`, `animations`.
- **Element key order**: `name`, `from`, `to`, (`unwrapMode`, `unwrapRotation`, `uv`,)
  `rotationOrigin`, `rotationX/Y/Z`, `faces`, `children`.

## String literals

Zero escape sequences (`\uXXXX`, `\n`, `\"`, …) in any string literal across the whole
corpus, and zero single-quoted strings. Raw string tokens are still preserved by the parser
when they differ from canonical `JSON.stringify` output, as cheap insurance.

## Integer-like object keys

Texture maps reference keys like `"#2"` / `"#-1"` (`block/stone/stove-lit.json`), so texture
objects can have keys such as `"2"`. JS objects reorder integer-like keys ahead of string
keys, so the serializer emits entries in *layout (source) order*, never `Object.keys` order,
for parsed objects.
