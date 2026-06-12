/**
 * A sandboxed interpreter for a subset of JavaScript, used by the `doc_script` tool to run
 * procedural shape-mutation scripts authored by a client LLM (ARCHITECTURE.md §script).
 *
 * ## Safety model — safe by construction, not by escaping
 *
 * The script is parsed with acorn and evaluated by walking an AST WHITELIST. There is no
 * `eval`, no `Function`, no `require`/`import`, no `process`/`globalThis` — none of those
 * identifiers exist in the script's scope, so they resolve to a "not defined" error. The
 * only things a script can reach are the globals injected by the caller (the document API,
 * a seeded RNG, `log`, `args`) plus a curated pure-JS stdlib ({@link safeStdlib}: Math
 * without `random`, JSON, Object/Array/Number helpers, the numeric/string conversions).
 *
 * The classic prototype-pollution / Function-constructor escapes are closed explicitly:
 * - member access to `__proto__`, `constructor`, or `prototype` (static OR computed) is
 *   rejected, so `({}).constructor.constructor("return process")()` cannot be expressed;
 * - methods on function values are forbidden (no `.call`/`.apply`/`.bind`/`.constructor`);
 * - `new` is not supported at all (no `new Function`);
 * - methods on plain arrays/strings/numbers are dispatched through a NAME whitelist — the
 *   real (safe) method is invoked, but only for vetted names.
 *
 * ## Resource budgets
 *
 * A step counter caps total evaluated nodes (kills infinite loops); a call-depth counter
 * caps recursion (host stack protection). Both raise a {@link FatalError} that script
 * `try/catch` cannot swallow. The source length is capped before parsing.
 *
 * ## What is supported
 *
 * let/const/var, arithmetic/logic/comparison/ternary, template strings, if / for / while /
 * do-while / for-of (over arrays & strings) / switch, break/continue/return, try/catch/
 * finally, throw, functions + arrow functions + closures (default & rest params),
 * array/object destructuring, spread in arrays/calls/objects, the whitelisted array/string/
 * number methods, and the {@link safeStdlib} namespaces. NOT supported (clear errors):
 * `new`, classes, generators, async/await, regex literals, for-in, labels, `with`.
 */

import { parse } from 'acorn';

/* eslint-disable @typescript-eslint/no-explicit-any -- an AST interpreter is inherently dynamic */
type AstNode = any;

/** A surfaced script error (parse or runtime); carries a source location when known. */
export class ScriptError extends Error {
  readonly loc?: { line: number; column: number };
  /** The message without the appended source location (what script `catch` should see). */
  readonly baseMessage: string;
  constructor(message: string, loc?: { line: number; column: number }) {
    super(loc ? `${message} (at line ${loc.line}:${loc.column})` : message);
    this.name = 'ScriptError';
    this.baseMessage = message;
    if (loc) this.loc = loc;
  }
}

/** A budget/recursion abort — deliberately NOT catchable by a script's try/catch. */
class FatalError extends Error {}

// Internal control-flow signals (never escape runScript).
class ReturnSignal {
  constructor(readonly value: unknown) {}
}
class BreakSignal {}
class ContinueSignal {}
/** A value thrown by a script `throw` (catchable by script try/catch). */
class ScriptThrow {
  constructor(readonly value: unknown) {}
}

export interface ScriptLimits {
  /** Max evaluated AST nodes before aborting (infinite-loop guard). Default 2,000,000. */
  maxSteps?: number;
  /** Max nested user-function call depth (host-stack guard). Default 400. */
  maxDepth?: number;
  /** Max source length in characters. Default 200,000. */
  maxSourceLength?: number;
}

interface Ctx {
  steps: number;
  maxSteps: number;
  depth: number;
  maxDepth: number;
}

const DEFAULTS = { maxSteps: 2_000_000, maxDepth: 400, maxSourceLength: 200_000 };

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const ARRAY_METHODS = new Set([
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'indexOf',
  'lastIndexOf', 'includes', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some',
  'every', 'map', 'filter', 'forEach', 'reduce', 'reduceRight', 'sort', 'reverse', 'flat',
  'flatMap', 'fill', 'at',
]);
const STRING_METHODS = new Set([
  'slice', 'substring', 'substr', 'toUpperCase', 'toLowerCase', 'split', 'replace',
  'replaceAll', 'trim', 'trimStart', 'trimEnd', 'padStart', 'padEnd', 'repeat', 'includes',
  'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'charAt', 'charCodeAt', 'codePointAt',
  'concat', 'at', 'normalize',
]);
const NUMBER_METHODS = new Set(['toFixed', 'toString', 'toPrecision', 'toExponential']);

