// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4447 — for-of ASSIGNMENT-destructuring residual on the standalone lane.
//
// Four independent defects, all in the ASSIGNMENT form of a for-of head
// (`for ([x] of …)` / `for ({k: t} of …)`). The BINDING form
// (`for (const [x] of …)`) already routed through `destructureParamArray` and
// was correct — that asymmetry is what hid these:
//
//  1. §13.15.5.2 GetIterator was never performed for an array assignment
//     pattern in a for-of head: the element was read as `elem[i]` via
//     `__extern_get`, so a user iterable observed ZERO `next()` and ZERO
//     `return()` calls (test262 `for-of/dstr/array-elem-trlg-iter-*`, 0/23).
//  2. `__iterator_next`'s closed-struct result read required BOTH
//     `__sget_done` and `__sget_value`. A conformant `{ done: … }`-only
//     IteratorResult leaves a module with no `value` field anywhere ⇒ no
//     `__sget_value` is emitted ⇒ the read fell to the `done := 1` degrade and
//     reported the iterator exhausted on step 1, which ALSO suppressed
//     IteratorClose (§7.4.9 closes only on a non-done stop).
//  3. Object assignment patterns dropped their DEFAULTS and mis-resolved their
//     TARGET: `{ k: t = d }` parses as a PropertyAssignment over the
//     AssignmentExpression `t = d`, which the lowering never destructured, so
//     it wrote a variable named `k` and ignored `d`.
//  4. Nested patterns in the value/element/rest position (`{ x: { y } }`,
//     `[[y]]`, `[...{ 1: x }]`) were silently dropped instead of recursing —
//     and an absent/`undefined` nested source must throw TypeError.
//
// LANE SCOPE. The lowering is shared with the JS-host (`gc`) lane, so every
// case is exercised there too — but several of these shapes have a SEPARATE,
// pre-existing gc-lane gap that #4447 does not address: the host
// `__array_from_iter_n` / `__extern_get` helpers cannot drive a COMPILED
// closed-struct iterator or read a compiled object's properties, so the
// iterator-protocol cases answer 0 on gc both before and after this change
// (measured: `for-of/dstr/array-elem-trlg-iter-*` is 0/23 on gc at HEAD).
// Those cases therefore assert the standalone value and only require that the
// gc module still COMPILES and VALIDATES — locking in "no gc crash/regression"
// without freezing a wrong gc value.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string, target: "standalone" | "gc"): Promise<unknown> {
  const opts = target === "standalone" ? { target: "standalone" as const } : {};
  const r = await compile(src, opts);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), `${target}: module failed WebAssembly.validate`).toBe(true);
  const imports = target === "standalone" ? {} : buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => unknown }).test();
}

/** Compile + validate on `gc` without asserting the (pre-existing-gap) value. */
async function gcCompilesAndValidates(src: string): Promise<void> {
  const r = await compile(src, {});
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "gc: module failed WebAssembly.validate").toBe(true);
}

/** Standalone is the lane under test; gc must merely stay compilable. */
async function standaloneOnly(src: string, expected: unknown): Promise<void> {
  expect(await run(src, "standalone"), "standalone").toStrictEqual(expected);
  await gcCompilesAndValidates(src);
}

/** Both lowering lanes agree on this shape — assert both. */
async function bothLanes(src: string, expected: unknown): Promise<void> {
  expect(await run(src, "standalone"), "standalone").toStrictEqual(expected);
  expect(await run(src, "gc"), "gc").toStrictEqual(expected);
}

/**
 * A user iterable whose `next()` returns a `{ done }`-only IteratorResult —
 * exactly test262's `array-elem-trlg-iter-*` shape, and the one that tripped
 * the `__sget_value` conjunction. `n`/`r` count `next`/`return` calls.
 */
const ITERABLE_PRELUDE = `
var n = 0;
var r = 0;
var iterator: any = {
  next: function () { n += 1; return { done: n > 10 }; },
  return: function () { r += 1; return {}; },
};
var iterable: any = {};
iterable[Symbol.iterator] = function () { return iterator; };
`;

