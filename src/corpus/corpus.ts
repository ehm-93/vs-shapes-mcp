/**
 * Vanilla asset corpus access: discovery, search, and quick stats over the Vintage Story
 * game install's shape JSON files, plus texture PNG resolution.
 *
 * ## Shape path convention (agent-facing — the MCP server surfaces this verbatim)
 *
 * Corpus shape paths are RELATIVE paths like `entity/animal/mammal/fox/fox-male`:
 * - no `.json` extension, no `shapes/` prefix (both are stripped if accidentally included),
 * - forward slashes (backslashes are normalized),
 * - optionally prefixed with a domain: `survival:entity/...` or `game:block/...`.
 *
 * Without a domain prefix, lookups search `<game>/assets/survival/shapes/` first, then
 * `<game>/assets/game/shapes/` — matching the engine's vanilla asset origins.
 * Paths are lowercased for resolution (the engine lowercases asset locations).
 *
 * The index is built lazily on first use (single recursive directory pass) and cached for
 * the lifetime of the {@link Corpus} instance. Files that turn out to be unparseable are
 * recorded as warnings ({@link Corpus.warnings}) and excluded from subsequent `search()`
 * results; `initCorpus`/`list()` never throw because of a bad shape file.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Vec3 } from '../vs/types.js';

/** Vanilla asset domains, in lookup-priority order. */
const SHAPE_DOMAINS = ['survival', 'game'] as const;
export type CorpusDomain = (typeof SHAPE_DOMAINS)[number];

export interface CorpusEntry {
  /** Relative corpus path, e.g. `entity/animal/mammal/fox/fox-male` (no `.json`). */
  path: string;
  domain: CorpusDomain;
}

export interface ScoredHit extends CorpusEntry {
  /**
   * Relevance: `matchedTokens * 1000 + matchQuality`. The thousands digit(s) tell you how
   * many query tokens matched; results are sorted by this descending.
   */
  score: number;
}

export interface AnimationStat {
  /** Animation `code`, falling back to `name` when absent (engine behavior). */
  code: string;
  quantityFrames: number;
}

export interface ShapeStats {
  /** Total element count, including all nested children. */
  elements: number;
  /** Maximum element nesting depth (root-level elements = 1). 0 when no elements. */
  depth: number;
  /**
   * Static AABB accumulated from `from`/`to` along parent chains, in 1/16-block shape
   * units. IGNORES rotations (and scale), so rotated parts may extend beyond this box —
   * `rotationsIgnored` is carried in the object as a reminder.
   */
  bounds: { min: Vec3; max: Vec3; units: '1/16 block'; rotationsIgnored: true };
  animations: AnimationStat[];
  /** Defaults to 16 when absent from the file (engine default). */
  textureWidth: number;
  /** Defaults to 16 when absent from the file (engine default). */
  textureHeight: number;
  /** Texture key → asset path, e.g. `skin` → `entity/animal/mammal/fox/red-male`. */
  textures: Record<string, string>;
}

export interface CorpusWarning {
  path: string;
  domain: CorpusDomain;
  message: string;
}

/**
 * Locate the Vintage Story install directory.
 *
 * Candidates are tried in priority order — explicit argument, then the `VINTAGE_STORY`
 * environment variable, then the default `%APPDATA%/Vintagestory` — and the first one
 * containing an `assets` subdirectory wins. If a higher-priority candidate is invalid the
 * chain falls through to the next (so a stale env var does not break a working default
 * install). When none validates, the error names every location tried, why each failed,
 * and how to fix it.
 *
 * On non-Windows systems `%APPDATA%` is approximated as `~/AppData/Roaming`; pass an
 * explicit path or set `VINTAGE_STORY` there.
 */