/** Host namespaces (Math/JSON/…) — frozen objects whose props/methods are safe to expose. */
const HOST_NAMESPACES = new WeakSet<object>();

/**
 * The pure-JS standard library exposed to every script. No `random` (the caller injects a
 * seeded RNG for determinism), no Date, no I/O. Every namespace object is frozen and
 * tracked in {@link HOST_NAMESPACES} so the interpreter knows its members are safe.
 */
export function safeStdlib(): Record<string, unknown> {
  const ns = <T extends object>(o: T): T => {
    Object.freeze(o);
    HOST_NAMESPACES.add(o);
    return o;
  };
  const MathNs = ns({
    PI: Math.PI, E: Math.E, LN2: Math.LN2, LN10: Math.LN10, SQRT2: Math.SQRT2,
    abs: Math.abs, sign: Math.sign, round: Math.round, floor: Math.floor, ceil: Math.ceil,
    trunc: Math.trunc, sqrt: Math.sqrt, cbrt: Math.cbrt, pow: Math.pow, exp: Math.exp,
    log: Math.log, log2: Math.log2, log10: Math.log10, sin: Math.sin, cos: Math.cos,
    tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, hypot: Math.hypot, min: Math.min,
    max: Math.max,
  });
  const JsonNs = ns({
    stringify: (v: unknown, replacer?: unknown, space?: unknown) =>
      JSON.stringify(v, replacer as never, space as never),
    parse: (s: unknown) => JSON.parse(String(s)),
  });
  const ObjectNs = ns({
    keys: (o: object) => Object.keys(o ?? {}),
    values: (o: object) => Object.values(o ?? {}),
    entries: (o: object) => Object.entries(o ?? {}),
    assign: (t: object, ...s: object[]) => Object.assign(t, ...s),
    freeze: (o: object) => Object.freeze(o),
    fromEntries: (e: Iterable<[string, unknown]>) => Object.fromEntries(e),
  });
  const ArrayNs = ns({
    isArray: (v: unknown) => Array.isArray(v),
    from: (it: unknown, mapFn?: (v: unknown, i: number) => unknown) =>
      Array.from(it as Iterable<unknown>, mapFn as never),
    of: (...v: unknown[]) => v,
  });
  // Number/String are callable host namespaces: invoke as a conversion (Number(x)) and
  // read statics off them (Number.isInteger) — getProp consults HOST_NAMESPACES first.
  const NumberNs = ns(Object.assign((v: unknown) => Number(v), {
    isInteger: Number.isInteger, isFinite: Number.isFinite, isNaN: Number.isNaN,
    parseFloat: Number.parseFloat, parseInt: Number.parseInt,
    MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER, MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
    EPSILON: Number.EPSILON, MAX_VALUE: Number.MAX_VALUE,
  }));
  const StringNs = ns(Object.assign((v: unknown) => String(v), {
    fromCharCode: String.fromCharCode, fromCodePoint: String.fromCodePoint,
  }));
  return {
    Math: MathNs, JSON: JsonNs, Object: ObjectNs, Array: ArrayNs,
    Number: NumberNs, String: StringNs,
    parseInt: (s: unknown, r?: unknown) => parseInt(String(s), r as number),
    parseFloat: (s: unknown) => parseFloat(String(s)),
    isNaN: (v: unknown) => Number.isNaN(Number(v)),
    isFinite: (v: unknown) => Number.isFinite(Number(v)),
    Boolean: (v: unknown) => Boolean(v),
    NaN, Infinity, undefined,
  };
}

// --- scope -----------------------------------------------------------------------------

interface Binding {
  value: unknown;
  isConst: boolean;
}

class Scope {
  private readonly vars = new Map<string, Binding>();
  constructor(readonly parent: Scope | null) {}

  declare(name: string, value: unknown, isConst: boolean): void {
    this.vars.set(name, { value, isConst });
  }

  private find(name: string): Binding | undefined {
    for (let s: Scope | null = this; s !== null; s = s.parent) {
      const b = s.vars.get(name);
      if (b !== undefined) return b;
    }
    return undefined;
  }

  get(name: string): unknown {
    const b = this.find(name);
    if (b === undefined) throw new ScriptError(`'${name}' is not defined`);
    return b.value;
  }

