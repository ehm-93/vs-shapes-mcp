/**
 * McpServer wiring: every tool registration (ARCHITECTURE.md §server.ts).
 *
 * Conventions surfaced to the agent through the zod `.describe()` docs (the schema IS the
 * documentation): geometry units are 1/16 of a block, Y is up, north = −Z; render view
 * names are the compass side of the model the camera looks AT. Vec3 params are
 * [x, y, z] number tuples.
 *
 * - Every mutating tool runs exactly one doc.transact(summary, …) and replies with pretty
 *   JSON `{ summary, validation: { errors, warnings }, ...opData }` (fast validation;
 *   doc_patch_json runs the full suite). Tool errors become CallToolResults with
 *   isError: true carrying the underlying actionable message — never protocol-level
 *   McpErrors (tool execution failures belong in the result per the MCP spec; the SDK
 *   would stringify a thrown McpError into a misleading 'MCP error -326xx:' prefix).
 * - Render tools reply with an image content item (base64 PNG) plus a text caption that
 *   carries the missing-texture footnote.
 * - The corpus (game install) is initialized lazily: the server runs fine for pure
 *   editing with no install; corpus-dependent tools fail with an error that names
 *   --game-path, and render falls back to flat colors with a footnote.
 *
 * NO stdout writes anywhere in here (MCP speaks JSON-RPC on stdout); console.error only.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { initCorpus, type Corpus } from './corpus/corpus.js';
import type { BackendPreference } from './render/backend.js';
import { extractPalette } from './render/palette.js';
import { renderFilmstrip, renderGif, renderViews, type ViewName } from './render/views.js';
import { runDocScript } from './script/api.js';
import { Session, type ManagedDoc } from './session.js';
import {
  adjustChannel,
  animCodeOf,
  createAnimation,
  deleteAnimation,
  deleteKeyframe,
  editAnimationMeta,
  mirrorPhase,
  retimeAnimation,
  setKeyframe,
} from './vs/animation.js';
import { ShapeDocument } from './vs/document.js';
import {
  addElement,
  deleteElement,
  describeUnknown,
  duplicateElement,
  editElement,
  importElement,
  mirrorElement,
  renameElement,
  reparentElement,
  scaleElement,
} from './vs/elements.js';
import { elementMatrices, modelBounds } from './vs/fk.js';
import { applyPatch, getAt, toPlain, type PatchOpInput } from './vs/jsonpatch.js';
import { mat4TransformVec3 } from './vs/transform.js';
import {
  vec3 as vec3Of,
  type AnimationJson,
  type ElementJson,
  type FaceName,
  type Finding,
  type JsonValue,
  type Vec3,
} from './vs/types.js';
import { autoUv, planAutoUvFit, setFaceProps, setFaceUv, uvReport } from './vs/uv.js';
import { validateDocument } from './vs/validate.js';

export interface BuildServerOpts {
  /** Vintage Story install dir; when omitted, VINTAGE_STORY env then %APPDATA%/Vintagestory. */
  gamePath?: string;
  /** Renderer preference threaded into every render tool call (default 'auto'). */
  renderer?: BackendPreference;
}

// ---------------------------------------------------------------------------
// Small generic helpers
// ---------------------------------------------------------------------------

/**
 * doc_get_json response cap, in characters of pretty-printed JSON. The whole document of
 * a heavily animated shape (vanilla seraph: 1.35 MB ≈ 340K tokens) would destroy any
 * agent context in one call; oversized requests get an actionable error naming the
 * subtree sizes instead.
 */
const DOC_GET_JSON_CHAR_CAP = 100_000;

/** RFC-6901 token escaping for pointers built in error messages. */
const escapePointerToken = (token: string): string =>
  token.replaceAll('~', '~0').replaceAll('/', '~1');

/** Actionable over-cap error: names the node's children with their serialized sizes. */
function describeOversizedJson(ptr: string, plain: unknown, totalChars: number): string {
  const at = ptr === '' ? "'' (the whole document)" : `'${ptr}'`;
  let detail: string;
  if (Array.isArray(plain)) {
    detail =
      `an array of ${plain.length} item${plain.length === 1 ? '' : 's'}; ` +
      `read narrower slices like '${ptr}/0'`;
  } else if (plain !== null && typeof plain === 'object') {
    const parts = Object.entries(plain as Record<string, unknown>).map(([k, v]) => {
      const size = JSON.stringify(v)?.length ?? 4;
      return `'${ptr}/${escapePointerToken(k)}' (${size.toLocaleString('en-US')} chars)`;
    });
    detail = `an object; child sizes: ${parts.join(', ')}`;
  } else {
    detail = 'a very large scalar';
  }
  return (
    `doc_get_json: the JSON at ${at} serializes to ${totalChars.toLocaleString('en-US')} ` +
    `characters, beyond the ${DOC_GET_JSON_CHAR_CAP.toLocaleString('en-US')}-character ` +
    `response cap. It is ${detail}. Pass a narrower jsonPointer.`
  );
}

// ---------------------------------------------------------------------------
// zod building blocks (every field described — the schema is the agent docs)
// ---------------------------------------------------------------------------

const docIdParam = z
  .string()
  .describe("Open-document id from shape_open/shape_create, e.g. 'd1' (shape_list_open lists them).");

const vec3Param = (desc: string) => z.tuple([z.number(), z.number(), z.number()]).describe(desc);

const VIEW_VALUES = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw', 'top', 'bottom'] as const;
const FACE_VALUES = ['north', 'east', 'south', 'west', 'up', 'down'] as const;

const faceSpecSchema = z.object({
  texture: z
    .string()
    .optional()
    .describe("Texture key ('skin' or '#skin') from the shape's textures map; defaults to the first key."),
  uv: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .describe('[u1, v1, u2, v2] in shape UV units (0..textureWidth / 0..textureHeight).'),
  rotation: z.number().optional().describe('UV rotation: 0, 90, 180 or 270 (degrees, clockwise corner cycle).'),
  glow: z.number().optional().describe('Glow 0–255; acts as a brightness floor when rendered.'),
  enabled: z.boolean().optional().describe('false disables the face (the engine drops it at load).'),
});

/** Uniform shorthand: `{ all: {...} }` applies one spec to all six faces with auto UVs. */
const uniformFaceSpecSchema = z.object({
  texture: z
    .string()
    .optional()
    .describe("Texture key ('skin' or '#skin') for every face; defaults to the first key."),
  rotation: z.number().optional().describe('UV rotation 0/90/180/270 on every face.'),
  glow: z.number().optional().describe('Glow 0–255 on every face (omitted when 0).'),
  enabled: z.boolean().optional().describe('false disables every face.'),
});

/** Element-name glob → anchored case-insensitive RegExp ('*' = any run, '?' = one char). */
function elementGlobToRegExp(glob: string): RegExp {
  return new RegExp(
    `^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`,
    'i',
  );
}

/** A selector is a glob (not a literal element name) when it contains '*' or '?'. */
const isElementGlob = (s: string): boolean => s.includes('*') || s.includes('?');

/**
 * Expand element selectors to concrete element names: selectors containing glob chars
 * ('*'/'?') match element names case-insensitively (the shape_find dialect); literal names
 * pass through unchanged (their existence is validated downstream by the op). Order is
 * preserved and names deduped, so overlapping globs/names set each face once. Throws —
 * naming the glob — when a glob matches no element, so a typo'd pattern is not a silent no-op.
 */