describe("#4447 §13.15.5.2 — for-of array assignment pattern performs GetIterator", () => {
  it("steps the iterator once per element and IteratorCloses a non-exhausted iterator", async () => {
    // §8.5.3: one IteratorStep per element; the pattern does not exhaust the
    // iterator (`done` stays false), so §7.4.9 IteratorClose calls `return()`.
    // Before: n === 0, r === 0 — the iterator was never touched at all.
    await standaloneOnly(
      `${ITERABLE_PRELUDE}
      var x: any;
      export function test(): number {
        for ([x] of [iterable]) { break; }
        return n * 10 + r;
      }`,
      11,
    );
  });

  it("does NOT close an iterator that reported done (§7.4.9 closes only a non-done stop)", async () => {
    await standaloneOnly(
      `var n = 0;
      var r = 0;
      var iterator: any = {
        next: function () { n += 1; return { done: true }; },
        return: function () { r += 1; return {}; },
      };
      var iterable: any = {};
      iterable[Symbol.iterator] = function () { return iterator; };
      var x: any;
      export function test(): number {
        for ([x] of [iterable]) { break; }
        return n * 10 + r;
      }`,
      10,
    );
  });

  it("an elision still costs one IteratorStep", async () => {
    // §8.5.3 step 2: an Elision consumes an iterator step exactly like a
    // binding element, so `[, y]` takes two and then closes.
    await standaloneOnly(
      `${ITERABLE_PRELUDE}
      var y: any;
      export function test(): number {
        for ([, y] of [iterable]) { break; }
        return n * 10 + r;
      }`,
      21,
    );
  });

  it("a rest element drains to exhaustion and does NOT close", async () => {
    // A rest element passes -1 (unbounded) to `__array_from_iter_n`, so the
    // iterator runs to its natural `done` — no IteratorClose (§7.4.9).
    await standaloneOnly(
      `var n = 0;
      var r = 0;
      var iterator: any = {
        next: function () { n += 1; return { done: n > 3, value: n }; },
        return: function () { r += 1; return {}; },
      };
      var iterable: any = {};
      iterable[Symbol.iterator] = function () { return iterator; };
      var rest: any;
      export function test(): number {
        for ([...rest] of [iterable]) { break; }
        return n * 10 + r;
      }`,
      40,
    );
  });

  it("a plain array literal source still destructures by value (unchanged fast path)", async () => {
    // Plain arrays with the default @@iterator keep the indexed fast path
    // inside `__array_from_iter_n`, so this shape is byte-equivalent.
    await bothLanes(
      `var a: any, b: any;
      export function test(): number {
        for ([a, b] of [[7, 9]]) { }
        return a * 10 + b;
      }`,
      79,
    );
  });

  it("an `any`-typed array source now destructures by index (was NaN on both lanes)", async () => {
    await standaloneOnly(
      `var src: any = [4, 5];
      var p: any, q: any;
      export function test(): number {
        for ([p, q] of [src]) { }
        return p * 10 + q;
      }`,
      45,
    );
  });
});

describe("#4447 §7.4.4 — a `{ done }`-only IteratorResult reports the real done flag", () => {
  it("reads `done` through __sget_done even when the module emits no __sget_value", async () => {
    // The module below contains NO struct carrying a `value` field, so
    // `__sget_value` is never emitted. Before, that forced `done := 1` on the
    // first step, so the drain stopped at n === 1.
    await standaloneOnly(
      `var n = 0;
      var iterator: any = { next: function () { n += 1; return { done: n >= 3 }; } };
      var iterable: any = {};
      iterable[Symbol.iterator] = function () { return iterator; };
      var out: any;
      export function test(): number {
        for ([...out] of [iterable]) { break; }
        return n;
      }`,
      3,
    );
  });
});