  has(name: string): boolean {
    return this.find(name) !== undefined;
  }

  set(name: string, value: unknown): void {
    const b = this.find(name);
    if (b === undefined) throw new ScriptError(`'${name}' is not defined (declare it with let/const first)`);
    if (b.isConst) throw new ScriptError(`cannot reassign the constant '${name}'`);
    b.value = value;
  }
}

// --- helpers ---------------------------------------------------------------------------

const locOf = (node: AstNode): { line: number; column: number } | undefined =>
  node?.loc?.start ? { line: node.loc.start.line, column: node.loc.start.column + 1 } : undefined;

function guardKey(key: PropertyKey, loc?: { line: number; column: number }): string | number {
  const k = typeof key === 'number' ? key : String(key);
  if (typeof k === 'string' && FORBIDDEN_KEYS.has(k)) {
    throw new ScriptError(`access to '${k}' is not allowed`, loc);
  }
  return k;
}

const isPlainFunction = (v: unknown): v is (...a: unknown[]) => unknown => typeof v === 'function';

function preview(v: unknown): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

// --- interpreter -----------------------------------------------------------------------

/**
 * Parse and run `source` with `providedGlobals` merged over {@link safeStdlib}. Returns the
 * script's top-level `return` value (or undefined). Throws {@link ScriptError} for syntax,
 * reference, and uncaught errors (with a source location), or a budget/recursion abort.
 */
export function runScript(
  source: string,
  providedGlobals: Record<string, unknown> = {},
  limits: ScriptLimits = {},
): unknown {
  const maxSourceLength = limits.maxSourceLength ?? DEFAULTS.maxSourceLength;
  if (source.length > maxSourceLength) {
    throw new ScriptError(
      `script is ${source.length} characters, over the ${maxSourceLength}-character limit`,
    );
  }
  let program: AstNode;
  try {
    program = parse(source, { ecmaVersion: 2022, locations: true, allowReturnOutsideFunction: true });
  } catch (e: AstNode) {
    const loc = e?.loc ? { line: e.loc.line, column: e.loc.column + 1 } : undefined;
    const msg = String(e?.message ?? e).replace(/\s*\(\d+:\d+\)\s*$/, '');
    throw new ScriptError(`syntax error: ${msg}`, loc);
  }

  const ctx: Ctx = {
    steps: 0,
    maxSteps: limits.maxSteps ?? DEFAULTS.maxSteps,
    depth: 0,
    maxDepth: limits.maxDepth ?? DEFAULTS.maxDepth,
  };
  const global = new Scope(null);
  for (const [k, v] of Object.entries(safeStdlib())) global.declare(k, v, true);
  for (const [k, v] of Object.entries(providedGlobals)) global.declare(k, v, true);

  try {
    hoist(program.body, global, ctx);
    for (const stmt of program.body) execStmt(stmt, global, ctx);
  } catch (e) {
    if (e instanceof ReturnSignal) return e.value;
    if (e instanceof ScriptThrow) throw new ScriptError(`uncaught: ${preview(e.value)}`);
    if (e instanceof FatalError || e instanceof ScriptError) throw e;
    if (e instanceof BreakSignal || e instanceof ContinueSignal) {
      throw new ScriptError('illegal break/continue outside a loop');
    }
    throw e; // host op Error — surfaced verbatim by the caller's guard
  }
  return undefined;
}

function step(ctx: Ctx, loc?: { line: number; column: number }): void {
  if (++ctx.steps > ctx.maxSteps) {
    throw new FatalError(
      `script exceeded the ${ctx.maxSteps.toLocaleString('en-US')}-step budget` +
        (loc ? ` (around line ${loc.line})` : '') +
        ' — likely an unbounded loop or runaway recursion',
    );
  }
}

/** Hoist function declarations into `scope` (so they can be called before their text). */
function hoist(body: AstNode[], scope: Scope, ctx: Ctx): void {
  for (const node of body) {
    if (node.type === 'FunctionDeclaration' && node.id) {
      scope.declare(node.id.name, makeFunction(node, scope, ctx), false);
    }
  }
}

function execBlock(body: AstNode[], scope: Scope, ctx: Ctx): void {
  hoist(body, scope, ctx);
  for (const stmt of body) execStmt(stmt, scope, ctx);
}

