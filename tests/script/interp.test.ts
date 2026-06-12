/**
 * interp.ts: the sandboxed JS-subset interpreter behind doc_script. Pins (1) language
 * semantics scripts rely on, (2) that the sandbox-escape vectors are blocked, and (3) that
 * the step/recursion budgets fire and are NOT swallowable by script try/catch.
 */
import { describe, expect, it } from 'vitest';

import { runScript, ScriptError } from '../../src/script/interp.js';

/** Run a script, returning its top-level `return` value. */
const run = (src: string, globals: Record<string, unknown> = {}, limits = {}): unknown =>
  runScript(src, globals, limits);

describe('language semantics', () => {
  it('evaluates arithmetic, precedence, and returns a value', () => {
    expect(run('return 1 + 2 * 3 ** 2')).toBe(19);
    expect(run('return (5 % 3) | 8')).toBe(10);
    expect(run('return 7 < 8 && 8 <= 8')).toBe(true);
  });

  it('handles let/const, reassignment, and const protection', () => {
    expect(run('let a = 1; a += 4; a++; return a')).toBe(6);
    expect(() => run('const c = 1; c = 2')).toThrow(/reassign the constant 'c'/);
  });

  it('template literals, arrays, objects, spread, destructuring', () => {
    expect(run('const n = 3; return `n=${n + 1}`')).toBe('n=4');
    expect(run('return [1, ...[2, 3], 4]')).toEqual([1, 2, 3, 4]);
    expect(run('const o = { a: 1, ...{ b: 2 } }; return o')).toEqual({ a: 1, b: 2 });
    expect(run('const [a, , c] = [1, 2, 3]; return a + c')).toBe(4);
    expect(run('const { x, y = 9 } = { x: 1 }; return x + y')).toBe(10);
  });

  it('if / for / while / for-of / switch with break & continue', () => {
    expect(run('let s = 0; for (let i = 0; i < 5; i++) { if (i === 2) continue; s += i; } return s')).toBe(8);
    expect(run('let s = 0; for (const v of [1, 2, 3]) s += v; return s')).toBe(6);
    expect(run('let i = 0; while (true) { i++; if (i >= 4) break; } return i')).toBe(4);
    expect(run('let r = ""; for (const c of "ab") r += c + c; return r')).toBe('aabb');
    expect(run('function f(n){ switch(n){ case 1: return "one"; default: return "other"; } } return f(2)')).toBe('other');
  });

  it('functions, closures, recursion, default & rest params', () => {
    expect(run('function add(a, b = 10) { return a + b; } return add(5)')).toBe(15);
    expect(run('const sum = (...xs) => xs.reduce((a, b) => a + b, 0); return sum(1, 2, 3, 4)')).toBe(10);
    expect(run('function fib(n){ return n < 2 ? n : fib(n-1) + fib(n-2); } return fib(10)')).toBe(55);
    // closure captures its defining scope
    expect(run('function mk(x){ return (y) => x + y; } const add3 = mk(3); return add3(4)')).toBe(7);
  });

  it('whitelisted array & string methods, and Math/JSON/Object', () => {
    expect(run('return [3, 1, 2].sort((a, b) => a - b)')).toEqual([1, 2, 3]);
    expect(run('return [1, 2, 3, 4].filter(x => x % 2 === 0).map(x => x * 10)')).toEqual([20, 40]);
    expect(run('return "a,b,c".split(",").join("-")')).toBe('a-b-c');
    expect(run('return Math.max(1, 9, 4) + Math.floor(2.9)')).toBe(11);
    expect(run('return JSON.parse("[1,2]").length')).toBe(2);
    expect(run('return Object.keys({ a: 1, b: 2 }).length')).toBe(2);
    expect(run('return Number("42") + Number.isInteger(5)')).toBe(43); // true coerces to 1
  });

  it('try/catch/finally and throw', () => {
    expect(run('try { throw "boom"; } catch (e) { return "caught:" + e; }')).toBe('caught:boom');
    expect(run('let f = 0; try { throw 1; } catch (e) { } finally { f = 7; } return f')).toBe(7);
  });

  it('injected host globals are callable and re-frame thrown errors with a location', () => {
    const host = {
      double: (n: number) => n * 2,
      boom: () => {
        throw new Error('host failure');
      },
    };
    expect(run('return double(21)', host)).toBe(42);
    // a host error becomes a ScriptError carrying the call site
    expect(() => run('\nboom()', host)).toThrow(/host failure.*line 2/s);
    // …and is catchable by script try/catch (bound as { message })
    expect(run('try { boom(); } catch (e) { return e.message; }', host)).toBe('host failure');
  });

  it('reports good errors with locations', () => {
    expect(() => run('return missing + 1')).toThrow(ScriptError);
    expect(() => run('return missing + 1')).toThrow(/'missing' is not defined/);
    expect(() => run('return 1 +')).toThrow(/syntax error/);
  });
});

describe('sandbox escapes are blocked', () => {
  const blocked: [string, RegExp][] = [
    ['return ({}).constructor', /'constructor' is not allowed/],
    ['return [].constructor.constructor("return 1")()', /'constructor' is not allowed/],
    ['return (() => {}).constructor', /'constructor' is not allowed/],
    ['const o = {}; return o["__proto__"]', /'__proto__' is not allowed/],
    ['return o.prototype', /'prototype' is not allowed/],
    ['return globalThis', /'globalThis' is not defined/],
    ['return process.exit(1)', /'process' is not defined/],
    ['return require("fs")', /'require' is not defined/],
    ['return new Object()', /'new' is not supported/],
    ['return /a/.test("a")', /regular expressions are not supported/],
    ['for (const k in {}) {}', /for-in is not supported/],
    ['return (5).toString.call(9)', /'call' on a function is not allowed/],
  ];
  it.each(blocked)('blocks: %s', (src, re) => {
    expect(() => run(src, { o: {} })).toThrow(re);
  });

  it('cannot mutate a host namespace or frozen value', () => {
    expect(() => run('Math.PI = 4')).toThrow(/built-in or frozen/);
  });

  it('rejects an oversized script before parsing', () => {
    expect(() => run('//x', {}, { maxSourceLength: 2 })).toThrow(/over the 2-character limit/);
  });
});

describe('resource budgets', () => {
  it('aborts an unbounded loop via the step budget', () => {
    expect(() => run('while (true) {}', {}, { maxSteps: 5000 })).toThrow(/step budget/);
  });

  it('a script try/catch CANNOT swallow a budget abort', () => {
    expect(() => run('try { while (true) {} } catch (e) {}', {}, { maxSteps: 5000 })).toThrow(/step budget/);
  });

  it('aborts runaway recursion via the depth limit', () => {
    expect(() => run('function f(){ return f(); } return f()', {}, { maxDepth: 50, maxSteps: 1e9 })).toThrow(
      /call-depth limit/,
    );
  });
});