export function resolveGamePath(explicitPath?: string): string {
  const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
  const candidates: { source: string; dir: string | undefined }[] = [
    { source: 'explicit gamePath argument', dir: explicitPath },
    { source: 'VINTAGE_STORY environment variable', dir: process.env['VINTAGE_STORY'] },
    { source: 'default %APPDATA%/Vintagestory', dir: join(appData, 'Vintagestory') },
  ];

  const failures: string[] = [];
  for (const { source, dir } of candidates) {
    if (dir === undefined || dir === '') {
      failures.push(`  - ${source}: not provided`);
      continue;
    }
    const abs = resolve(dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      failures.push(`  - ${source}: "${abs}" is not an existing directory`);
      continue;
    }
    if (!existsSync(join(abs, 'assets'))) {
      failures.push(`  - ${source}: "${abs}" exists but has no "assets" subdirectory`);
      continue;
    }
    return abs;
  }

  throw new Error(
    `Could not locate a Vintage Story installation. Tried:\n${failures.join('\n')}\n` +
      `Fix: pass the install directory explicitly (--game-path / initCorpus argument) or set ` +
      `the VINTAGE_STORY environment variable to the folder that contains "assets" ` +
      `(e.g. C:\\Users\\you\\AppData\\Roaming\\Vintagestory).`,
  );
}

/**
 * Create a {@link Corpus} over a game install. `gamePath` is optional — when omitted (or
 * invalid) discovery falls back per {@link resolveGamePath}. Throws the resolveGamePath
 * error when no install can be located; never throws because of individual bad shape files.
 */
export function initCorpus(gamePath?: string): Corpus {
  return new Corpus(resolveGamePath(gamePath));
}

export class Corpus {
  /** Lazily built, cached path index (single directory pass over both domains). */
  private index: CorpusEntry[] | null = null;
  /** `${domain}:${path}` keys of files found unparseable; excluded from search results. */
  private readonly broken = new Set<string>();
  private readonly warningList: CorpusWarning[] = [];
  private readonly statsCache = new Map<string, ShapeStats>();

  /** Prefer {@link initCorpus}; the constructor takes an already-validated install dir. */
  constructor(readonly gamePath: string) {}

  /** Warnings collected so far (unreadable directories, unparseable shape files). */
  warnings(): readonly CorpusWarning[] {
    return [...this.warningList];
  }

  /**
   * List indexed shapes, optionally filtered by a glob over the corpus path:
   * `*` matches within a path segment, `**` crosses segments, `?` is one character;
   * matching is case-insensitive. A glob without `/` also matches against just the file
   * basename (`fox-*` finds `entity/animal/mammal/fox/fox-male`). A `survival:`/`game:`
   * prefix restricts the domain. Never throws.
   */
  list(glob?: string): CorpusEntry[] {
    const entries = this.ensureIndex();
    if (glob === undefined || glob.trim() === '') {
      return entries.map(({ path, domain }) => ({ path, domain }));
    }
    let pattern = glob.trim().replaceAll('\\', '/');
    let domainFilter: CorpusDomain | undefined;
    const m = /^([a-z0-9_-]+):(.*)$/i.exec(pattern);
    if (m && isDomain(m[1]!.toLowerCase())) {
      domainFilter = m[1]!.toLowerCase() as CorpusDomain;
      pattern = m[2]!;
    }
    const re = globToRegExp(pattern);
    const baseOnly = !pattern.includes('/');
    return entries
      .filter(
        (e) =>
          (domainFilter === undefined || e.domain === domainFilter) &&
          (re.test(e.path) || (baseOnly && re.test(basenameOf(e.path)))),
      )
      .map(({ path, domain }) => ({ path, domain }));
  }