function execStmt(node: AstNode, scope: Scope, ctx: Ctx): void {
  step(ctx, locOf(node));
  switch (node.type) {
    case 'EmptyStatement':
      return;
    case 'ExpressionStatement':
      evalExpr(node.expression, scope, ctx);
      return;
    case 'BlockStatement':
      execBlock(node.body, new Scope(scope), ctx);
      return;
    case 'VariableDeclaration': {
      const isConst = node.kind === 'const';
      for (const d of node.declarations) {
        const value = d.init === null ? undefined : evalExpr(d.init, scope, ctx);
        bindPattern(d.id, value, scope, ctx, isConst);
      }
      return;
    }
    case 'FunctionDeclaration':
      return; // already hoisted
    case 'IfStatement':
      if (truthy(evalExpr(node.test, scope, ctx))) execStmt(node.consequent, scope, ctx);
      else if (node.alternate) execStmt(node.alternate, scope, ctx);
      return;
    case 'ForStatement':
      return execFor(node, scope, ctx);
    case 'ForOfStatement':
      return execForOf(node, scope, ctx);
    case 'ForInStatement':
      throw new ScriptError('for-in is not supported; use for-of over Object.keys(obj)', locOf(node));
    case 'WhileStatement':
      while (truthy(evalExpr(node.test, scope, ctx))) {
        if (runLoopBody(node.body, new Scope(scope), ctx)) break;
      }
      return;
    case 'DoWhileStatement':
      do {
        if (runLoopBody(node.body, new Scope(scope), ctx)) break;
      } while (truthy(evalExpr(node.test, scope, ctx)));
      return;
    case 'SwitchStatement':
      return execSwitch(node, scope, ctx);
    case 'ReturnStatement':
      throw new ReturnSignal(node.argument === null ? undefined : evalExpr(node.argument, scope, ctx));
    case 'BreakStatement':
      if (node.label) throw new ScriptError('labeled break is not supported', locOf(node));
      throw new BreakSignal();
    case 'ContinueStatement':
      if (node.label) throw new ScriptError('labeled continue is not supported', locOf(node));
      throw new ContinueSignal();
    case 'ThrowStatement':
      throw new ScriptThrow(evalExpr(node.argument, scope, ctx));
    case 'TryStatement':
      return execTry(node, scope, ctx);
    default:
      throw new ScriptError(`unsupported statement: ${node.type}`, locOf(node));
  }
}

/** Runs a loop body; returns true if a `break` requested loop exit. */
function runLoopBody(body: AstNode, scope: Scope, ctx: Ctx): boolean {
  try {
    execStmt(body, scope, ctx);
  } catch (e) {
    if (e instanceof BreakSignal) return true;
    if (e instanceof ContinueSignal) return false;
    throw e;
  }
  return false;
}

function execFor(node: AstNode, scope: Scope, ctx: Ctx): void {
  const forScope = new Scope(scope);
  if (node.init) {
    if (node.init.type === 'VariableDeclaration') execStmt(node.init, forScope, ctx);
    else evalExpr(node.init, forScope, ctx);
  }
  while (node.test === null || truthy(evalExpr(node.test, forScope, ctx))) {
    step(ctx, locOf(node));
    if (runLoopBody(node.body, new Scope(forScope), ctx)) break;
    if (node.update) evalExpr(node.update, forScope, ctx);
  }
}

function execForOf(node: AstNode, scope: Scope, ctx: Ctx): void {
  const iterable = evalExpr(node.right, scope, ctx);
  let items: unknown[];
  if (Array.isArray(iterable)) items = iterable;
  else if (typeof iterable === 'string') items = [...iterable];
  else {
    throw new ScriptError(
      `for-of expects an array or string, got ${describeType(iterable)}`,
      locOf(node.right),
    );
  }
  for (const item of items) {
    step(ctx, locOf(node));
    const iterScope = new Scope(scope);
    if (node.left.type === 'VariableDeclaration') {
      bindPattern(node.left.declarations[0].id, item, iterScope, ctx, node.left.kind === 'const');
    } else {
      assignTo(node.left, item, iterScope, ctx);
    }
    if (runLoopBody(node.body, iterScope, ctx)) break;
  }
}

