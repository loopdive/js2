// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5197 R3-5 — an own `then` written onto a NATIVE promise is observed by
// §27.2.1.3.2 Resolve, and the decision travels with the VALUE.
//
// The defect: `__promise_resolve_value` short-circuited on `ref.test $Promise`
// and adopted the native state directly, so `p.then = f` on a native promise
// was never `Get`. Spec steps 8-13 run `Get(resolution, "then")` for EVERY
// object, native promise included.
//
// This file exists because the fix is a REPRESENTATION decision, and the
// project's repeated failure mode is a representation decision carried by the
// syntactic position of the value rather than by the value itself. The arm
// therefore keys on the carrier bag of the peeled resolution — so it fires
// identically whichever way the promise reaches Resolve. Every row below is one
// indirection: a variable, two hops, an object property, an array element, a
// call return, a parameter, a closure capture.
//
// Every row enters through `new Promise(res => res(x))` — the executor's
// `resolve`, which IS §27.2.1.3.2 Resolve. `Promise.resolve(p)` is deliberately
// NOT the vehicle: §27.2.4.7.1 step 2 returns `p` unchanged for a %Promise%, so
// those spellings pass on the base tree too and would prove nothing. The last
// three rows are the negative controls: a promise with NO own `then` must still
// adopt, a NON-callable own `then` must fulfil with the promise object itself
// (step 11), and `Promise.resolve(p)` must keep its identity short-circuit.
//
// node is the oracle for every expected value here.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PRELUDE = "declare function __drain_microtasks(): void;\n";