  /**
   * Token/substring search over path segments. The query is split on non-alphanumerics;
   * each token scores against every path segment (exact segment > exact hyphen-word >
   * prefix > substring, with the file basename weighted double), and entries matching more
   * tokens always rank above entries matching fewer. Returns all hits, best first.
   * Files previously found unparseable are excluded.
   */
  search(query: string): ScoredHit[] {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return [];

    const hits: ScoredHit[] = [];
    for (const entry of this.ensureIndex()) {
      if (this.broken.has(`${entry.domain}:${entry.path}`)) continue;
      const segments = entry.path.split('/');
      let matched = 0;
      let quality = 0;
      for (const token of tokens) {
        let best = 0;
        let matchingSegments = 0;
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i]!;
          let s = 0;
          if (seg === token) s = 10;
          else if (seg.split(/[-_.]/).includes(token)) s = 8;
          else if (seg.startsWith(token)) s = 6;
          else if (seg.includes(token)) s = 4;
          if (s > 0) {
            matchingSegments++;
            const weighted = s * (i === segments.length - 1 ? 2 : 1);
            if (weighted > best) best = weighted;
          }
        }
        if (best > 0) {
          matched++;
          // Small bonus when the token also matches other segments (e.g. both the
          // "fox" directory and the "fox-male" basename) so themed folders rank first.
          quality += best + Math.min(matchingSegments - 1, 3);
        }
      }
      if (matched > 0) {
        hits.push({ path: entry.path, domain: entry.domain, score: matched * 1000 + quality });
      }
    }
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        a.path.length - b.path.length ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        (a.domain === b.domain ? 0 : a.domain === 'survival' ? -1 : 1),
    );
    return hits;
  }

  /**
   * Quick structural stats for one shape. Parses with plain `JSON.parse`; BOM is stripped
   * and, when strict parsing fails, `//`//`/* *​/` comments and trailing commas are stripped
   * and the parse retried. A file that still fails is recorded in {@link warnings}, excluded
   * from future `search()` results, and reported via a descriptive error naming the file.
   * `bounds` ignores rotations — see {@link ShapeStats.bounds}.
   */
  stats(path: string): ShapeStats {
    const loc = this.resolveShapeFile(path);
    const cacheKey = `${loc.domain}:${loc.rel}`;
    const cached = this.statsCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const text = stripBom(readFileSync(loc.abs, 'utf8'));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (strictError) {
      try {
        parsed = JSON.parse(stripTrailingCommas(stripComments(text)));
      } catch {
        const message = `Unparseable JSON even after stripping comments and trailing commas: ${
          strictError instanceof Error ? strictError.message : String(strictError)
        }`;
        this.warningList.push({ path: loc.rel, domain: loc.domain, message });
        this.broken.add(cacheKey);
        throw new Error(
          `Shape "${loc.domain}:${loc.rel}" (${loc.abs}) is not valid JSON: ${message}. ` +
            `It has been excluded from search results. Fix the file or pick another shape via search().`,
        );
      }
    }

    const stats = computeStats(parsed);
    this.statsCache.set(cacheKey, stats);
    return stats;
  }

  /**
   * Raw file text for a corpus shape (for `ShapeDocument.parse`). A leading UTF-8 BOM is
   * stripped; the content is otherwise untouched. Throws a descriptive error (with the
   * absolute locations tried and closest search matches) when the shape does not exist.
   */
  read(path: string): string {
    const loc = this.resolveShapeFile(path);
    return stripBom(readFileSync(loc.abs, 'utf8'));
  }

  /**
   * Resolve a shape-texture asset path (e.g. `entity/animal/mammal/fox/red-male`) to an
   * absolute PNG path, checking `<game>/assets/survival/textures/<p>.png` then
   * `assets/game/textures/<p>.png`. A `survival:`/`game:` prefix restricts the domain
   * (any other `domain:` prefix is tried as `assets/<domain>/textures/` for mod-style
   * refs). A `.png` suffix and `textures/` prefix are tolerated. Returns null if absent.
   */
  resolveTexturePng(texturePath: string): string | null {
    let rel = texturePath.trim().replaceAll('\\', '/');
    let domains: readonly string[] = SHAPE_DOMAINS;
    const m = /^([a-z0-9_-]+):(.*)$/i.exec(rel);
    if (m) {
      domains = [m[1]!.toLowerCase()];
      rel = m[2]!;
    }
    rel = rel
      .replace(/^\/+/, '')
      .replace(/^textures\//i, '')
      .replace(/\.png$/i, '')
      .toLowerCase();
    if (rel === '') return null;
    for (const domain of domains) {
      const abs = join(this.gamePath, 'assets', domain, 'textures', ...rel.split('/')) + '.png';
      if (existsSync(abs)) return abs;
    }
    return null;
  }

  // -------------------------------------------------------------------------

  private ensureIndex(): CorpusEntry[] {
    if (this.index !== null) return this.index;
    const entries: CorpusEntry[] = [];
    let rootsFound = 0;
    for (const domain of SHAPE_DOMAINS) {
      const root = join(this.gamePath, 'assets', domain, 'shapes');
      if (!existsSync(root)) continue;
      rootsFound++;
      let dirents;
      try {
        dirents = readdirSync(root, { recursive: true, withFileTypes: true });
      } catch (e) {
        this.warningList.push({
          path: '',
          domain,
          message: `Failed to read shapes directory "${root}": ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
      for (const d of dirents) {
        if (!d.isFile() || !d.name.toLowerCase().endsWith('.json')) continue;
        // join() normalizes separators, so abs is exactly `${root}${sep}<relative>`.
        const abs = join(d.parentPath, d.name);
        const rel = abs
          .slice(root.length + sep.length)
          .replaceAll('\\', '/')
          .replace(/\.json$/i, '');
        entries.push({ path: rel, domain });
      }
    }
    if (rootsFound === 0) {
      this.warningList.push({
        path: '',
        domain: 'survival',
        message:
          `No shapes directories found under "${join(this.gamePath, 'assets')}" ` +
          `(looked for ${SHAPE_DOMAINS.map((d) => `assets/${d}/shapes`).join(' and ')}).`,
      });
    }
    entries.sort(
      (a, b) =>
        (a.domain === b.domain ? 0 : a.domain === 'survival' ? -1 : 1) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    this.index = entries;
    return entries;
  }

  private resolveShapeFile(ref: string): { abs: string; domain: CorpusDomain; rel: string } {
    const { domain, rel } = parseShapeRef(ref);
    const domains: readonly CorpusDomain[] = domain !== undefined ? [domain] : SHAPE_DOMAINS;
    const tried: string[] = [];
    for (const d of domains) {
      const abs = join(this.gamePath, 'assets', d, 'shapes', ...rel.split('/')) + '.json';
      if (existsSync(abs)) return { abs, domain: d, rel };
      tried.push(abs);
    }
    const base = basenameOf(rel);
    const suggestions = this.search(base.replaceAll(/[-_]/g, ' '))
      .slice(0, 3)
      .map((h) => `${h.domain}:${h.path}`);
    throw new Error(
      `Shape "${ref}" not found in the corpus. Tried:\n  ${tried.join('\n  ')}\n` +
        (suggestions.length > 0 ? `Closest matches: ${suggestions.join(', ')}. ` : '') +
        `Corpus paths are relative, without ".json" or a "shapes/" prefix ` +
        `(e.g. "entity/animal/mammal/fox/fox-male"); use list()/search() to discover them.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDomain(s: string): s is CorpusDomain {
  return (SHAPE_DOMAINS as readonly string[]).includes(s);
}

function basenameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Normalize a user-supplied shape ref into an optional domain + lowercase relative path. */
function parseShapeRef(ref: string): { domain?: CorpusDomain; rel: string } {
  let rel = ref.trim().replaceAll('\\', '/');
  let domain: CorpusDomain | undefined;
  const m = /^([a-z0-9_-]+):(.*)$/i.exec(rel);
  if (m) {
    const d = m[1]!.toLowerCase();
    if (!isDomain(d)) {
      throw new Error(
        `Unknown shape domain "${m[1]}" in "${ref}". Supported domains: ` +
          `${SHAPE_DOMAINS.map((x) => `"${x}"`).join(', ')} — or omit the prefix to search both.`,
      );
    }
    domain = d;
    rel = m[2]!;
  }
  rel = rel
    .replace(/^\/+/, '')
    .replace(/^\.\//, '')
    .replace(/^shapes\//i, '')
    .replace(/\.json$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (rel === '') {
    throw new Error(
      `Empty shape path in "${ref}". Expected a relative path like "entity/animal/mammal/fox/fox-male".`,
    );
  }
  return domain !== undefined ? { domain, rel } : { rel };
}

/** Remove `//` line and `/* *​/` block comments, string-aware. */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1]!;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2; // past '*/' (harmlessly overshoots on an unterminated comment)
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Drop commas directly (modulo whitespace) before `}` or `]`, string-aware. */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') {
        i++;
        out += text[i] ?? '';
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') continue; // trailing comma — drop
    }
    out += c;
  }
  return out;
}

/** Translate the simple glob dialect documented on {@link Corpus.list} to a RegExp. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?'; // '**/' also matches zero directories
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * Case-insensitive key lookup, mirroring Newtonsoft's property binding (the engine's
 * parser). Vanilla 1.22 is uniformly lowercase (`quantityframes`, 6,096/6,096 files) —
 * this guards against modded/hand-written files using the C# casing (`quantityFrames`).
 */
function getCI(obj: Record<string, unknown>, key: string): unknown {
  if (key in obj) return obj[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return obj[k];
  }
  return undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asVec3(v: unknown): Vec3 | undefined {
  if (
    Array.isArray(v) &&
    v.length >= 3 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    typeof v[2] === 'number'
  ) {
    return [v[0], v[1], v[2]];
  }
  return undefined;
}

function computeStats(parsed: unknown): ShapeStats {
  const root = asRecord(parsed) ?? {};

  let elementCount = 0;
  let maxDepth = 0;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let anyBox = false;

  // With rotations ignored, an element's world box corners are cumFrom + from and
  // cumFrom + to (engine local matrix translates by `from/16`, box spans [0, to-from]/16;
  // see GROUND-TRUTH §2). Children accumulate the parent's `from`.
  const walk = (els: unknown, depth: number, cumFrom: Vec3): void => {
    if (!Array.isArray(els)) return;
    for (const raw of els) {
      const el = asRecord(raw);
      if (el === undefined) continue;
      elementCount++;
      if (depth > maxDepth) maxDepth = depth;
      const fromRaw = asVec3(getCI(el, 'from'));
      const from = fromRaw ?? ([0, 0, 0] as Vec3);
      const to = asVec3(getCI(el, 'to'));
      if (fromRaw !== undefined && to !== undefined) {
        anyBox = true;
        for (let a = 0; a < 3; a++) {
          const c1 = cumFrom[a]! + from[a]!;
          const c2 = cumFrom[a]! + to[a]!;
          if (Math.min(c1, c2) < min[a]!) min[a] = Math.min(c1, c2);
          if (Math.max(c1, c2) > max[a]!) max[a] = Math.max(c1, c2);
        }
      }
      walk(getCI(el, 'children'), depth + 1, [
        cumFrom[0]! + from[0]!,
        cumFrom[1]! + from[1]!,
        cumFrom[2]! + from[2]!,
      ]);
    }
  };
  walk(getCI(root, 'elements'), 1, [0, 0, 0]);

  const animations: AnimationStat[] = [];
  const animsRaw = getCI(root, 'animations');
  if (Array.isArray(animsRaw)) {
    for (const raw of animsRaw) {
      const anim = asRecord(raw);
      if (anim === undefined) continue;
      const code = getCI(anim, 'code') ?? getCI(anim, 'name');
      const qf = getCI(anim, 'quantityframes');
      animations.push({
        code: typeof code === 'string' ? code : '(unnamed)',
        quantityFrames: typeof qf === 'number' ? qf : 0,
      });
    }
  }

  const tw = getCI(root, 'textureWidth');
  const th = getCI(root, 'textureHeight');
  const textures: Record<string, string> = {};
  const texturesRaw = asRecord(getCI(root, 'textures'));
  if (texturesRaw !== undefined) {
    for (const [key, value] of Object.entries(texturesRaw)) {
      if (typeof value === 'string') textures[key] = value;
    }
  }

  return {
    elements: elementCount,
    depth: maxDepth,
    bounds: {
      min: anyBox ? min : [0, 0, 0],
      max: anyBox ? max : [0, 0, 0],
      units: '1/16 block',
      rotationsIgnored: true,
    },
    animations,
    textureWidth: typeof tw === 'number' ? tw : 16,
    textureHeight: typeof th === 'number' ? th : 16,
    textures,
  };
}