function execSwitch(node: AstNode, scope: Scope, ctx: Ctx): void {
  const disc = evalExpr(node.discriminant, scope, ctx);
  const swScope = new Scope(scope);
  let matched = false;
  try {
    for (const c of node.cases) {
      if (!matched && c.test !== null && strictEq(disc, evalExpr(c.test, swScope, ctx))) matched = true;
      if (matched) for (const s of c.consequent) execStmt(s, swScope, ctx);
    }
    if (!matched) {
      // No case matched: run the default clause (and everything after it) if present.
      let inDefault = false;
      for (const c of node.cases) {
        if (c.test === null) inDefault = true;
        if (inDefault) for (const s of c.consequent) execStmt(s, swScope, ctx);
      }
    }
  } catch (e) {
    if (e instanceof BreakSignal) return;
    throw e;
  }
}

function execTry(node: AstNode, scope: Scope, ctx: Ctx): void {
  try {
    execBlock(node.block.body, new Scope(scope), ctx);
  } catch (e) {
    if (e instanceof FatalError || e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal) {
      throw e; // control flow + budget aborts are never catchable by script code
    }
    if (node.handler) {
      const caught =
        e instanceof ScriptThrow
          ? e.value
          : Object.freeze({
              message: e instanceof ScriptError ? e.baseMessage : e instanceof Error ? e.message : String(e),
            });
      const catchScope = new Scope(scope);
      if (node.handler.param) bindPattern(node.handler.param, caught, catchScope, ctx, false);
      execBlock(node.handler.body.body, catchScope, ctx);
    } else if (!node.finalizer) {
      throw e;
    } else {
      execStmt(node.finalizer, new Scope(scope), ctx);
      throw e;
    }
  }
  if (node.finalizer) execStmt(node.finalizer, new Scope(scope), ctx);
}

// --- expressions -----------------------------------------------------------------------

function evalExpr(node: AstNode, scope: Scope, ctx: Ctx): unknown {
  step(ctx, locOf(node));
  switch (node.type) {
    case 'Literal':
      if (node.regex) throw new ScriptError('regular expressions are not supported', locOf(node));
      return node.value;
    case 'Identifier':
      return scope.get(node.name);
    case 'TemplateLiteral': {
      let out = '';
      node.quasis.forEach((q: AstNode, i: number) => {
        out += q.value.cooked;
        if (i < node.expressions.length) out += stringify(evalExpr(node.expressions[i], scope, ctx));
      });
      return out;
    }
    case 'ArrayExpression': {
      const arr: unknown[] = [];
      for (const el of node.elements) {
        if (el === null) arr.length++;
        else if (el.type === 'SpreadElement') arr.push(...spread(evalExpr(el.argument, scope, ctx), locOf(el)));
        else arr.push(evalExpr(el, scope, ctx));
      }
      return arr;
    }
    case 'ObjectExpression': {
      const obj: Record<string, unknown> = {};
      for (const p of node.properties) {
        if (p.type === 'SpreadElement') {
          const src = evalExpr(p.argument, scope, ctx);
          if (src && typeof src === 'object') for (const [k, v] of Object.entries(src)) obj[guardKey(k) as string] = v;
          continue;
        }
        const key = p.computed ? guardKey(stringify(evalExpr(p.key, scope, ctx)), locOf(p)) : guardKey(p.key.name ?? p.key.value, locOf(p));
        obj[key as string] = evalExpr(p.value, scope, ctx);
      }
      return obj;
    }
    case 'UnaryExpression':
      return evalUnary(node, scope, ctx);
    case 'UpdateExpression':
      return evalUpdate(node, scope, ctx);
    case 'BinaryExpression':
      return evalBinary(node.operator, evalExpr(node.left, scope, ctx), evalExpr(node.right, scope, ctx), locOf(node));
    case 'LogicalExpression':
      return evalLogical(node, scope, ctx);
    case 'ConditionalExpression':
      return truthy(evalExpr(node.test, scope, ctx))
        ? evalExpr(node.consequent, scope, ctx)
        : evalExpr(node.alternate, scope, ctx);
    case 'AssignmentExpression':
      return evalAssignment(node, scope, ctx);
    case 'MemberExpression':
      return readMember(node, scope, ctx);
    case 'CallExpression':
      return evalCall(node, scope, ctx);
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return makeFunction(node, scope, ctx);
    case 'SequenceExpression': {
      let v: unknown;
      for (const e of node.expressions) v = evalExpr(e, scope, ctx);
      return v;
    }
    case 'NewExpression':
      throw new ScriptError("'new' is not supported (no constructors in the sandbox)", locOf(node));
    case 'ThisExpression':
      return undefined;
    default:
      throw new ScriptError(`unsupported expression: ${node.type}`, locOf(node));
  }
}

