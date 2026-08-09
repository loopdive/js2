// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3643 Slice A — array destructuring never performed GetIterator.
//
// ECMA-262 §8.6.2 `BindingPattern : ArrayBindingPattern` runs GetIterator
// (§7.4.2) on the RHS, which throws TypeError for a non-iterable. Measured on
// `origin/main` @ 51c8d8a8 (host lane, `runTest262File`): every array-pattern
// form silently bound `undefined` instead — `var [p] = {a:1}`, `var [p,q] =
// {...}`, `var [...r] = {...}`, `function f([p]){}` called with `{a:1}`, and an
// array-LIKE `{length:2, 0:'x', 1:'y'}` (array-like is NOT iterable).
//
// ROOT CAUSE: array SPREAD already used the strict unbounded drain
// (`__array_from_iter_strict`) and threw correctly — `[...{b:1}]` was a passing
// control before this change. Destructuring used the BOUNDED, NON-strict
// `__array_from_iter_n`, which falls through to the host `Array.from(obj)`
// array-like fallback and answers `[]`. So the strictness machinery existed
// (#1454/#3637); the destructuring arm was simply never wired to it.
//
// The fix adds a bounded strict twin `__array_from_iter_n_strict` rather than a
// flag on `__array_from_iter_n`, because that import is SHARED with
// `__array_from_mapped` (`Array.from(arrayLike, mapFn)`) and `__iterator_rest`,
// both of which must KEEP the array-like fallback. Widening the shared import
// would have broken them.
//
// Every assertion is on an OBSERVABLE value. The three `throws` cases were
// confirmed to bind `undefined` (no throw) on unmodified `origin/main`, and the
// nine control cases were confirmed GREEN on `origin/main` before the change —
// so the controls prove absence of collateral, not merely absence of crashes.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<Record<string, any>> {
  const result: any = await compile(src, { fileName: "probe.mjs" });
  expect(
    result.success,
    `Compile failed:\n${(result.errors ?? []).map((e: any) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

/**
 * Compile `body` into an exported `probe()` that returns 1 when `body` threw a
 * TypeError and 0 when it completed normally. Asserting the observable
 * *behaviour* (threw / did not throw) rather than a host-side exception keeps
 * the check independent of how the error object crosses the boundary.
 */
async function throwsTypeError(body: string): Promise<number> {
  const exports = await run(`
    // @ts-nocheck
    export function probe() {
      try {
        ${body}
      } catch (e) {
        return e instanceof TypeError ? 1 : 2;
      }
      return 0;
    }
  `);
  return exports.probe();
}

describe("#3643 Slice A — array destructuring performs GetIterator", () => {
  // ---- the defect rows: all bound `undefined` (probe → 0) before the fix ----

  it("var [p] = {a:1} throws TypeError", async () => {
    expect(await throwsTypeError("var [p] = { a: 1 }; return p;")).toBe(1);
  });

  it("var [p, q] = {a:1, b:2} throws TypeError", async () => {
    expect(await throwsTypeError("var [p, q] = { a: 1, b: 2 }; return p;")).toBe(1);
  });

  it("a parameter array pattern called with a non-iterable throws TypeError", async () => {
    // The issue recorded this row as TRAPPING ("dereferencing a null pointer")
    // under bare `compile()` + `wrapExports`. Under the authoritative test262
    // harness it silently bound `undefined`, exactly like the `var` form — one
    // defect, not two paths. Either way the spec answer is TypeError.
    const exports = await run(`
      // @ts-nocheck
      function f([p]) { return p; }
      export function probe() {
        try { return f({ a: 1 }) === undefined ? 0 : 3; }
        catch (e) { return e instanceof TypeError ? 1 : 2; }
      }
    `);
    expect(exports.probe()).toBe(1);
  });

  it("var [...r] = {a:1} throws TypeError (rest form)", async () => {
    expect(await throwsTypeError("var [...r] = { a: 1 }; return r;")).toBe(1);
  });

  it("var [p, ...r] = {a:1} throws TypeError (head + rest)", async () => {
    expect(await throwsTypeError("var [p, ...r] = { a: 1 }; return p;")).toBe(1);
  });

  it("an array-LIKE is not iterable — var [a,b] = {length:2,0:'x',1:'y'} throws", async () => {
    // The distinction that makes this a GetIterator gap and not a length gap:
    // `Array.prototype.slice.call` on the SAME receiver correctly walks it as an
    // array-like, because slice uses LengthOfArrayLike, not GetIterator.
    expect(await throwsTypeError("var [a, b] = { length: 2, 0: 'x', 1: 'y' }; return a;")).toBe(1);
  });

  // NOTE — non-iterable PRIMITIVE RHS (`var [a] = 5`, `var [a] = true`) is
  // covered by the test262-harness probes, not here: compiled as a bare module
  // the checker refuses it statically ("Cannot destructure: not an array type"),
  // which is a loud pre-existing refusal rather than the runtime TypeError this
  // slice is about. Asserting on that message here would be testing the checker.

  // ---- controls: green on origin/main BEFORE the fix, must stay green ----

  it("control — null / undefined still throw (the pre-existing #1225 guard)", async () => {
    expect(await throwsTypeError("var [a] = null; return a;")).toBe(1);
    expect(await throwsTypeError("var [a] = undefined; return a;")).toBe(1);
  });

  it("control — array, string, Set, Map and generator RHS still destructure", async () => {
    const exports = await run(`
      // @ts-nocheck
      export function fromArray() { var [a, b] = [1, 2]; return a * 10 + b; }
      export function fromString() { var [a, b] = "hi"; return a + b; }
      export function fromSet() { var [a] = new Set([7]); return a; }
      export function fromGenerator() {
        function* g() { yield 3; yield 4; }
        var [a, b] = g();
        return a * 10 + b;
      }
      export function fromMap() {
        var m = new Map();
        m.set("k", 5);
        var total = 0;
        for (var [k, v] of m) { total += v; }
        return total;
      }
    `);
    expect(exports.fromArray()).toBe(12);
    expect(exports.fromString()).toBe("hi");
    expect(exports.fromSet()).toBe(7);
    expect(exports.fromGenerator()).toBe(34);
    expect(exports.fromMap()).toBe(5);
  });

  it("control — rest, nested, default and elision forms still bind", async () => {
    const exports = await run(`
      // @ts-nocheck
      export function rest() { var [a, ...r] = [1, 2, 3]; return a * 100 + r.length * 10 + r[0]; }
      export function nested() { var [[n]] = [[6]]; return n; }
      export function withDefault() { var [d = 5] = []; return d; }
      export function elision() { var [, e] = [1, 2]; return e; }
    `);
    expect(exports.rest()).toBe(122);
    expect(exports.nested()).toBe(6);
    expect(exports.withDefault()).toBe(5);
    expect(exports.elision()).toBe(2);
  });

  it("control — param patterns, catch params and assignment patterns still bind", async () => {
    const exports = await run(`
      // @ts-nocheck
      export function paramDefault() { function f([a, b = 9]) { return a + b; } return f([1]); }
      export function patternDefault() { function h([x] = [4]) { return x; } return h(); }
      export function assignPattern() { var p, q; [p, q] = [7, 8]; return p * 10 + q; }
      export function catchPattern() {
        try { throw [1, 2]; } catch ([c1, c2]) { return c1 * 10 + c2; }
      }
    `);
    expect(exports.paramDefault()).toBe(10);
    expect(exports.patternDefault()).toBe(4);
    expect(exports.assignPattern()).toBe(78);
    expect(exports.catchPattern()).toBe(12);
  });

  it("control — a host-array RHS (Array.from result) still destructures", async () => {
    // A different receiver KIND (a real JS array behind an externref), which the
    // strict drain must not reject.
    //
    // The `Object.keys({a:1,b:2})` receiver is deliberately NOT asserted here:
    // under bare `compile()` + `wrapExports` the host-lane `Object.*` statics are
    // under-assembled, so that row answers NaN independently of this change. It
    // IS covered, and green, by the `runTest262File` probe for this slice —
    // asserting it here would be measuring the harness, not the compiler.
    const exports = await run(`
      // @ts-nocheck
      export function fromArrayFrom() { var [c0] = Array.from([9, 8]); return c0; }
    `);
    expect(exports.fromArrayFrom()).toBe(9);
  });

  it("control — arguments and for-of array destructuring still bind", async () => {
    const exports = await run(`
      // @ts-nocheck
      export function fromArguments() { function f() { var [a, b] = arguments; return a + b; } return f(3, 4); }
      export function forOf() {
        var sum = 0;
        for (var [x, y] of [[1, 2], [3, 4]]) { sum += x * 10 + y; }
        return sum;
      }
    `);
    expect(exports.fromArguments()).toBe(7);
    expect(exports.forOf()).toBe(46);
  });

  it("control — a plain object WITH a callable @@iterator still destructures", async () => {
    // The narrow line the fix must not cross: "not an array" is not the
    // predicate; "no callable @@iterator" is.
    const exports = await run(`
      // @ts-nocheck
      export function probe() {
        var obj = {};
        obj[Symbol.iterator] = function () {
          var i = 0;
          return { next: function () {
            i++;
            return i <= 2 ? { value: i * 10, done: false } : { value: undefined, done: true };
          } };
        };
        var [a, b] = obj;
        return a + b;
      }
    `);
    expect(exports.probe()).toBe(30);
  });

  it("control — array spread of a non-iterable already threw and still throws", async () => {
    // This is the case that localised the defect: spread was ALREADY strict, so
    // the machinery existed and only destructuring was unwired.
    expect(await throwsTypeError("var a = [...{ b: 1 }]; return a;")).toBe(1);
  });
});