function resolveElementSelectors(doc: ShapeDocument, selectors: string[], op: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  };
  for (const sel of selectors) {
    if (!isElementGlob(sel)) {
      add(sel);
      continue;
    }
    const re = elementGlobToRegExp(sel);
    let matched = 0;
    doc.walk((el) => {
      if (re.test(el.name)) {
        matched++;
        add(el.name);
      }
    });
    if (matched === 0) {
      throw new Error(
        `${op}: glob '${sel}' matched no elements (case-insensitive; '*' = any run, ` +
          `'?' = one char). Use shape_find to preview which names a glob hits.`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildServer
// ---------------------------------------------------------------------------

export function buildServer(opts: BuildServerOpts = {}): McpServer {
  // Render texture resolution (render/views.ts) discovers the game install itself via
  // VINTAGE_STORY / %APPDATA%; threading --game-path through the documented env var is the
  // one supported hook, so an explicit gamePath is published there for the render path.
  if (opts.gamePath !== undefined && opts.gamePath !== '') {
    process.env['VINTAGE_STORY'] = opts.gamePath;
  }
  const renderer: BackendPreference = opts.renderer ?? 'auto';

  const server = new McpServer({ name: 'vs-shapes-mcp', version: '0.1.0' });
  const session = new Session();

  // ---- corpus (lazy; the server must run for pure editing with NO install) ----
  let corpus: Corpus | undefined;
  const getCorpus = (toolName: string): Corpus => {
    if (corpus === undefined) {
      try {
        corpus = initCorpus(opts.gamePath);
      } catch (e) {
        throw new Error(
          `${toolName} needs the Vintage Story asset corpus, but no game install was found. ` +
            `Start the server with --game-path <install dir> (the folder containing "assets"). ` +
            `Details: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return corpus;
  };
  const corpusAvailable = (): boolean => {
    try {
      getCorpus('probe');
      return true;
    } catch {
      return false;
    }
  };

  // ---- shared response plumbing ----
  const jsonResult = (payload: unknown): CallToolResult => ({
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  });

  /**
   * Repeated findings of one code collapse into a single entry with a count (e.g. 78
   * uv/out-of-bounds after an import, or anim/no-keyframes repeated while authoring) —
   * mutate responses stay agent-sized; validate_run keeps the full list.
   */
  const groupFindings = (findings: Finding[]): (Finding & { count?: number })[] => {
    const byCode = new Map<string, Finding[]>();
    for (const f of findings) {
      const list = byCode.get(f.code) ?? [];
      list.push(f);
      byCode.set(f.code, list);
    }
    const out: (Finding & { count?: number })[] = [];
    for (const list of byCode.values()) {
      if (list.length <= 2) out.push(...list);
      else {
        const first = list[0]!;
        out.push({
          ...first,
          count: list.length,
          message: `${first.message} (+${list.length - 1} more '${first.code}' findings — run validate_run for the full list)`,
        });
      }
    }
    return out;
  };

  const validationSummary = (
    doc: ShapeDocument,
    level: 'fast' | 'full' = 'fast',
  ): { errors: (Finding & { count?: number })[]; warnings: (Finding & { count?: number })[] } => {
    const findings = validateDocument(doc, { level });
    return {
      errors: groupFindings(findings.filter((f) => f.severity === 'error')),
      warnings: groupFindings(findings.filter((f) => f.severity === 'warn')),
    };
  };

  /** One transaction per mutating tool; response = {summary, validation, ...opData}. */
  const mutate = (
    docId: string,
    summary: string,
    fn: (m: ManagedDoc) => Record<string, unknown> | void,
    level: 'fast' | 'full' = 'fast',
  ): CallToolResult => {
    const m = session.get(docId);
    const opData = m.doc.transact(summary, () => fn(m));
    return jsonResult({ summary, validation: validationSummary(m.doc, level), ...(opData ?? {}) });
  };

  /**
   * Tool-handler wrapper: any error → a CallToolResult with isError: true and the
   * underlying actionable message as its text. Deliberately NOT an McpError: the SDK
   * converts every tool-callback throw into an isError result anyway, and a thrown
   * McpError would surface to the agent with a misleading protocol-level
   * 'MCP error -32602:' prefix (semantically wrong for runtime/state failures like a
   * missing file or game install).
   */
  const guard =
    <A extends unknown[]>(fn: (...args: A) => CallToolResult | Promise<CallToolResult>) =>
    async (...args: A): Promise<CallToolResult> => {
      try {
        return await fn(...args);
      } catch (e) {
        return {
          content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        };
      }
    };

  // ---- shared doc queries ----
  const countElements = (doc: ShapeDocument): number => {
    let n = 0;
    doc.walk(() => n++);
    return n;
  };

  const animSummary = (a: AnimationJson) => ({
    code: animCodeOf(a),
    name: a.name,
    quantityFrames: a.quantityframes?.value ?? null,
    keyframes: a.keyframes?.length ?? 0,
    onAnimationEnd: a.onAnimationEnd ?? null,
  });

  const docSummary = (m: ManagedDoc) => {
    const doc = m.doc;
    let bounds: unknown;
    try {
      const b = modelBounds(doc);
      bounds = { min: b.min, max: b.max, units: 'blocks', note: 'static pose, emitted faces only' };
    } catch (e) {
      bounds = { unavailable: e instanceof Error ? e.message : String(e) };
    }
    return {
      docId: m.id,
      source: m.origin,
      savePath: m.savePath ?? null,
      dirty: m.dirty,
      elements: countElements(doc),
      rootElements: (doc.root.elements ?? []).map((el) => el.name),
      textureWidth: doc.root.textureWidth?.value ?? 16,
      textureHeight: doc.root.textureHeight?.value ?? 16,
      textures: doc.root.textures ?? {},
      animations: doc.listAnimations().map(animSummary),
      bounds,
    };
  };

  const requireAnimation = (doc: ShapeDocument, code: string, toolName: string): AnimationJson => {
    const anim = doc.getAnimation(code);
    if (anim !== undefined) return anim;
    const codes = doc.listAnimations().map(animCodeOf);
    throw new Error(
      `${toolName}: ${describeUnknown('animation', code, codes, doc.path ?? 'this shape')}`,
    );
  };

  // =====================================================================================
  // Document lifecycle
  // =====================================================================================

  server.registerTool(
    'shape_open',
    {
      description:
        'Open a Vintage Story shape JSON file into the session and get a docId for the other ' +
        "tools. Accepts a filesystem path, or 'corpus:<shape path>' to open a vanilla shape " +
        "from the game install (e.g. 'corpus:entity/animal/mammal/fox/fox-male' — no .json, " +
        'no shapes/ prefix; discover paths with corpus_search). Parsing is lossless: an ' +
        'unedited document saves back byte-identically.',
      inputSchema: {
        path: z
          .string()
          .describe(
            "Filesystem path to a shape .json file, or 'corpus:<relative shape path>' " +
              "(optionally domain-prefixed like 'corpus:survival:entity/...') resolved from the game install.",
          ),
      },
    },
    guard(({ path }) => {
      let text: string;
      let origin: string;
      let savePath: string | undefined;
      if (path.startsWith('corpus:')) {
        const rel = path.slice('corpus:'.length);
        text = getCorpus('shape_open').read(rel);
        origin = `corpus:${rel}`;
      } else {
        savePath = resolve(path);
        try {
          // NO BOM strip here: parseVsJson preserves a leading BOM losslessly in the
          // document trivia, which is what makes "an unedited document saves back
          // byte-identically" true for BOM'd files too.
          text = readFileSync(savePath, 'utf8');
        } catch (e) {
          throw new Error(
            `shape_open: cannot read '${savePath}': ${e instanceof Error ? e.message : String(e)} — ` +
              `pass a path to an existing shape .json file, or use 'corpus:<path>' for vanilla shapes`,
          );
        }
        origin = savePath;
      }
      const doc = ShapeDocument.parse(text, { path: origin });
      const m = session.open(doc, { ...(savePath !== undefined ? { savePath } : {}), origin });
      try {
        return jsonResult({ ...docSummary(m), validation: validationSummary(doc) });
      } catch (e) {
        // A failed summary/validation must not leak a registered document the agent has
        // no docId for (a zombie that breaks shape_list_open until guessed closed).
        session.close(m.id);
        throw e;
      }
    }),
  );

  server.registerTool(
    'shape_create',
    {
      description:
        'Create a new empty shape document (model-creator style header, no elements) and get ' +
        'its docId. Use element_add to build geometry, shape_save to write it to disk.',
      inputSchema: {
        textureWidth: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Texture sheet width in shape UV units (default 32; vanilla entities use 32 or 64).'),
        textureHeight: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Texture sheet height in shape UV units (default 32).'),
      },
    },
    guard(({ textureWidth, textureHeight }) => {
      const doc = ShapeDocument.create({
        textureWidth: textureWidth ?? 32,
        textureHeight: textureHeight ?? 32,
      });
      const m = session.open(doc, { origin: '(created)' });
      return jsonResult(docSummary(m));
    }),
  );

  server.registerTool(
    'shape_save',
    {
      description:
        'Serialize an open document to disk (VS model-creator style: CRLF, tabs, inline number ' +
        'arrays — unedited documents round-trip byte-identically). Parent directories are created.',
      inputSchema: {
        docId: docIdParam,
        path: z
          .string()
          .optional()
          .describe(
            'Destination .json path. Optional when the document was opened from (or previously ' +
              'saved to) a file; corpus-opened and created documents need it the first time.',
          ),
      },
    },
    guard(({ docId, path }) => {
      const m = session.get(docId);
      const target = path !== undefined ? resolve(path) : m.savePath;
      if (target === undefined) {
        throw new Error(
          `shape_save: document ${m.id} (${m.origin}) has no save path — it was ` +
            `${m.origin.startsWith('corpus:') ? 'opened from the read-only corpus' : 'created in-session'}; ` +
            `pass 'path' with the destination file`,
        );
      }
      const text = m.doc.serialize();
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text, 'utf8');
      m.savePath = target;
      m.markClean(text);
      return jsonResult({
        savedTo: target,
        bytes: Buffer.byteLength(text, 'utf8'),
        validation: validationSummary(m.doc),
      });
    }),
  );

  server.registerTool(
    'shape_close',
    {
      description:
        'Close an open document and free its docId. Unsaved changes are discarded (the response ' +
        'tells you whether there were any).',
      inputSchema: { docId: docIdParam },
    },
    guard(({ docId }) => {
      const m = session.get(docId);
      const hadUnsavedChanges = m.dirty;
      session.close(docId);
      return jsonResult({
        closed: docId,
        hadUnsavedChanges,
        ...(hadUnsavedChanges ? { note: 'unsaved changes were discarded' } : {}),
      });
    }),
  );

  server.registerTool(
    'shape_list_open',
    {
      description: 'List every open document: docId, source, save path, dirty flag, quick stats.',
      inputSchema: {},
    },
    guard(() =>
      jsonResult({
        open: session.list().map((m) => {
          // Per-doc guard: ONE corrupted document (e.g. via doc_patch_json) must not make
          // the whole registry listing fail — this is the tool agents are pointed at to
          // recover, so broken docs are listed with their error instead.
          try {
            return {
              docId: m.id,
              source: m.origin,
              savePath: m.savePath ?? null,
              dirty: m.dirty,
              elements: countElements(m.doc),
              animations: m.doc.listAnimations().map(animCodeOf),
            };
          } catch (e) {
            return {
              docId: m.id,
              source: m.origin,
              savePath: m.savePath ?? null,
              error:
                `document is not traversable: ${e instanceof Error ? e.message : String(e)} ` +
                `— doc_undo (or shape_close) ${m.id} to recover`,
            };
          }
        }),
      }),
    ),
  );

  // =====================================================================================
  // Undo / redo / history
  // =====================================================================================

  server.registerTool(
    'doc_undo',
    {
      description:
        'Undo the most recent transaction on a document (every mutating tool call is one ' +
        'transaction). Restores the tree byte-identically, including number formatting.',
      inputSchema: { docId: docIdParam },
    },
    guard(({ docId }) => {
      const m = session.get(docId);
      const undone = m.doc.undo();
      return jsonResult(
        undone === null
          ? { undone: null, note: 'nothing to undo' }
          : { undone, validation: validationSummary(m.doc) },
      );
    }),
  );

  server.registerTool(
    'doc_redo',
    {
      description: 'Re-apply the most recently undone transaction on a document.',
      inputSchema: { docId: docIdParam },
    },
    guard(({ docId }) => {
      const m = session.get(docId);
      const redone = m.doc.redo();
      return jsonResult(
        redone === null
          ? { redone: null, note: 'nothing to redo' }
          : { redone, validation: validationSummary(m.doc) },
      );
    }),
  );

  server.registerTool(
    'doc_history',
    {
      description:
        'List the applied transactions of a document, oldest first (undo walks this backwards; ' +
        "'at' is a monotonic sequence number, not wall-clock time).",
      inputSchema: { docId: docIdParam },
    },
    guard(({ docId }) => jsonResult({ history: session.get(docId).doc.history() })),
  );

  // =====================================================================================
  // Queries
  // =====================================================================================

  server.registerTool(
    'shape_describe',
    {
      description:
        "Describe an open document. level 'summary' = counts, textures, animations, bounds; " +
        "'tree' = the nested element hierarchy with from/to (1/16-block units) and rotations; " +
        "'element' = full detail of one element (requires the 'element' param).",
      inputSchema: {
        docId: docIdParam,
        level: z
          .enum(['summary', 'tree', 'element'])
          .optional()
          .describe("Detail level (default 'summary')."),
        element: z
          .string()
          .optional()
          .describe("Element name, required for level 'element' (names are case-sensitive)."),
      },
    },
    guard(({ docId, level, element }) => {
      const m = session.get(docId);
      const doc = m.doc;
      const lvl = level ?? 'summary';
      if (lvl === 'summary') return jsonResult(docSummary(m));
      if (lvl === 'tree') {
        const node = (el: ElementJson): Record<string, unknown> => {
          const rot: Record<string, number> = {};
          if (el.rotationX) rot['x'] = el.rotationX.value;
          if (el.rotationY) rot['y'] = el.rotationY.value;
          if (el.rotationZ) rot['z'] = el.rotationZ.value;
          return {
            name: el.name,
            from: vec3Of(el.from),
            to: vec3Of(el.to),
            ...(el.rotationOrigin ? { rotationOrigin: vec3Of(el.rotationOrigin) } : {}),
            ...(Object.keys(rot).length > 0 ? { rotation: rot } : {}),
            ...(el.children?.length ? { children: el.children.map(node) } : {}),
          };
        };
        return jsonResult({
          docId: m.id,
          units: '1/16 block (from/to/rotationOrigin); rotations in degrees',
          elements: (doc.root.elements ?? []).map(node),
        });
      }
      if (element === undefined) {
        throw new Error(
          "shape_describe: level 'element' needs the 'element' param with the element name " +
            '(use level \'tree\' to list names)',
        );
      }
      const el = doc.getElement(element);
      if (el === undefined) {
        const names: string[] = [];
        doc.walk((e) => names.push(e.name));
        throw new Error(
          `shape_describe: ${describeUnknown('element', element, names, doc.path ?? 'this shape')}`,
        );
      }
      const keyedBy: string[] = [];
      for (const anim of doc.listAnimations()) {
        const code = animCodeOf(anim);
        if (
          (anim.keyframes ?? []).some((kf) =>
            Object.prototype.hasOwnProperty.call(kf.elements ?? {}, element),
          )
        ) {
          keyedBy.push(code);
        }
      }
      return jsonResult({
        docId: m.id,
        units: '1/16 block; rotations in degrees',
        element: toPlain({ ...el, children: undefined } as unknown as JsonValue),
        parent: doc.parentOf(element)?.name ?? null,
        children: (el.children ?? []).map((c) => c.name),
        animationsKeyingThisElement: keyedBy,
      });
    }),
  );

  server.registerTool(
    'shape_measure',
    {
      description:
        'Measure world-space axis-aligned bounds of the static pose (rotations applied), per ' +
        'element subtree and as a union, reported both in 1/16-block units and blocks.',
      inputSchema: {
        docId: docIdParam,
        elements: z
          .array(z.string())
          .optional()
          .describe('Element names to measure (each includes its descendants). Omit for the whole model.'),
      },
    },
    guard(({ docId, elements }) => {
      const m = session.get(docId);
      const doc = m.doc;
      if ((doc.root.elements ?? []).length === 0) {
        throw new Error(
          `shape_measure: ${doc.path ?? 'this shape'} has no elements yet — add one with element_add first`,
        );
      }
      const allNames: string[] = [];
      doc.walk((el) => allNames.push(el.name));
      const targets = elements ?? (doc.root.elements ?? []).map((el) => el.name);
      for (const name of targets) {
        if (!allNames.includes(name)) {
          throw new Error(
            `shape_measure: ${describeUnknown('element', name, allNames, doc.path ?? 'this shape')}`,
          );
        }
      }
      const mats = elementMatrices(doc);
      const mk = () => ({
        min: [Infinity, Infinity, Infinity] as Vec3,
        max: [-Infinity, -Infinity, -Infinity] as Vec3,
      });
      const boxes = new Map<string, { min: Vec3; max: Vec3 }>(targets.map((t) => [t, mk()]));
      const union = mk();
      doc.walk((el, path) => {
        const owners = targets.filter((t) => t === el.name || path.some((p) => p.name === t));
        const inUnion = elements === undefined || owners.length > 0;
        if (owners.length === 0 && !inUnion) return;
        const world = mats.get(el.name);
        if (world === undefined) return; // duplicate-name shadowing; validator reports it
        const size: Vec3 = [
          (el.to[0]!.value - el.from[0]!.value) / 16,
          (el.to[1]!.value - el.from[1]!.value) / 16,
          (el.to[2]!.value - el.from[2]!.value) / 16,
        ];
        for (let c = 0; c < 8; c++) {
          const p = mat4TransformVec3(world, [
            (c & 1 ? 1 : 0) * size[0],
            (c & 2 ? 1 : 0) * size[1],
            (c & 4 ? 1 : 0) * size[2],
          ]);
          for (const box of [...owners.map((o) => boxes.get(o)!), ...(inUnion ? [union] : [])]) {
            for (let a = 0; a < 3; a++) {
              if (p[a]! < box.min[a]!) box.min[a] = p[a]!;
              if (p[a]! > box.max[a]!) box.max[a] = p[a]!;
            }
          }
        }
      });
      const report = (b: { min: Vec3; max: Vec3 }) => ({
        blocks: {
          min: b.min,
          max: b.max,
          size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]],
        },
        units16: {
          min: b.min.map((v) => v * 16),
          max: b.max.map((v) => v * 16),
          size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].map((v) => v * 16),
        },
      });
      return jsonResult({
        docId: m.id,
        note: 'static pose; rotations applied; element boxes include zero-thickness geometry',
        perElement: Object.fromEntries(targets.map((t) => [t, report(boxes.get(t)!)])),
        union: report(union),
      });
    }),
  );

  server.registerTool(
    'shape_find',
    {
      description:
        "Find elements by name glob ('*' = any run, '?' = one char; case-insensitive; " +
        "e.g. '*leg*' or 'b?dy'). Returns each match with its ancestor path.",
      inputSchema: {
        docId: docIdParam,
        glob: z.string().describe("Glob over element names, e.g. '*Leg*' (case-insensitive)."),
      },
    },
    guard(({ docId, glob }) => {
      const m = session.get(docId);
      const re = elementGlobToRegExp(glob);
      const matches: { name: string; parent: string | null; path: string }[] = [];
      m.doc.walk((el, path) => {
        if (re.test(el.name)) {
          matches.push({
            name: el.name,
            parent: path.length > 0 ? path[path.length - 1]!.name : null,
            path: [...path.map((p) => p.name), el.name].join('/'),
          });
        }
      });
      return jsonResult({ glob, matches, count: matches.length });
    }),
  );

  // =====================================================================================
  // Element ops (every one = exactly one transaction + fast validation)
  // =====================================================================================

  server.registerTool(
    'element_add',
    {
      description:
        'Add a box element. from/to are opposite corners in 1/16-block units (Y up, north = −Z); ' +
        'children move with their parent. By default all six faces are created with auto UVs ' +
        "and the shape's first texture key.",
      inputSchema: {
        docId: docIdParam,
        name: z.string().describe('Unique element name (animations address elements by name).'),
        parent: z
          .string()
          .optional()
          .describe('Parent element name; omit to add at root level. Child coordinates are relative to the parent\'s "from" corner.'),
        from: vec3Param('Low corner [x, y, z] in 1/16-block units.'),
        to: vec3Param('High corner [x, y, z] in 1/16-block units (≥ from per axis; equal = zero-thick plane).'),
        rotationOrigin: vec3Param(
          'Pivot [x, y, z] in 1/16-block units for the rotation fields (default [0, 0, 0]).',
        ).optional(),
        rotation: z
          .object({
            x: z.number().optional().describe('Rotation about X in degrees.'),
            y: z.number().optional().describe('Rotation about Y in degrees.'),
            z: z.number().optional().describe('Rotation about Z in degrees.'),
          })
          .optional()
          .describe('Static rotation in degrees (engine applies Z, then Y, then X).'),
        faces: z
          .union([
            z.literal('auto-uv'),
            z.literal('none'),
            z.object({ all: uniformFaceSpecSchema }),
            z.record(z.enum(FACE_VALUES), faceSpecSchema),
          ])
          .optional()
          .describe(
            "'auto-uv' (default): six faces, UV [0, 0, faceW, faceH]; 'none': no faces (pivot/group " +
              "element); { all: {...} }: auto UVs with one texture/glow/rotation/enabled on all six " +
              'faces (uniform shorthand); or an explicit per-face map (faces named for the side they ' +
              'show: north = −Z).',
          ),
      },
    },
    guard(({ docId, name, parent, from, to, rotationOrigin, rotation, faces }) =>
      mutate(docId, `element_add '${name}'`, (m) => {
        const el = addElement(m.doc, {
          name,
          from: from as Vec3,
          to: to as Vec3,
          ...(parent !== undefined ? { parent } : {}),
          ...(rotationOrigin !== undefined ? { rotationOrigin: rotationOrigin as Vec3 } : {}),
          ...(rotation !== undefined ? { rotation } : {}),
          ...(faces !== undefined ? { faces } : {}),
        });
        return { added: el.name, parent: parent ?? null };
      }),
    ),
  );

  server.registerTool(
    'element_edit',
    {
      description:
        'Edit the geometry fields of one element (patch semantics: absent fields stay; null ' +
        'clears optional fields). Children are NOT compensated — they keep coordinates relative ' +
        "to the parent's from corner.",
      inputSchema: {
        docId: docIdParam,
        name: z.string().describe('Element to edit (case-sensitive name).'),
        from: vec3Param('New low corner [x, y, z] in 1/16-block units.').optional(),
        to: vec3Param('New high corner [x, y, z] in 1/16-block units.').optional(),
        rotationOrigin: vec3Param('New pivot in 1/16-block units; null removes it (pivot = [0, 0, 0]).')
          .nullable()
          .optional(),
        rotationX: z.number().nullable().optional().describe('Rotation about X in degrees; null removes the field (= 0).'),
        rotationY: z.number().nullable().optional().describe('Rotation about Y in degrees; null removes the field (= 0).'),
        rotationZ: z.number().nullable().optional().describe('Rotation about Z in degrees; null removes the field (= 0).'),
        scaleX: z.number().nullable().optional().describe('Render-time element scale about rotationOrigin (> 0, inherits down the subtree); null removes the field (= 1). Geometry/UVs untouched.'),
        scaleY: z.number().nullable().optional().describe('Render-time element scale about rotationOrigin; null removes the field (= 1).'),
        scaleZ: z.number().nullable().optional().describe('Render-time element scale about rotationOrigin; null removes the field (= 1).'),
      },
    },
    guard(({ docId, name, from, to, rotationOrigin, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ }) =>
      mutate(docId, `element_edit '${name}'`, (m) => {
        editElement(m.doc, name, {
          ...(from !== undefined ? { from: from as Vec3 } : {}),
          ...(to !== undefined ? { to: to as Vec3 } : {}),
          ...(rotationOrigin !== undefined
            ? { rotationOrigin: rotationOrigin as Vec3 | null }
            : {}),
          ...(rotationX !== undefined ? { rotationX } : {}),
          ...(rotationY !== undefined ? { rotationY } : {}),
          ...(rotationZ !== undefined ? { rotationZ } : {}),
          ...(scaleX !== undefined ? { scaleX } : {}),
          ...(scaleY !== undefined ? { scaleY } : {}),
          ...(scaleZ !== undefined ? { scaleZ } : {}),
        });
        return { edited: name };
      }),
    ),
  );

  server.registerTool(
    'element_rename',
    {
      description:
        'Rename an element and cascade the new name into every keyframe of every animation ' +
        '(animations key on element names — renaming without the cascade silently breaks them).',
      inputSchema: {
        docId: docIdParam,
        oldName: z.string().describe('Current element name.'),
        newName: z.string().describe('New unique element name.'),
      },
    },
    guard(({ docId, oldName, newName }) =>
      mutate(docId, `element_rename '${oldName}' -> '${newName}'`, (m) => {
        const result = renameElement(m.doc, oldName, newName);
        return { renamed: { from: oldName, to: newName }, ...result };
      }),
    ),
  );

  server.registerTool(
    'element_reparent',
    {
      description:
        'Move an element (with its subtree) under a new parent. By default the world position ' +
        'is preserved by recomputing from/to/rotationOrigin; when rotated/scaled ancestors are ' +
        'involved an axis-aligned box cannot keep both position and orientation — the response ' +
        'carries a warning describing the residual.',
      inputSchema: {
        docId: docIdParam,
        name: z.string().describe('Element to move.'),
        newParent: z
          .string()
          .nullable()
          .describe('New parent element name, or null to move to root level.'),
        preserveWorld: z
          .boolean()
          .optional()
          .describe('Keep the world position by recomputing local coordinates (default true).'),
      },
    },
    guard(({ docId, name, newParent, preserveWorld }) =>
      mutate(docId, `element_reparent '${name}' -> ${newParent === null ? 'root' : `'${newParent}'`}`, (m) => {
        const result = reparentElement(m.doc, name, newParent, {
          ...(preserveWorld !== undefined ? { preserveWorld } : {}),
        });
        return { reparented: name, newParent, ...result };
      }),
    ),
  );

  server.registerTool(
    'element_mirror',
    {
      description:
        'Insert a mirrored deep copy of an element subtree (exact world-geometry reflection: ' +
        'from/to reflected and swapped, rotation signs conjugated). Names get L/R swaps where ' +
        "recognizable ('L '/'R ' prefix, 'left'/'right', '-l'/'-r'), then are unique-ified. " +
        'Face UVs are copied as-is (textures appear mirrored).',
      inputSchema: {
        docId: docIdParam,
        name: z.string().describe('Root of the subtree to mirror.'),
        axis: z.enum(['x', 'z']).describe("Mirror axis: 'x' reflects across a YZ plane, 'z' across an XY plane."),
        about: z
          .number()
          .optional()
          .describe(
            'Mirror-plane coordinate in 1/16-block units, in the coordinate space the element\'s ' +
              'from/to live in (default 8 = the model center plane for root-level elements).',
          ),
        newName: z.string().optional().describe('Explicit name for the mirrored copy\'s root.'),
      },
    },
    guard(({ docId, name, axis, about, newName }) =>
      mutate(docId, `element_mirror '${name}' (${axis})`, (m) => {
        const names = mirrorElement(m.doc, name, axis, {
          ...(about !== undefined ? { about } : {}),
          ...(newName !== undefined ? { newName } : {}),
        });
        return { mirrored: name, axis, names };
      }),
    ),
  );

  server.registerTool(
    'element_scale',
    {
      description:
        'Scale an element subtree — or the whole model — about an anchor point. Scales ' +
        'from/to/rotationOrigin; whole-model scaling also scales every keyframe offset triple ' +
        '(translations in 1/16-block units), never rotations or stretch.',
      inputSchema: {
        docId: docIdParam,
        name: z
          .string()
          .nullable()
          .describe('Element subtree to scale, or null for the whole model (includes keyframe offsets).'),
        factor: z
          .union([z.number(), z.tuple([z.number(), z.number(), z.number()])])
          .describe('Uniform factor, or per-axis [x, y, z] factors (> 0; use element_mirror for reflections).'),
        anchor: vec3Param(
          'Fixed point of the scaling in 1/16-block units (default [0, 0, 0]; [8, 0, 8] keeps a ' +
            'block-centered model centered).',
        ).optional(),
      },
    },
    guard(({ docId, name, factor, anchor }) =>
      mutate(docId, `element_scale ${name === null ? '(whole model)' : `'${name}'`}`, (m) => {
        const a = (anchor ?? [0, 0, 0]) as Vec3;
        scaleElement(m.doc, name, factor as number | Vec3, a);
        // Geometry grew but UVs didn't change: warn NOW if a future auto-UV repack no
        // longer fits the sheet, instead of letting the next uv_auto call fail cold.
        const fit = planAutoUvFit(m.doc);
        return {
          scaled: name ?? '(whole model)',
          factor,
          anchor: a,
          ...(fit.fits
            ? {}
            : {
                warning:
                  `the scaled faces no longer fit the ${fit.width}x${fit.height} sheet for a full ` +
                  `auto-UV repack — set textureWidth/textureHeight to ${fit.neededWidth}x${fit.neededHeight} ` +
                  `(doc_patch_json) before the next uv_auto, and rebake textures at the new size`,
              }),
        };
      }),
    ),
  );

  server.registerTool(
    'element_delete',
    {
      description:
        'Delete an element and its subtree. Refuses (naming the animations and frames involved) ' +
        'when keyframes reference the subtree, unless force: true — which also strips those ' +
        'keyframe entries and reports them.',
      inputSchema: {
        docId: docIdParam,
        name: z.string().describe('Element to delete (with all descendants).'),
        force: z
          .boolean()
          .optional()
          .describe('true: also strip keyframe entries that reference the subtree (default false).'),
      },
    },
    guard(({ docId, name, force }) =>
      mutate(docId, `element_delete '${name}'${force ? ' (force)' : ''}`, (m) => {
        const result = deleteElement(m.doc, name, { ...(force !== undefined ? { force } : {}) });
        return { deleted: name, ...result };
      }),
    ),
  );

  server.registerTool(
    'element_duplicate',
    {
      description:
        'Deep-copy an element subtree as a sibling of the original. Descendant names are ' +
        "unique-ified with numeric suffixes; the response maps old names to new ones.",
      inputSchema: {
        docId: docIdParam,
        name: z.string().describe('Element subtree to duplicate.'),
        newName: z.string().optional().describe("Name for the copy's root (default: original name unique-ified)."),
      },
    },
    guard(({ docId, name, newName }) =>
      mutate(docId, `element_duplicate '${name}'`, (m) => {
        const names = duplicateElement(m.doc, name, newName);
        return { duplicated: name, names };
      }),
    ),
  );

  server.registerTool(
    'element_import',
    {
      description:
        'Kitbash: copy an element subtree from another OPEN document into this one. Names are ' +
        'unique-ified; texture map entries the subtree needs are copied along (keys that collide ' +
        'on path or UV space are remapped and reported). When the source UV space differs, a ' +
        'textureSizes override is added so the copied face UVs stay valid; stepParentName fields ' +
        'are stripped when importing under a parent (stale overlay-attachment data).',
      inputSchema: {
        docId: docIdParam,
        fromDocId: z.string().describe('docId of the open source document to copy from.'),
        name: z.string().describe('Element subtree (in the source document) to import.'),
        parent: z
          .string()
          .optional()
          .describe('Parent element in the TARGET document; omit to import at root level.'),
      },
    },
    guard(({ docId, fromDocId, name, parent }) => {
      const source = session.get(fromDocId);
      return mutate(docId, `element_import '${name}' from ${fromDocId}`, (m) => {
        if (m.id === source.id) {
          throw new Error(
            `element_import: source and target are the same document (${m.id}) — use ` +
              `element_duplicate to copy within one document`,
          );
        }
        const result = importElement(m.doc, source.doc, name, {
          ...(parent !== undefined ? { parent } : {}),
        });
        return { imported: name, fromDocId, ...result };
      });
    }),
  );

  // =====================================================================================
  // Animation queries + ops
  // =====================================================================================

  server.registerTool(
    'anim_list',
    {
      description:
        "List a document's animations: code (what entities trigger; defaults to name), frame " +
        'count (30 frames ≈ 1 second), keyframe count and end behavior.',
      inputSchema: { docId: docIdParam },
    },
    guard(({ docId }) =>
      jsonResult({ animations: session.get(docId).doc.listAnimations().map(animSummary) }),
    ),
  );

  server.registerTool(
    'anim_describe',
    {
      description:
        'Full detail of one animation: meta plus every keyframe with its per-element channel ' +
        'values (offset in 1/16-block units, rotation in degrees, stretch as scale factors).',
      inputSchema: {
        docId: docIdParam,
        code: z.string().describe("Animation code (or name when it has no explicit code), e.g. 'walk'."),
      },
    },
    guard(({ docId, code }) => {
      const m = session.get(docId);
      const anim = requireAnimation(m.doc, code, 'anim_describe');
      const animated = new Set<string>();
      const keyframes = (anim.keyframes ?? []).map((kf) => {
        for (const n of Object.keys(kf.elements ?? {})) animated.add(n);
        return {
          frame: kf.frame?.value ?? null,
          elements: toPlain((kf.elements ?? {}) as unknown as JsonValue),
        };
      });
      return jsonResult({
        ...animSummary(anim),
        onActivityStopped: anim.onActivityStopped ?? null,
        version: anim.version?.value ?? null,
        animatedElements: [...animated],
        units: 'offset in 1/16 block; rotation in degrees; stretch = scale factor (neutral 1)',
        keyframes,
      });
    }),
  );

  server.registerTool(
    'anim_create',
    {
      description:
        'Create an empty animation. quantityFrames is the cycle length (30 ≈ 1 second at the ' +
        '30 fps convention) and must stay strictly greater than every keyframe frame.',
      inputSchema: {
        docId: docIdParam,
        code: z.string().describe('Unique animation code (entities trigger animations by code).'),
        name: z.string().optional().describe('Display name (defaults to the code).'),
        quantityFrames: z.number().int().positive().describe('Cycle length in frames (30 ≈ 1 s).'),
        onAnimationEnd: z
          .enum(['Repeat', 'Hold', 'Stop', 'EaseOut'])
          .optional()
          .describe("End behavior (default 'Repeat' — use for loops like walk cycles)."),
        onActivityStopped: z
          .string()
          .optional()
          .describe("Behavior when the triggering activity stops (default 'EaseOut'; engine default is 'Rewind')."),
        anchorElements: z
          .array(z.string())
          .optional()
          .describe(
            'Elements to seed with zero rotation+offset keys at frame 0 — the neutral-pose ' +
              'anchor every Stop/Hold animation needs so frames before the first real key ' +
              "don't wrap-lerp from the last one.",
          ),
      },
    },
    guard(({ docId, code, name, quantityFrames, onAnimationEnd, onActivityStopped, anchorElements }) =>
      mutate(docId, `anim_create '${code}'`, (m) => {
        createAnimation(m.doc, {
          code,
          quantityFrames,
          ...(name !== undefined ? { name } : {}),
          ...(onAnimationEnd !== undefined ? { onAnimationEnd } : {}),
          ...(onActivityStopped !== undefined ? { onActivityStopped } : {}),
        });
        for (const el of anchorElements ?? []) {
          setKeyframe(m.doc, code, 0, el, { rotation: [0, 0, 0], offset: [0, 0, 0] });
        }
        return {
          created: code,
          quantityFrames,
          ...(anchorElements !== undefined && anchorElements.length > 0
            ? { anchoredAtFrame0: anchorElements }
            : {}),
        };
      }),
    ),
  );

  server.registerTool(
    'anim_delete',
    {
      description: 'Delete an animation (all its keyframes go with it).',
      inputSchema: {
        docId: docIdParam,
        code: z.string().describe('Animation code to delete.'),
      },
    },
    guard(({ docId, code }) =>
      mutate(docId, `anim_delete '${code}'`, (m) => {
        deleteAnimation(m.doc, code);
        return { deleted: code };
      }),
    ),
  );

  server.registerTool(
    'anim_edit_meta',
    {
      description:
        'Edit animation metadata: rename the code, set quantityFrames directly (WITHOUT moving ' +
        'keyframes — must stay greater than every keyframe frame; use anim_retime to rescale), ' +
        'or change end handling. null deletes an optional field.',
      inputSchema: {
        docId: docIdParam,
        code: z.string().describe('Animation to edit (current code).'),
        newCode: z.string().optional().describe('New unique code.'),
        name: z.string().optional().describe('New display name.'),
        quantityFrames: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('New cycle length; keyframes do NOT move (anim_retime rescales them proportionally).'),
        onAnimationEnd: z
          .string()
          .nullable()
          .optional()
          .describe("e.g. 'Repeat', 'Hold', 'Stop', 'EaseOut'; null removes the field."),
        onActivityStopped: z
          .string()
          .nullable()
          .optional()
          .describe("e.g. 'EaseOut', 'Rewind', 'Stop', 'PlayTillEnd'; null removes the field."),
        easeAnimationSpeed: z
          .boolean()
          .nullable()
          .optional()
          .describe('Smooth speed changes when the animation starts/stops; null removes the field.'),
        version: z
          .number()
          .nullable()
          .optional()
          .describe('Animation version (1 changes the pose-composition order); null removes the field.'),
      },
    },
    guard(({ docId, code, newCode, name, quantityFrames, onAnimationEnd, onActivityStopped, easeAnimationSpeed, version }) =>
      mutate(docId, `anim_edit_meta '${code}'`, (m) => {
        editAnimationMeta(m.doc, code, {
          ...(newCode !== undefined ? { code: newCode } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(quantityFrames !== undefined ? { quantityFrames } : {}),
          ...(onAnimationEnd !== undefined ? { onAnimationEnd } : {}),
          ...(onActivityStopped !== undefined ? { onActivityStopped } : {}),
          ...(easeAnimationSpeed !== undefined ? { easeAnimationSpeed } : {}),
          ...(version !== undefined ? { version } : {}),
        });
        return { edited: newCode ?? code };
      }),
    ),
  );

  server.registerTool(
    'anim_set_keyframe',
    {
      description:
        "Set or clear one element's pose channels at one keyframe. A given channel writes the " +
        'FULL [x, y, z] triple (the engine crashes on partial triples); null clears the channel; ' +
        'an absent channel is left untouched. The keyframe/entry is created or pruned as needed.',
      inputSchema: {
        docId: docIdParam,
        code: z.string().describe('Animation code.'),
        frame: z
          .number()
          .int()
          .describe('Keyframe frame, an integer in 0..quantityFrames−1.'),
        element: z.string().describe('Element name to pose (must exist in the tree).'),
        offset: vec3Param('Translation [x, y, z] in 1/16-block units; null clears the offset channel.')
          .nullable()
          .optional(),
        rotation: vec3Param('Added rotation [x, y, z] in degrees; null clears the rotation channel.')
          .nullable()
          .optional(),
        stretch: vec3Param('Scale factors [x, y, z] (neutral 1); null clears the stretch channel.')
          .nullable()
          .optional(),
        rotShortestDistance: z
          .object({
            x: z.boolean().optional(),
            y: z.boolean().optional(),
            z: z.boolean().optional(),
          })
          .nullable()
          .optional()
          .describe(
            'Per-axis shortest-angular-path flags for the rotation lerp out of this keyframe ' +
              '(continuous rotators like gears need them at the cycle wrap). Given axes are ' +
              'set/removed; null removes all three. Only meaningful when the entry also has a ' +
              'rotation channel.',
          ),
      },
    },
    guard(({ docId, code, frame, element, offset, rotation, stretch, rotShortestDistance }) =>
      mutate(docId, `anim_set_keyframe '${code}' f${frame} '${element}'`, (m) => {
        const entry = setKeyframe(m.doc, code, frame, element, {
          ...(offset !== undefined ? { offset: offset as Vec3 | null } : {}),
          ...(rotation !== undefined ? { rotation: rotation as Vec3 | null } : {}),
          ...(stretch !== undefined ? { stretch: stretch as Vec3 | null } : {}),
          ...(rotShortestDistance !== undefined ? { rotShortestDistance } : {}),
        });
        return {
          animation: code,
          frame,
          element,
          entry: entry === null ? null : toPlain(entry as unknown as JsonValue),
          ...(entry === null ? { note: 'entry had no channels left and was pruned' } : {}),
        };
      }),
    ),
  );

  server.registerTool(
    'anim_delete_keyframe',
    {
      description:
        "Delete a whole keyframe, or just one element's entry in it when 'element' is given " +
        '(works on stale/ghost entries too).',
      inputSchema: {
        docId: docIdParam,
        code: z.string().describe('Animation code.'),
        frame: z.number().int().describe('Frame of the keyframe to delete.'),
        element: z
          .string()
          .optional()
          .describe("Only remove this element's entry (the keyframe stays unless emptied)."),
      },
    },
    guard(({ docId, code, frame, element }) =>
      mutate(docId, `anim_delete_keyframe '${code}' f${frame}${element !== undefined ? ` '${element}'` : ''}`, (m) => {
        deleteKeyframe(m.doc, code, frame, element);
        return { animation: code, frame, ...(element !== undefined ? { element } : {}) };
      }),
    ),
  );

  server.registerTool(
    'anim_adjust',
    {
      description:
        'Bulk-adjust one channel across all keyframes of the listed elements: scale or add a ' +
        'value, or clamp to bounds. Only components already present are touched.',
      inputSchema: {
        docId: docIdParam,
        code: z.string().describe('Animation code.'),
        elements: z
          .union([z.literal('*'), z.array(z.string())])
          .describe("Element names to adjust, or '*' for every element keyed in the animation."),
        channel: z
          .enum(['offset', 'rotation', 'stretch'])
          .describe('Channel to adjust (offset in 1/16-block units, rotation degrees, stretch factors).'),
        op: z.enum(['scale', 'add', 'clamp']).describe("'scale' multiplies, 'add' offsets, 'clamp' bounds."),
        value: z
          .union([z.number(), z.tuple([z.number(), z.number(), z.number()])])
          .optional()
          .describe('Required for scale/add: scalar (all axes) or per-axis [x, y, z].'),
        min: z
          .union([z.number(), z.tuple([z.number(), z.number(), z.number()])])
          .optional()
          .describe('Lower clamp bound (clamp op), scalar or [x, y, z].'),
        max: z
          .union([z.number(), z.tuple([z.number(), z.number(), z.number()])])
          .optional()
          .describe('Upper clamp bound (clamp op), scalar or [x, y, z].'),
      },
    },
    guard(({ docId, code, elements, channel, op, value, min, max }) =>
      mutate(docId, `anim_adjust '${code}' ${channel} ${op}`, (m) => {
        const result = adjustChannel(m.doc, code, {
          elements,
          channel,
          op,
          ...(value !== undefined ? { value: value as number | Vec3 } : {}),
          ...(min !== undefined ? { min: min as number | Vec3 } : {}),
          ...(max !== undefined ? { max: max as number | Vec3 } : {}),
        });
        return { animation: code, channel, op, ...result };
      }),
    ),
  );

  server.registerTool(
    'anim_retime',
    {
      description:
        'Change an animation\'s cycle length, moving every keyframe proportionally ' +
        '(collision-safe rounding: fails — naming the colliding frames — rather than merging keyframes).',
      inputSchema: {
        docId: docIdParam,
        code: z.string().describe('Animation code.'),
        quantityFrames: z.number().int().positive().describe('New cycle length in frames (30 ≈ 1 s).'),
      },
    },
    guard(({ docId, code, quantityFrames }) =>
      mutate(docId, `anim_retime '${code}' -> ${quantityFrames}`, (m) => {
        const result = retimeAnimation(m.doc, code, quantityFrames);
        return { animation: code, quantityFrames, ...result };
      }),
    ),
  );

  server.registerTool(
    'anim_mirror_phase',
    {
      description:
        'Gait-cycle helper: copy the first half-cycle onto the second half with element pairs ' +
        "swapped (e.g. [['L leg', 'R leg']]). Copied entries are mirror-conjugated across the " +
        "sagittal plane (default axis 'z', matching element_mirror): rotationX/rotationY and " +
        'offsetZ negate while rotationZ holds — correct for any keyed channel on a symmetric ' +
        'rig, including unpaired elements like tails and heads, whose sways alternate. ' +
        "Pass axis 'none' for a verbatim copy. Requires an even quantityFrames.",
      inputSchema: {
        docId: docIdParam,
        code: z.string().describe('Animation code (must have an even quantityFrames).'),
        pairs: z
          .array(z.tuple([z.string(), z.string()]))
          .describe("Contralateral element pairs, e.g. [['FL leg', 'FR leg'], ['BL leg', 'BR leg']]."),
        axis: z
          .enum(['x', 'z', 'none'])
          .optional()
          .describe(
            "Sagittal mirror axis for conjugating copied entries (default 'z' — VS creatures are " +
              "z-symmetric). 'none' copies values verbatim (legacy).",
          ),
      },
    },
    guard(({ docId, code, pairs, axis }) =>
      mutate(docId, `anim_mirror_phase '${code}'`, (m) => {
        const result = mirrorPhase(m.doc, code, pairs as [string, string][], {
          ...(axis !== undefined ? { axis } : {}),
        });
        return { animation: code, axis: axis ?? 'z', ...result };
      }),
    ),
  );

  // =====================================================================================
  // UV
  // =====================================================================================

  server.registerTool(
    'uv_report',
    {
      description:
        'Per-texture UV report: face rects, out-of-bounds and fractional rects, overlaps ' +
        'between different elements (capped per texture), and sheet occupancy. Rects are ' +
        '[u1, v1, u2, v2] in shape UV units (per-key textureSizes overrides honored). On ' +
        "large rigs pass 'elements' to filter and/or summary: true for counts + problem " +
        'lists only (full per-face rect lists omitted).',
      inputSchema: {
        docId: docIdParam,
        elements: z
          .array(z.string())
          .optional()
          .describe('Exact element names to report on (no subtree recursion). Omit for every element.'),
        summary: z
          .boolean()
          .optional()
          .describe(
            'true: per-texture counts, occupancy and capped problem lists instead of every face rect ' +
              '(use on big rigs — a full report on a heavily-animated humanoid is ~80 KB).',
          ),
      },
    },
    guard(({ docId, elements, summary }) => {
      const report = uvReport(session.get(docId).doc, {
        ...(elements !== undefined ? { elements } : {}),
      });
      if (summary !== true) return jsonResult({ report });
      const cap = 20;
      return jsonResult({
        report: report.map((r) => ({
          textureKey: r.textureKey,
          textureWidth: r.textureWidth,
          textureHeight: r.textureHeight,
          faces: r.faces.length,
          occupancyPercent: r.occupancyPercent,
          outOfBounds: r.outOfBounds.slice(0, cap),
          outOfBoundsCount: r.outOfBounds.length,
          fractionalCount: r.fractional.length,
          overlaps: r.overlaps.slice(0, cap),
          overlapsCount: r.overlaps.length + r.overlapsTruncated,
        })),
        note: `summary mode: per-face rect lists omitted; problem lists capped at ${cap} entries`,
      });
    }),
  );

  server.registerTool(
    'uv_set_face',
    {
      description:
        "Set one face's UV rect (and optionally rotation). Creates the face — with the shape's " +
        'first texture key — when the element does not have it yet.',
      inputSchema: {
        docId: docIdParam,
        element: z.string().describe('Element owning the face.'),
        face: z.enum(FACE_VALUES).describe('Face name = the side it shows (north = −Z, up = +Y).'),
        uv: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .describe('[u1, v1, u2, v2] in shape UV units, u1 ≤ u2 and v1 ≤ v2, within textureWidth/Height.'),
        rotation: z
          .number()
          .optional()
          .describe('UV rotation 0/90/180/270; 0 removes the field (vanilla convention).'),
      },
    },
    guard(({ docId, element, face, uv, rotation }) =>
      mutate(docId, `uv_set_face '${element}' ${face}`, (m) => {
        const f = setFaceUv(m.doc, element, face, uv as [number, number, number, number], rotation);
        return { element, face, faceJson: toPlain(f as unknown as JsonValue) };
      }),
    ),
  );

  server.registerTool(
    'face_set',
    {
      description:
        'Edit properties of EXISTING faces — texture key, glow, enabled — across one or more ' +
        'elements (optionally whole subtrees) without touching UV rects. The bulk way to ' +
        're-texture a body region (legs to a darker key, eyes to glow) that previously needed ' +
        'doc_patch_json index paths: an entry may be a literal element name OR a name glob ' +
        "(e.g. '*leg*'), so 'set glow on every matching element' is one call. Faces are not " +
        'created here (use uv_set_face or element_add).',
      inputSchema: {
        docId: docIdParam,
        elements: z
          .array(z.string())
          .min(1)
          .describe(
            "Element selectors: literal names (case-sensitive) or name globs ('*' = any run, " +
              "'?' = one char, case-insensitive — e.g. '*Leg*'). A glob matching no element is an " +
              'error; matches are deduped. Use shape_find to preview a glob.',
          ),
        subtree: z
          .boolean()
          .optional()
          .describe('true: also edit every descendant of the listed elements (default false).'),
        faces: z
          .array(z.enum(FACE_VALUES))
          .optional()
          .describe('Face filter (default: all six).'),
        texture: z
          .string()
          .optional()
          .describe("New texture key ('skin' or '#skin'); dangling keys are flagged by validation, not blocked."),
        glow: z
          .number()
          .nullable()
          .optional()
          .describe('Glow 0–255 (brightness floor, e.g. 255 for eyes); null or 0 removes the field.'),
        enabled: z
          .boolean()
          .nullable()
          .optional()
          .describe('false disables the face (engine drops it at load); true or null restores the default.'),
      },
    },
    guard(({ docId, elements, subtree, faces, texture, glow, enabled }) =>
      mutate(docId, `face_set [${(elements as string[]).join(', ')}]`, (m) => {
        const targets = resolveElementSelectors(m.doc, elements as string[], 'face_set');
        const result = setFaceProps(
          m.doc,
          targets,
          {
            ...(texture !== undefined ? { texture } : {}),
            ...(glow !== undefined ? { glow } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
          },
          {
            ...(faces !== undefined ? { faces: faces as FaceName[] } : {}),
            ...(subtree !== undefined ? { subtree } : {}),
          },
        );
        return { ...result };
      }),
    ),
  );

  server.registerTool(
    'uv_auto',
    {
      description:
        'Auto-UV packing (one sheet per texture key, exact face sizes, rotations cleared). ' +
        'Without elements: FULL repack of every face. With elements: INCREMENTAL — only those ' +
        "faces are re-laid, into space no other face occupies, preserving existing layouts (and " +
        'textures painted against them). Fails — naming the smallest sheet that would fit — ' +
        'when out of space. Returns a per-texture summary; pass detail: true for every rect.',
      inputSchema: {
        docId: docIdParam,
        elements: z
          .array(z.string())
          .optional()
          .describe('Exact element list to pack incrementally (no subtree recursion). Omit for a full repack.'),
        detail: z
          .boolean()
          .optional()
          .describe('true: include every packed face rect (large on big rigs); default is a per-texture summary.'),
      },
    },
    guard(({ docId, elements, detail }) =>
      mutate(docId, 'uv_auto', (m) => {
        const result = autoUv(m.doc, elements);
        if (detail === true) return { packed: result.faces.length, faces: result.faces };
        const perTexture: Record<string, { faces: number; maxU: number; maxV: number }> = {};
        for (const f of result.faces) {
          const t = (perTexture[f.textureKey] ??= { faces: 0, maxU: 0, maxV: 0 });
          t.faces++;
          t.maxU = Math.max(t.maxU, f.rect[2]);
          t.maxV = Math.max(t.maxV, f.rect[3]);
        }
        return {
          packed: result.faces.length,
          mode: elements === undefined ? 'full repack' : 'incremental (existing rects preserved)',
          perTexture,
          note: 'pass detail: true for every packed rect',
        };
      }),
    ),
  );

  // =====================================================================================
  // Render
  // =====================================================================================

  const renderResultContent = (
    image: Buffer,
    caption: string,
    missing: string[],
    savePath?: string,
    mimeType = 'image/png',
  ): CallToolResult => {
    let text = caption;
    if (missing.length > 0) {
      text +=
        `\nNote: no texture PNG found for key${missing.length > 1 ? 's' : ''} ` +
        `${missing.map((k) => `'#${k}'`).join(', ')} — deterministic flat fallback colors were used. ` +
        (corpusAvailable()
          ? `Check the shape's textures map paths (corpus_describe shows them), or pass texturesRoot for mod assets.`
          : `No Vintage Story install was found: start the server with --game-path <install dir> to resolve vanilla textures.`);
    }
    if (savePath !== undefined) {
      // Export mode: the file is the artifact — skip the inline image to keep the
      // response small (open the file to inspect it).
      const abs = resolve(savePath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, image);
      return { content: [{ type: 'text', text: `Saved render to ${abs} (${image.length} bytes)\n${text}` }] };
    }
    return {
      content: [
        { type: 'image', data: image.toString('base64'), mimeType },
        { type: 'text', text },
      ],
    };
  };

  const savePathParam = z
    .string()
    .optional()
    .describe(
      'Write the PNG to this file path instead of returning it inline (reference-render ' +
        'export; parent directories are created).',
    );

  server.registerTool(
    'render_views',
    {
      description:
        'Render the model into a labeled grid of orthographic views (PNG). Every tile shares one ' +
        'camera fit and carries a 1-block ground grid, a north (−Z) marker, the view label and a ' +
        'scale bar. Works without textures (flat fallback colors + footnote).',
      inputSchema: {
        docId: docIdParam,
        views: z
          .array(z.enum(VIEW_VALUES))
          .optional()
          .describe(
            "Views = the compass side of the model the camera looks AT (north = −Z; 'n' shows the " +
              "model's north side). Default ['n', 'e', 'sw', 'top'].",
          ),
        anim: z.string().optional().describe('Animation code to pose; omit for the static pose.'),
        frame: z
          .number()
          .optional()
          .describe('Frame to pose (may be fractional); needs anim. Default 0.'),
        size: z.number().int().optional().describe('Pixels per square view tile, 32–2048 (default 320).'),
        overlayHitbox: z
          .object({
            x: z.number().describe('Hitbox footprint side in blocks (square footprint).'),
            y: z.number().describe('Hitbox height in blocks.'),
          })
          .optional()
          .describe(
            'Draw an entity-hitbox wireframe standing on y = 0, centered on the entity ground anchor (0.5, 0, 0.5).',
          ),
        texturesRoot: z
          .string()
          .optional()
          .describe('Extra directory to resolve texture PNGs (mod assets); game assets always fall back.'),
        savePath: savePathParam,
      },
    },
    guard(async ({ docId, views, anim, frame, size, overlayHitbox, texturesRoot, savePath }) => {
      const m = session.get(docId);
      const result = await renderViews(m.doc, {
        ...(views !== undefined ? { views: views as ViewName[] } : {}),
        ...(anim !== undefined ? { anim } : {}),
        ...(frame !== undefined ? { frame } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(overlayHitbox !== undefined ? { overlayHitbox } : {}),
        ...(texturesRoot !== undefined ? { texturesRoot } : {}),
        renderer,
      });
      return renderResultContent(result.png, result.caption, result.missingTextures, savePath);
    }),
  );

  server.registerTool(
    'render_filmstrip',
    {
      description:
        'Render one animation as a single-row filmstrip PNG: tiles sample the cycle evenly ' +
        '(fractional frames included), frame numbers burned in, shared camera fit across all ' +
        'frames, ground line at y = 0.',
      inputSchema: {
        docId: docIdParam,
        anim: z.string().describe('Animation code to sample.'),
        frames: z
          .number()
          .int()
          .optional()
          .describe('Tile count, evenly spaced over [0, quantityFrames) (default 8, max 64).'),
        view: z
          .enum(VIEW_VALUES)
          .optional()
          .describe("View for every tile (side the camera looks AT; north = −Z). Default 'e'."),
        size: z.number().int().optional().describe('Pixels per square tile, 32–2048 (default 240).'),
        texturesRoot: z
          .string()
          .optional()
          .describe('Extra directory to resolve texture PNGs (mod assets); game assets always fall back.'),
        savePath: savePathParam,
      },
    },
    guard(async ({ docId, anim, frames, view, size, texturesRoot, savePath }) => {
      const m = session.get(docId);
      const result = await renderFilmstrip(m.doc, {
        anim,
        ...(frames !== undefined ? { frames } : {}),
        ...(view !== undefined ? { view: view as ViewName } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(texturesRoot !== undefined ? { texturesRoot } : {}),
        renderer,
      });
      return renderResultContent(result.png, result.caption, result.missingTextures, savePath);
    }),
  );

  server.registerTool(
    'render_gif',
    {
      description:
        'Render an animation as a looping GIF: frames sampled evenly over the cycle, one global ' +
        'palette (no inter-frame flicker), played at the chosen fps. Sampling every source frame ' +
        'at 30 fps reproduces the engine speed. Returns the GIF inline, or pass savePath to write ' +
        'it to disk (recommended — animated GIFs do not preview in every client).',
      inputSchema: {
        docId: docIdParam,
        anim: z.string().describe('Animation code to render.'),
        frames: z
          .number()
          .int()
          .optional()
          .describe('Frames sampled over [0, quantityFrames), 1–120. Default min(quantityFrames, 48).'),
        view: z
          .enum(VIEW_VALUES)
          .optional()
          .describe("Single view (side the camera looks AT; north = −Z). Default 'e'. Ignored when 'views' is set."),
        views: z
          .array(z.enum(VIEW_VALUES))
          .optional()
          .describe(
            'Multiple views → each animation frame is a composited grid (2-column for ≥4, one ' +
              'row for fewer), like render_views but animated. Overrides view.',
          ),
        size: z.number().int().optional().describe('Pixels per square tile, 32–2048 (default 200).'),
        fps: z
          .number()
          .optional()
          .describe('Playback frames per second, 1–60 (the engine convention is 30). Default 30.'),
        loop: z.boolean().optional().describe('Loop forever (default true); false plays once.'),
        texturesRoot: z
          .string()
          .optional()
          .describe('Extra directory to resolve texture PNGs (mod assets); game assets always fall back.'),
        savePath: savePathParam,
      },
    },
    guard(async ({ docId, anim, frames, view, views, size, fps, loop, texturesRoot, savePath }) => {
      const m = session.get(docId);
      const result = await renderGif(m.doc, {
        anim,
        ...(frames !== undefined ? { frames } : {}),
        ...(view !== undefined ? { view: view as ViewName } : {}),
        ...(views !== undefined ? { views: views as ViewName[] } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(fps !== undefined ? { fps } : {}),
        ...(loop !== undefined ? { loop } : {}),
        ...(texturesRoot !== undefined ? { texturesRoot } : {}),
        renderer,
      });
      return renderResultContent(result.gif, result.caption, result.missingTextures, savePath, 'image/gif');
    }),
  );

  server.registerTool(
    'palette_extract',
    {
      description:
        "Extract a model's color palette from its texture PNGs: a compact set of colors ranked " +
        'by how much of the texels they cover (hex + rgb + coverage fraction). Use it to reuse a ' +
        "vanilla creature's colors on a new model, or to describe its color scheme. By default " +
        'colors are median-cut representatives (vanilla textures are dithered into thousands of ' +
        'near-identical shades — distinctColors reports that noisiness); pass exact: true for the ' +
        'precise 8-bit colors of flat pixel art. Textures resolve exactly like the render tools ' +
        '(game install + optional texturesRoot); a key whose PNG is not found is reported as ' +
        'missing and excluded (its flat fallback is not a real model color). Reads the textures ' +
        'map only, no geometry.',
      inputSchema: {
        docId: docIdParam,
        maxColors: z
          .number()
          .int()
          .optional()
          .describe('Max colors in the combined (and per-texture) palette, 1–256, by coverage. Default 16.'),
        exact: z
          .boolean()
          .optional()
          .describe(
            'true: return exact 8-bit RGB colors ranked by coverage (best for flat textures); ' +
              'default false uses median-cut representatives (best for dithered vanilla textures).',
          ),
        alphaThreshold: z
          .number()
          .int()
          .optional()
          .describe(
            'Minimum pixel alpha (0–255) to count a texel; below it is treated as transparent ' +
              'background. Default 13 (the engine alpha cutout).',
          ),
        perTexture: z
          .boolean()
          .optional()
          .describe('true: also return a per-texture-key breakdown (default false).'),
        texturesRoot: z
          .string()
          .optional()
          .describe('Extra directory to resolve texture PNGs (mod assets); game assets always fall back.'),
      },
    },
    guard(({ docId, maxColors, exact, alphaThreshold, perTexture, texturesRoot }) => {
      const m = session.get(docId);
      const result = extractPalette(m.doc, {
        ...(maxColors !== undefined ? { maxColors } : {}),
        ...(exact !== undefined ? { exact } : {}),
        ...(alphaThreshold !== undefined ? { alphaThreshold } : {}),
        ...(perTexture !== undefined ? { perTexture } : {}),
        ...(texturesRoot !== undefined ? { texturesRoot } : {}),
      });
      const note =
        result.resolvedTextures.length === 0
          ? (Object.keys(m.doc.root.textures ?? {}).length === 0
              ? 'this shape declares no textures — nothing to sample'
              : `no texture PNG resolved (missing: ${result.missingTextures.map((k) => `'#${k}'`).join(', ')}). ` +
                (corpusAvailable()
                  ? 'Check the textures map paths (shape_describe), or pass texturesRoot for mod assets.'
                  : 'No game install was found: start the server with --game-path to resolve vanilla textures.'))
          : result.missingTextures.length > 0
            ? `skipped unresolved texture${result.missingTextures.length > 1 ? 's' : ''}: ` +
              result.missingTextures.map((k) => `'#${k}'`).join(', ')
            : undefined;
      return jsonResult({ docId: m.id, ...result, ...(note !== undefined ? { note } : {}) });
    }),
  );

  // =====================================================================================
  // Validation
  // =====================================================================================

  server.registerTool(
    'validate_run',
    {
      description:
        "Run the validation suite. 'fast' (default) = static checks (geometry, names, UVs, " +
        "texture refs, animation integrity); 'full' adds pose-evaluation checks (Repeat-loop " +
        'wrap snaps, and foot slide when footElements is given). Every finding has a stable code ' +
        'and a feasible fix.',
      inputSchema: {
        docId: docIdParam,
        level: z.enum(['fast', 'full']).optional().describe("Check depth (default 'fast')."),
        footElements: z
          .array(z.string())
          .optional()
          .describe(
            "Foot element names for the foot-slide check ('full' only); applied to locomotion-named " +
              'animations (walk/run/trot/sprint/move).',
          ),
      },
    },
    guard(({ docId, level, footElements }) => {
      const m = session.get(docId);
      const findings = validateDocument(m.doc, {
        level: level ?? 'fast',
        ...(footElements !== undefined ? { footElements } : {}),
      });
      return jsonResult({
        level: level ?? 'fast',
        counts: {
          errors: findings.filter((f) => f.severity === 'error').length,
          warnings: findings.filter((f) => f.severity === 'warn').length,
          notes: findings.filter((f) => f.severity === 'note').length,
        },
        findings,
      });
    }),
  );

  // =====================================================================================
  // Corpus
  // =====================================================================================

  server.registerTool(
    'corpus_search',
    {
      description:
        'Search the vanilla shape corpus (6k+ shapes in the game install) by keywords, e.g. ' +
        "'fox' or 'chair oak'. Returned paths open via shape_open with the 'corpus:' prefix. " +
        'Needs a game install (--game-path).',
      inputSchema: {
        query: z.string().describe("Keywords matched against path segments, e.g. 'wolf pup' or 'door'."),
      },
    },
    guard(({ query }) => {
      const hits = getCorpus('corpus_search').search(query);
      return jsonResult({
        query,
        total: hits.length,
        hits: hits.slice(0, 40).map((h) => ({
          path: h.path,
          domain: h.domain,
          openAs: `corpus:${h.domain}:${h.path}`,
        })),
        ...(hits.length > 40 ? { note: 'showing the top 40; refine the query for more specific hits' } : {}),
      });
    }),
  );

  server.registerTool(
    'corpus_describe',
    {
      description:
        'Quick structural stats for a corpus shape WITHOUT opening it: element count/depth, ' +
        'static bounds (1/16-block units, rotations ignored), animations, texture sheet size ' +
        'and texture map. Needs a game install (--game-path).',
      inputSchema: {
        path: z
          .string()
          .describe(
            "Corpus shape path from corpus_search, e.g. 'entity/animal/mammal/fox/fox-male' " +
              "(optionally domain-prefixed: 'survival:entity/...').",
          ),
      },
    },
    guard(({ path }) => jsonResult({ path, ...getCorpus('corpus_describe').stats(path) })),
  );

  // =====================================================================================
  // JSON escape hatch
  // =====================================================================================

  server.registerTool(
    'doc_get_json',
    {
      description:
        'Read any subtree of the live shape document as plain JSON (numbers unwrapped). ' +
        "jsonPointer addresses it RFC-6901 style: '' = whole document, '/elements/0/name', " +
        "'/animations/0/keyframes/2/elements'. Escaping: '~0' = '~', '~1' = '/'. " +
        `Responses are capped at ${DOC_GET_JSON_CHAR_CAP.toLocaleString('en-US')} characters ` +
        '— heavily animated shapes (e.g. the seraph, >1 MB) need a narrower pointer.',
      inputSchema: {
        docId: docIdParam,
        jsonPointer: z
          .string()
          .optional()
          .describe(
            "RFC-6901 JSON pointer into the document (default '' = the whole document; " +
              'beware: the whole document can be huge on animated shapes — prefer a subtree).',
          ),
      },
    },
    guard(({ docId, jsonPointer }) => {
      const m = session.get(docId);
      const ptr = jsonPointer ?? '';
      const target = getAt(m.doc.root as unknown as JsonValue, ptr, 'doc_get_json');
      const plain = toPlain(target);
      const text = JSON.stringify(plain, null, 2);
      if (text !== undefined && text.length > DOC_GET_JSON_CHAR_CAP) {
        throw new Error(describeOversizedJson(ptr, plain, text.length));
      }
      return { content: [{ type: 'text', text: text ?? 'null' }] };
    }),
  );

  server.registerTool(
    'doc_patch_json',
    {
      description:
        'Apply an RFC-6902 JSON Patch (add/remove/replace/move/copy/test) to the live document ' +
        'in ONE transaction: any failing op (including a failed test) rolls the whole patch ' +
        'back. Numbers you supply are wrapped losslessly; the response runs FULL validation. ' +
        'Prefer the typed tools — this is the escape hatch for fields they do not cover.',
      inputSchema: {
        docId: docIdParam,
        patch: z
          .array(
            z.object({
              op: z
                .enum(['add', 'remove', 'replace', 'move', 'copy', 'test'])
                .describe('RFC-6902 operation.'),
              path: z
                .string()
                .describe(
                  "Target JSON pointer, e.g. '/elements/0/from/1'. For 'add' into an array, an index " +
                    "0..length inserts and '-' appends. The document root '' cannot be replaced.",
                ),
              value: z
                .any()
                .optional()
                .describe('Plain-JSON value for add/replace/test.'),
              from: z.string().optional().describe("Source JSON pointer for move/copy."),
            }),
          )
          .min(1)
          .describe('Operations applied in order, atomically (all or nothing).'),
      },
    },
    guard(({ docId, patch }) =>
      mutate(
        docId,
        `doc_patch_json (${patch.length} op${patch.length === 1 ? '' : 's'})`,
        (m) => {
          applyPatch(m.doc.root as unknown as JsonValue, patch as PatchOpInput[]);
          // Re-assert the parse-time structural invariants: a wrong-level patch (e.g.
          // replacing /elements with a string) must roll back here instead of committing
          // a document other tools cannot traverse. The validator also reports these as
          // shape/malformed-tree, but rolling back is strictly safer for the live doc.
          for (const key of ['elements', 'animations'] as const) {
            const v: unknown = (m.doc.root as unknown as Record<string, unknown>)[key];
            if (v !== undefined && !Array.isArray(v)) {
              throw new Error(
                `doc_patch_json: the patch left "${key}" as a ${v === null ? 'null' : typeof v} ` +
                  `but it must be an array — the engine cannot load such a document. ` +
                  `The whole patch was rolled back (no changes applied).`,
              );
            }
          }
          try {
            m.doc.walk(() => {});
          } catch (e) {
            throw new Error(
              `doc_patch_json: the patch corrupted the element tree ` +
                `(${e instanceof Error ? e.message : String(e)}). ` +
                `The whole patch was rolled back (no changes applied).`,
            );
          }
          return { opsApplied: patch.length };
        },
        'full',
      ),
    ),
  );

  server.registerTool(
    'doc_script',
    {
      description:
        'Run a PROCEDURAL SCRIPT that mutates the document — the tool for generating geometry/' +
        'animation in loops (spiral stairs, fans of spikes, fractal limbs, a keyframe sweep) ' +
        'instead of one tool call per element. The whole script runs in ONE transaction (a ' +
        'single undo step); an uncaught error rolls every change back, and FULL validation runs ' +
        'after. The language is a SANDBOXED JavaScript subset (no require/process/fs/network/' +
        'eval/new/classes/async/regex) — let/const, if/for/while/for-of/switch, functions + ' +
        'arrows + closures, destructuring, try/catch, and the methods/Math below.\n' +
        'API (units: 1/16 block, degrees; Vec3 = [x,y,z]):\n' +
        '• geometry: addElement({name,parent?,from,to,rotationOrigin?,rotation?:{x,y,z},faces?})→name, ' +
        'editElement(name,{from?,to?,rotationX?…,scaleX?…})→name, renameElement(old,new), ' +
        'reparentElement(name,newParent|null,{preserveWorld?}?), mirrorElement(name,"x"|"z",{about?,newName?}?), ' +
        'scaleElement(name|null,factor,anchor?), duplicateElement(name,newName?), deleteElement(name,{force?}?)\n' +
        '• queries: getElement(name), elementNames(), count(), walk((node,path)=>…), bounds({anim?,frame?}?), ' +
        'listAnimations(), getAnimation(code)\n' +
        '• uv: setFaceUv(el,face,[u1,v1,u2,v2],rot?), faceSet({elements,faces?,subtree?,texture?,glow?,enabled?})→n, ' +
        'autoUv(elements?)→n, uvReport(opts?)\n' +
        '• animation: createAnimation({code,quantityFrames,…})→code, deleteAnimation(code), editAnimationMeta(code,patch), ' +
        'setKeyframe(code,frame,el,{offset?,rotation?,stretch?}), deleteKeyframe(code,frame,el?), ' +
        'adjustChannel(code,opts), retimeAnimation(code,qf), mirrorPhase(code,pairs,{axis?}?)\n' +
        '• raw JSON: getJson(pointer?), patchJson([RFC-6902 ops])\n' +
        '• helpers: log(…), args (your input), random()/randInt(min,max) (seeded), vec3.add/sub/scale, Math, JSON, Object\n' +
        "Errors carry the script line:col. Return a value to surface it (e.g. return elementNames()).",
      inputSchema: {
        docId: docIdParam,
        script: z
          .string()
          .describe(
            'The procedural script source (sandboxed JS subset). Mutating calls run against the ' +
              'open document; the API is listed in this tool’s description.',
          ),
        args: z
          .any()
          .optional()
          .describe('Any JSON value, exposed to the script as the global `args` (parametrize without string-building).'),
        seed: z
          .number()
          .int()
          .optional()
          .describe('Seed for the script’s random()/randInt() so runs are reproducible (default 0).'),
      },
    },
    guard(({ docId, script, args, seed }) =>
      mutate(
        docId,
        'doc_script',
        (m) => {
          const result = runDocScript(m.doc, script, {
            ...(args !== undefined ? { args } : {}),
            ...(seed !== undefined ? { seed } : {}),
          });
          // Keep the response agent-sized: a script that returns the whole tree would blow up
          // context — replace an oversized return value with a pointer to read it deliberately.
          const returnedText = JSON.stringify(result.returned);
          const returned =
            returnedText !== undefined && returnedText.length > DOC_GET_JSON_CHAR_CAP
              ? `<return value omitted: ${returnedText.length.toLocaleString('en-US')} chars — ` +
                `have the script log() summaries or return less>`
              : result.returned;
          return { ...result, returned };
        },
        'full',
      ),
    ),
  );

  return server;
}