function evalUnary(node: AstNode, scope: Scope, ctx: Ctx): unknown {
  if (node.operator === 'typeof' && node.argument.type === 'Identifier' && !scope.has(node.argument.name)) {
    return 'undefined';
  }
  if (node.operator === 'delete') {
    if (node.argument.type !== 'MemberExpression') return true;
    const obj = evalExpr(node.argument.object, scope, ctx);
    const key = memberKey(node.argument, scope, ctx);
    if (obj && typeof obj === 'object') delete (obj as Record<string, unknown>)[key as string];
    return true;
  }
  const v = evalExpr(node.argument, scope, ctx);
  switch (node.operator) {
    case '-': return -(v as number);
    case '+': return +(v as number);
    case '!': return !truthy(v);
    case '~': return ~(v as number);
    case 'typeof': return typeof v;
    case 'void': return undefined;
    default: throw new ScriptError(`unsupported unary operator '${node.operator}'`, locOf(node));
  }
}

function evalUpdate(node: AstNode, scope: Scope, ctx: Ctx): unknown {
  const old = Number(evalExpr(node.argument, scope, ctx));
  const next = node.operator === '++' ? old + 1 : old - 1;
  assignTo(node.argument, next, scope, ctx);
  return node.prefix ? next : old;
}

function evalLogical(node: AstNode, scope: Scope, ctx: Ctx): unknown {
  const left = evalExpr(node.left, scope, ctx);
  switch (node.operator) {
    case '&&': return truthy(left) ? evalExpr(node.right, scope, ctx) : left;
    case '||': return truthy(left) ? left : evalExpr(node.right, scope, ctx);
    case '??': return left === null || left === undefined ? evalExpr(node.right, scope, ctx) : left;
    default: throw new ScriptError(`unsupported logical operator '${node.operator}'`, locOf(node));
  }
}

function evalAssignment(node: AstNode, scope: Scope, ctx: Ctx): unknown {
  if (node.operator === '=') {
    const value = evalExpr(node.right, scope, ctx);
    assignTo(node.left, value, scope, ctx);
    return value;
  }
  const current = evalExpr(node.left, scope, ctx);
  const rhs = evalExpr(node.right, scope, ctx);
  const op = node.operator.slice(0, -1);
  let value: unknown;
  if (op === '&&') value = truthy(current) ? rhs : current;
  else if (op === '||') value = truthy(current) ? current : rhs;
  else if (op === '??') value = current === null || current === undefined ? rhs : current;
  else value = evalBinary(op, current, rhs, locOf(node));
  assignTo(node.left, value, scope, ctx);
  return value;
}

/** Resolve a member expression's key (guarded) without reading the value. */
function memberKey(node: AstNode, scope: Scope, ctx: Ctx): string | number {
  const raw = node.computed ? evalExpr(node.property, scope, ctx) : node.property.name;
  return guardKey(typeof raw === 'number' ? raw : String(raw), locOf(node));
}

function assignTo(target: AstNode, value: unknown, scope: Scope, ctx: Ctx): void {
  if (target.type === 'Identifier') {
    scope.set(target.name, value);
    return;
  }
  if (target.type === 'MemberExpression') {
    const obj = evalExpr(target.object, scope, ctx);
    if (obj === null || obj === undefined) {
      throw new ScriptError(`cannot set a property of ${describeType(obj)}`, locOf(target));
    }
    if (typeof obj === 'function' || HOST_NAMESPACES.has(obj as object) || Object.isFrozen(obj)) {
      throw new ScriptError('cannot assign to a property of a built-in or frozen value', locOf(target));
    }
    const key = memberKey(target, scope, ctx);
    (obj as Record<string | number, unknown>)[key] = value;
    return;
  }
  if (target.type === 'ArrayPattern' || target.type === 'ObjectPattern') {
    bindPattern(target, value, scope, ctx, false, true);
    return;
  }
  throw new ScriptError(`cannot assign to ${target.type}`, locOf(target));
}

function readMember(node: AstNode, scope: Scope, ctx: Ctx): unknown {
  const obj = evalExpr(node.object, scope, ctx);
  const key = memberKey(node, scope, ctx);
  return getProp(obj, key, locOf(node));
}