describe("#4447 §13.15.5.4 — object assignment pattern targets and defaults", () => {
  it("`{ k: t = d }` writes `t`, not `k`, when the property is present", async () => {
    await bothLanes(
      `var b: any;
      export function test(): number {
        for ({ y: b = 22 } of [{ y: 5 }]) { }
        return b;
      }`,
      5,
    );
  });

  it("`{ k: t = d }` fires the default when the property is ABSENT", async () => {
    await bothLanes(
      `var a: any;
      export function test(): number {
        for ({ x: a = 11 } of [{ q: 1 }]) { }
        return a;
      }`,
      11,
    );
  });

  it("`{ k = d }` shorthand default fires only when the property is absent", async () => {
    await bothLanes(
      `var z: any, w: any;
      export function test(): number {
        for ({ z = 33 } of [{ q: 1 }]) { }
        for ({ w = 44 } of [{ w: 7 }]) { }
        return z * 10 + w;
      }`,
      337,
    );
  });

  it("an empty-object source ({} → externref element) reads properties and defaults", async () => {
    // `[{}]` lowers the element to an externref, which took a branch that never
    // READ a property: the target degraded to the key name and only shorthand
    // defaults were seen (and those fired unconditionally). This shape also
    // exercises the #4447 module-global re-resolution — registering the
    // property-name string constant shifts every module global's absolute
    // index, and the stale one landed in the immutable IMPORT range
    // ("immutable global #3 cannot be assigned") on the gc lane.
    await bothLanes(
      `var a: any, z: any;
      export function test(): number {
        for ({ x: a = 11 } of [{}]) { }
        for ({ z = 33 } of [{}]) { }
        return a * 100 + z;
      }`,
      1133,
    );
  });

  it("an externref source with the property PRESENT does not fire the default", async () => {
    await standaloneOnly(
      `var src: any = { w: 7 };
      var w: any;
      export function test(): number {
        for ({ w = 44 } of [src]) { }
        return w;
      }`,
      7,
    );
  });

  it("`null` does NOT fire a default — only `undefined` does (§13.15.5.4 / #1550)", async () => {
    await bothLanes(
      `var v: any;
      export function test(): number {
        for ({ k: v = 9 } of [{ k: null }]) { }
        return v === null ? 1 : 0;
      }`,
      1,
    );
  });
});

describe("#4447 §13.15.5.4/5 — nested assignment patterns recurse", () => {
  it("nested object pattern in the value position binds its targets", async () => {
    await bothLanes(
      `var y: any;
      export function test(): number {
        for ({ x: { y } } of [{ x: { y: 2 } }]) { }
        return y;
      }`,
      2,
    );
  });

  it("nested array pattern in the value position binds its targets", async () => {
    await bothLanes(
      `var y: any;
      export function test(): number {
        for ({ x: [y] } of [{ x: [321] }]) { }
        return y;
      }`,
      321,
    );
  });

  it("destructuring an ABSENT property through a nested pattern throws", async () => {
    // §13.15.5.4 step 3 → §13.15.5.2 RequireObjectCoercible / GetIterator on
    // `undefined`. Before: bound nothing and threw nothing. The thrown carrier
    // is the module's native TypeError throw (an `$exc` tag payload, not a JS
    // `TypeError` instance in the standalone lane), so this asserts THAT it
    // throws — which is exactly what test262's `assert.throws(TypeError, …)`
    // observes through the runner's harness transform.
    const src = `export function test(): number {
      for ({ x: { y } } of [{}]) { }
      return 0;
    }`;
    await expect(run(src, "standalone")).rejects.toThrow();
    await gcCompilesAndValidates(src);
  });

  it("a nested default fires before the nested pattern destructures it", async () => {
    await standaloneOnly(
      `var y: any;
      export function test(): number {
        for ({ x: { y } = { y: 8 } } of [{}]) { }
        return y;
      }`,
      8,
    );
  });

  it("a nested pattern as an ARRAY element binds its targets", async () => {
    await standaloneOnly(
      `var src: any = [[4, 5]];
      var p: any, q: any;
      export function test(): number {
        for ([[p, q]] of [src]) { }
        return p * 10 + q;
      }`,
      45,
    );
  });

  it("a nested pattern as the REST target destructures the slice", async () => {
    // `for ([...{ 1: x }] of …)` — §13.15.5.5 AssignmentRestElement PutValue's
    // the remainder into an AssignmentPattern like any other target. Numeric
    // PropertyNames count (`{ 1: x }`), which the key resolution also missed.
    await standaloneOnly(
      `var src: any = [[1, 2, 3]];
      var a: any, b: any;
      export function test(): number {
        for ([...[a, b]] of src) { }
        return a * 10 + b;
      }`,
      12,
    );
  });
});