async function runStandalone(body: string): Promise<number> {
  const r = await compile(`${PRELUDE}${body}`, {
    fileName: "issue-5197-own-then-indirection.ts",
    target: "standalone",
    nativeStrings: true,
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

// Each case builds a native promise, writes an own `then` onto it, routes it to
// `Promise.resolve` through one indirection, and reports 1 when the own `then`
// ran and delivered its own value (the spec answer, which node agrees with).
// Each entry is [label, setup statements, the expression handed to
// `Promise.resolve`].
const INDIRECTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ["direct", "", "mk()"],
  ["one hop through a variable", "const v: any = mk();", "v"],
  ["two hops", "const v: any = mk(); const w: any = v;", "w"],
  ["through an object property", "const o: any = {}; o.p = mk();", "o.p"],
  ["through an array element", "const a: any = [mk()];", "a[0]"],
  ["through a call return", "function give(): any { return mk(); }", "give()"],
  ["through a conditional", "const c: any = 1 > 0 ? mk() : null;", "c"],
  ["through a closure capture", "const cap: any = mk(); const use: any = function () { return cap; };", "use()"],
];

function indirectionSource(setup: string, expr: string): string {
  return `export function test(): number {
  function mk(): any {
    const p: any = Promise.resolve(1);
    p.then = function (res: any) { res(99); };
    return p;
  }
  const holder: any = { last: 0 };
  ${setup}
  new Promise(function (res: any) { res(${expr}); }).then(
    function (val: any) { holder.last = (val === 99) ? 1 : 2; },
    function () { holder.last = 3; },
  );
  __drain_microtasks();
  return holder.last;
}`;
}

describe("#5197 R3-5 — own `then` on a native promise, through every indirection", () => {
  for (const [label, setup, expr] of INDIRECTIONS) {
    it(`standalone: observes the own then ${label}`, async () => {
      await expect(runStandalone(indirectionSource(setup, expr))).resolves.toBe(1);
    });
  }

  it("standalone: observes the own then through a function parameter", async () => {
    expect(
      await runStandalone(`export function test(): number {
  function mk(): any {
    const p: any = Promise.resolve(1);
    p.then = function (res: any) { res(99); };
    return p;
  }
  const holder: any = { last: 0 };
  function via(x: any): any { return new Promise(function (res: any) { res(x); }); }
  via(mk()).then(function (val: any) { holder.last = (val === 99) ? 1 : 2; }, function () { holder.last = 3; });
  __drain_microtasks();
  return holder.last;
}`),
    ).toBe(1);
  });

  it("standalone: a promise with no own then still adopts", async () => {
    expect(
      await runStandalone(`export function test(): number {
  const holder: any = { last: 0 };
  const inner: any = Promise.resolve(42);
  const alias: any = inner;
  new Promise(function (res: any) { res(alias); }).then(function (val: any) { holder.last = (val === 42) ? 1 : 2; }, function () { holder.last = 3; });
  __drain_microtasks();
  return holder.last;
}`),
    ).toBe(1);
  });

  it("standalone: a NON-callable own then fulfils with the promise itself", async () => {
    // Entered through the executor's `resolve(x)`, which IS §27.2.1.3.2 Resolve.
    // `Promise.resolve(p)` is a DIFFERENT operation (§27.2.4.7.1 step 2 returns
    // `p` itself when its constructor is %Promise%), so it must not be used
    // here. node agrees: `new Promise(r => r(w)).then(v => v === w)` is true.
    expect(
      await runStandalone(`export function test(): number {
  const holder: any = { last: 0 };
  const weird: any = Promise.resolve(7);
  weird.then = 5;
  const alias: any = weird;
  new Promise(function (res: any) { res(alias); }).then(
    function (val: any) { holder.last = (val === weird) ? 1 : 2; },
    function () { holder.last = 3; },
  );
  __drain_microtasks();
  return holder.last;
}`),
    ).toBe(1);
  });

  it("standalone: `then` is captured at Resolve time, not at job time", async () => {
    // §27.2.1.3.2 captures `then` at step 9; the CALL is a job (step 14), so a
    // reassignment between the two must not redirect the job. node answers 11.
    expect(
      await runStandalone(`export function test(): number {
  const holder: any = { last: 0 };
  const p: any = Promise.resolve(1);
  p.then = function (res: any) { res(11); };
  const alias: any = p;
  const outer: any = new Promise(function (res: any) { res(alias); });
  p.then = function (res: any) { res(22); };
  outer.then(function (val: any) { holder.last = (val === 11) ? 1 : (val === 22 ? 2 : 4); }, function () { holder.last = 3; });
  __drain_microtasks();
  return holder.last;
}`),
    ).toBe(1);
  });

  it("standalone: `Promise.resolve(p)` still returns `p` itself (identity short-circuit)", async () => {
    // The NEGATIVE control for the row above: §27.2.4.7.1 step 2 is NOT Resolve,
    // so a `then` reassigned afterwards IS the one that runs. node answers 22,
    // and this branch must not "fix" it to 11.
    expect(
      await runStandalone(`export function test(): number {
  const holder: any = { last: 0 };
  const p: any = Promise.resolve(1);
  p.then = function (res: any) { res(11); };
  const alias: any = p;
  const outer: any = Promise.resolve(alias);
  p.then = function (res: any) { res(22); };
  outer.then(function (val: any) { holder.last = (val === 22) ? 1 : (val === 11 ? 2 : 4); }, function () { holder.last = 3; });
  __drain_microtasks();
  return holder.last;
}`),
    ).toBe(1);
  });
});

// (#5197 round-3 review F2) IsCallable(thenAction) is the CLASSIFIER's answer,
// not one `ref.test` against the funcref-wrapper root: a bound function lives
// in its own `$__bound_fn` carrier and was judged "own but not callable", so
// the outer promise was fulfilled with the promise OBJECT (a spec-impossible
// state). Every callable kind must reach the job; every non-callable must
// fulfil with the promise itself (step 11). node's answer: 11110333.
//   digit 1 = the own `then` ran and delivered 77
//   digit 0 = the own `then` ran but never settled (a native builtin such as
//             `Math.max` returns a number and calls neither argument — the
//             outer promise stays pending, exactly as in node)
//   digit 3 = fulfilled with the promise object itself
const CALLABLE_KINDS = `
  var got: any = 0;
  class C { m(r: any): void { r(77); } }
  function digit(p: any): number {
    if (got === 77) return 1;
    if (got === 1) return 2;
    if (got === p) return 3;
    if (got === undefined) return 4;
    if (got === 0) return 0;
    return 6;
  }
  function row(kind: number): number {
    got = 0;
    var p: any = Promise.resolve(1);
    if (kind === 0) p.then = function (r: any) { r(77); };
    else if (kind === 1) p.then = (r: any) => { r(77); };
    else if (kind === 2) p.then = (function (this: any, r: any) { r(this.k); }).bind({ k: 77 });
    else if (kind === 3) p.then = C.prototype.m;
    else if (kind === 4) p.then = Math.max;
    else if (kind === 5) p.then = {};
    else if (kind === 6) p.then = 42;
    else if (kind === 7) p.then = null;
    new Promise(function (res: any) { res(p); }).then(function (v: any) { got = v; });
    __drain_microtasks();
    return digit(p);
  }
  export function test(): number {
    var out: number = 0;
    for (var i: number = 0; i < 8; i++) out = out * 10 + row(i);
    return out;
  }
`;

describe("#5197 round-3 F2 — IsCallable(then) uses the closure classifier", () => {
  it("standalone: plain / arrow / bound / class method / native builtin / object / number / null", async () => {
    await expect(runStandalone(CALLABLE_KINDS)).resolves.toBe(11110333);
  });
});