function getProp(obj: unknown, key: string | number, loc?: { line: number; column: number }): unknown {
  if (obj === null || obj === undefined) {
    throw new ScriptError(`cannot read property '${key}' of ${describeType(obj)}`, loc);
  }
  // Host namespaces (incl. the callable Number/String) expose their members directly.
  if (HOST_NAMESPACES.has(obj as object)) return (obj as Record<string | number, unknown>)[key];
  if (typeof obj === 'function') {
    if (key === 'name' || key === 'length') return (obj as { name?: string; length?: number })[key];
    throw new ScriptError(`accessing '${key}' on a function is not allowed`, loc);
  }
  if (typeof obj === 'string') {
    if (key === 'length') return obj.length;
    if (typeof key === 'number') return obj[key];
    if (STRING_METHODS.has(key)) return boundMethod(obj, key, loc);
    if (/^\d+$/.test(key)) return obj[Number(key)];
    throw new ScriptError(`'${key}' is not an allowed string member`, loc);
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    if (typeof obj === 'number' && NUMBER_METHODS.has(String(key))) return boundMethod(obj, key, loc);
    throw new ScriptError(`'${key}' is not an allowed ${typeof obj} member`, loc);
  }
  if (Array.isArray(obj)) {
    if (key === 'length') return obj.length;
    if (typeof key === 'number') return obj[key];
    if (ARRAY_METHODS.has(key)) return boundMethod(obj, key, loc);
    if (/^\d+$/.test(key)) return obj[Number(key)];
    throw new ScriptError(`'${key}' is not an allowed array member`, loc);
  }
  // plain object: own data only (guardKey already blocked proto keys)
  return (obj as Record<string | number, unknown>)[key];
}

/** A safe wrapper that invokes a vetted built-in method on `obj` with script args. */
function boundMethod(
  obj: unknown,
  key: string | number,
  loc?: { line: number; column: number },
): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => {
    const fn = (obj as Record<string | number, unknown>)[key];
    if (typeof fn !== 'function') throw new ScriptError(`'${String(key)}' is not callable`, loc);
    return (fn as (...a: unknown[]) => unknown).apply(obj, args);
  };
}

function evalCall(node: AstNode, scope: Scope, ctx: Ctx): unknown {
  const args: unknown[] = [];
  for (const a of node.arguments) {
    if (a.type === 'SpreadElement') args.push(...spread(evalExpr(a.argument, scope, ctx), locOf(a)));
    else args.push(evalExpr(a, scope, ctx));
  }
  const loc = locOf(node);

  let fn: unknown;
  if (node.callee.type === 'MemberExpression') {
    const obj = evalExpr(node.callee.object, scope, ctx);
    const key = memberKey(node.callee, scope, ctx);
    fn = getProp(obj, key, loc); // dispatches through the method whitelist / namespace rules
  } else {
    fn = evalExpr(node.callee, scope, ctx);
  }
  if (!isPlainFunction(fn)) {
    throw new ScriptError(`attempted to call a ${describeType(fn)}, which is not a function`, loc);
  }
  try {
    return (fn as (...a: unknown[]) => unknown)(...args);
  } catch (e) {
    // Re-frame host op errors with the call site; pass interpreter signals through untouched.
    if (
      e instanceof ScriptError || e instanceof FatalError || e instanceof ReturnSignal ||
      e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ScriptThrow
    ) {
      throw e;
    }
    throw new ScriptError(e instanceof Error ? e.message : String(e), loc);
  }
}

/** Build a real JS closure from a function/arrow node (so host code can call it directly). */
function makeFunction(node: AstNode, closure: Scope, ctx: Ctx): (...args: unknown[]) => unknown {
  const params: AstNode[] = node.params;
  const body: AstNode = node.body;
  const isArrowExprBody = node.type === 'ArrowFunctionExpression' && body.type !== 'BlockStatement';
  const fn = (...args: unknown[]): unknown => {
    if (++ctx.depth > ctx.maxDepth) {
      ctx.depth--;
      throw new FatalError(`script exceeded the ${ctx.maxDepth} call-depth limit (runaway recursion?)`);
    }
    try {
      const fnScope = new Scope(closure);
      bindParams(params, args, fnScope, ctx);
      if (isArrowExprBody) return evalExpr(body, fnScope, ctx);
      try {
        execBlock(body.body, fnScope, ctx);
      } catch (e) {
        if (e instanceof ReturnSignal) return e.value;
        throw e;
      }
      return undefined;
    } finally {
      ctx.depth--;
    }
  };
  return fn;
}

function bindParams(params: AstNode[], args: unknown[], scope: Scope, ctx: Ctx): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p.type === 'RestElement') {
      bindPattern(p.argument, args.slice(i), scope, ctx, false);
      return;
    }
    bindPattern(p, args[i], scope, ctx, false);
  }
}

/** Bind an identifier/array/object/default/rest pattern to a value, declaring in `scope`. */
function bindPattern(
  pattern: AstNode,
  value: unknown,
  scope: Scope,
  ctx: Ctx,
  isConst: boolean,
  assign = false,
): void {
  switch (pattern.type) {
    case 'Identifier':
      if (assign) scope.set(pattern.name, value);
      else scope.declare(pattern.name, value, isConst);
      return;
    case 'AssignmentPattern':
      bindPattern(pattern.left, value === undefined ? evalExpr(pattern.right, scope, ctx) : value, scope, ctx, isConst, assign);
      return;
    case 'ArrayPattern': {
      const items = Array.isArray(value) ? value : typeof value === 'string' ? [...value] : [];
      if (!Array.isArray(value) && typeof value !== 'string') {
        throw new ScriptError(`cannot destructure ${describeType(value)} as an array`, locOf(pattern));
      }
      pattern.elements.forEach((el: AstNode, i: number) => {
        if (el === null) return;
        if (el.type === 'RestElement') bindPattern(el.argument, items.slice(i), scope, ctx, isConst, assign);
        else bindPattern(el, items[i], scope, ctx, isConst, assign);
      });
      return;
    }
    case 'ObjectPattern': {
      if (value === null || value === undefined) {
        throw new ScriptError(`cannot destructure ${describeType(value)} as an object`, locOf(pattern));
      }
      const used = new Set<string>();
      for (const p of pattern.properties) {
        if (p.type === 'RestElement') {
          const rest: Record<string, unknown> = {};
          if (typeof value === 'object') for (const [k, v] of Object.entries(value)) if (!used.has(k)) rest[k] = v;
          bindPattern(p.argument, rest, scope, ctx, isConst, assign);
          continue;
        }
        const key = p.computed ? guardKey(stringify(evalExpr(p.key, scope, ctx))) : guardKey(p.key.name ?? p.key.value);
        used.add(String(key));
        bindPattern(p.value, getProp(value, key, locOf(p)), scope, ctx, isConst, assign);
      }
      return;
    }
    default:
      throw new ScriptError(`unsupported binding pattern: ${pattern.type}`, locOf(pattern));
  }
}

function spread(value: unknown, loc?: { line: number; column: number }): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [...value];
  throw new ScriptError(`cannot spread ${describeType(value)} (only arrays and strings)`, loc);
}

// --- operators / values ----------------------------------------------------------------

function evalBinary(op: string, l: AstNode, r: AstNode, loc?: { line: number; column: number }): unknown {
  switch (op) {
    case '+': return (l as number) + (r as number);
    case '-': return (l as number) - (r as number);
    case '*': return (l as number) * (r as number);
    case '/': return (l as number) / (r as number);
    case '%': return (l as number) % (r as number);
    case '**': return (l as number) ** (r as number);
    case '==': return l == r; // eslint-disable-line eqeqeq -- JS semantics intended
    case '!=': return l != r; // eslint-disable-line eqeqeq
    case '===': return strictEq(l, r);
    case '!==': return !strictEq(l, r);
    case '<': return (l as number) < (r as number);
    case '<=': return (l as number) <= (r as number);
    case '>': return (l as number) > (r as number);
    case '>=': return (l as number) >= (r as number);
    case '&': return (l as number) & (r as number);
    case '|': return (l as number) | (r as number);
    case '^': return (l as number) ^ (r as number);
    case '<<': return (l as number) << (r as number);
    case '>>': return (l as number) >> (r as number);
    case '>>>': return (l as number) >>> (r as number);
    case 'in': {
      const key = guardKey(l as PropertyKey, loc);
      if (Array.isArray(r)) return Number(key) < r.length && Number(key) >= 0;
      if (r && typeof r === 'object') return Object.prototype.hasOwnProperty.call(r, key);
      throw new ScriptError(`'in' expects an object on the right, got ${describeType(r)}`, loc);
    }
    case 'instanceof':
      throw new ScriptError("'instanceof' is not supported", loc);
    default:
      throw new ScriptError(`unsupported operator '${op}'`, loc);
  }
}

const strictEq = (a: unknown, b: unknown): boolean => a === b;
const truthy = (v: unknown): boolean => Boolean(v);

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v) ?? String(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}
