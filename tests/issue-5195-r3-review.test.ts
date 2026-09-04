// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5195 r3 — the five regressions the round-3 adversarial review found in the
// r3-3 / r3-4 / r3-5 / r3-7 pass, one control each.
//
// Every control asserts the BASE tree's answer (or node's, where the fix
// reaches it), NOT the first cut's, and every one of them FAILS on the lane as
// it stood at `c1a2bf1609`. Two of the five (F2, F4) also fail on the base tree
// `91d4999050` in the direction the fix improves; the other three are pure
// order-preservation controls that base passes and the first cut broke.
//
// CORRECTED PREMISE (review note N1): `--target wasi` does NOT set
// `ctx.standalone` (`context/create-context.ts`:
// `standalone: targetProfile.target === "standalone"`), so the r3-3/r3-5/r3-7
// gates reach the standalone lane ONLY, while r3-4 is ungated and reaches
// host, standalone and wasi alike. F2's control is therefore run on all three.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string, fileName: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  expect(result.imports, "#5195 standalone controls must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, () => unknown>).probe!();
}

async function compilesOn(source: string, target: "host" | "standalone" | "wasi", fileName: string): Promise<void> {
  const result = await compile(source, {
    allowJs: true,
    fileName,
    skipSemanticDiagnostics: true,
    ...(target === "host" ? {} : { target, nativeStrings: true }),
  });
  expect(
    result.success,
    `${target}: ${result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")}`,
  ).toBe(true);
}

describe("#5195 r3 review F1 — an unprovable heritage keeps its lane", () => {
  // The first cut admitted any heritage it could not trace to a same-file
  // declaration and then treated every non-externref value (a `(ref null $C)`
  // class struct held in a parameter, an alias, a conditional) as a
  // non-constructor, throwing UNCONDITIONALLY. That broke the canonical mixin
  // factory and a class declared over a parameter — both of which the base
  // tree compiles and runs correctly.
  const MIXIN_SOURCE = `
    class Base { m() { return 1; } }
    function mkDecl(P) { class D extends P {} return new D().m(); }
    function mkVar(P) { var E = class extends P {}; return new E().m(); }
    const Mixin2 = function (B) { const M = class extends B {}; return M; };
    function Mixin5(B) { return class extends B {}; }
    export function probe() {
      let ok = 0;
      if (mkDecl(Base) === 1) ok = ok + 1;
      if (mkVar(Base) === 1) ok = ok + 1;
      if (new (Mixin2(Base))().m() === 1) ok = ok + 1;
      if (new (Mixin5(Base))().m() === 1) ok = ok + 1;
      return ok === 4;
    }
  `;

  it("standalone: a parameter / alias / mixin-factory heritage does not throw", async () => {
    expect(await runStandalone(MIXIN_SOURCE, "issue-5195-r3-review-f1.js")).toBe(1);
  });

  // A conditional heritage and a function-scope alias of a class are two more
  // shapes the compiler cannot prove. Base answers them WRONGLY (`0` / `null`)
  // but stably; the first cut turned each into a TypeError, which the
  // never-worse-than-base rule forbids. What this pins is only that they do
  // not throw.
  const UNPROVABLE_SOURCE = `
    class A { m() { return 1; } }
    class B { m() { return 2; } }
    var flag = true;
    function cond() { class D extends (flag ? A : B) {} return new D().m(); }
    function alias() { var X = A; class D extends X {} return new D().m(); }
    export function probe() {
      let threw = 0;
      try { cond(); } catch (e) { threw = threw + 1; }
      try { alias(); } catch (e) { threw = threw + 1; }
      return threw === 0;
    }
  `;

  it("standalone: a conditional and a function-scope alias do not throw", async () => {
    expect(await runStandalone(UNPROVABLE_SOURCE, "issue-5195-r3-review-f1b.js")).toBe(1);
  });

  // …and the shapes the compiler CAN prove still throw, so the r3-5 win is
  // kept: a `var`-bound arrow, an inline arrow, a generator declaration, a
  // number, a string and an object literal.
  const PROVABLE_SOURCE = `
    var arrow = () => {};
    function* gen() {}
    var num = 42;
    var obj = {};
    export function probe() {
      let n = 0;
      try { class A extends arrow {} } catch (e) { if (e instanceof TypeError) n = n + 1; }
      try { var B = class extends (() => {}) {}; } catch (e) { if (e instanceof TypeError) n = n + 1; }
      try { class C extends gen {} } catch (e) { if (e instanceof TypeError) n = n + 1; }
      try { class D extends num {} } catch (e) { if (e instanceof TypeError) n = n + 1; }
      try { class E extends obj {} } catch (e) { if (e instanceof TypeError) n = n + 1; }
      return n === 5;
    }
  `;

  it("standalone: a provably non-constructor heritage still throws", async () => {
    expect(await runStandalone(PROVABLE_SOURCE, "issue-5195-r3-review-f1c.js")).toBe(1);
  });
});

describe("#5195 r3 review F2 — `static constructor(){}` with no instance constructor compiles", () => {
  // r3-4 made `findConstructorImplementation` skip a `static constructor`, so
  // the class plans as implicit-constructor — but the IR identity inventory
  // still recorded that member as the class's `class-constructor`, so no
  // `class-implicit-constructor` unit existed for the `<Class>_init` allocator
  // codegen emitted, and the ABI planner rejected the module outright:
  // "class callable E_init has no consistent exact class-implicit-constructor
  // inventory owner". Ungated, so all three targets failed to compile a
  // program the base tree compiled and ran.
  const STATIC_CTOR_ONLY = `
    class E { static constructor() { return 9; } }
    const K = class { static constructor() { return 4; } };
    export function probe() {
      return typeof new E() === "object" && typeof new K() === "object";
    }
  `;

  it("standalone: it compiles and the class constructs implicitly", async () => {
    expect(await runStandalone(STATIC_CTOR_ONLY, "issue-5195-r3-review-f2.js")).toBe(1);
  });

  for (const target of ["host", "standalone", "wasi"] as const) {
    it(`${target}: it compiles`, async () => {
      await compilesOn(STATIC_CTOR_ONLY, target, "issue-5195-r3-review-f2-target.js");
    });
  }

  // The r3-4 win is kept: a `static constructor` alongside a REAL constructor
  // is no longer the duplicate-constructor early error it was on base.
  const STATIC_PLUS_REAL = `
    class C { static constructor() { return 7; } constructor() { this.v = 1; } }
    export function probe() {
      return new C().v === 1 && typeof C.constructor === "function";
    }
  `;

  it("standalone: a static constructor beside a real one still compiles and runs", async () => {
    expect(await runStandalone(STATIC_PLUS_REAL, "issue-5195-r3-review-f2b.js")).toBe(1);
  });
});

describe("#5195 r3 review F3 — an assignment-keyed member keeps its static name", () => {
  // r3-3 routed `[x = "m"]() {}` into the runtime-key install lane, which has
  // never served dotted or static access: `new C().m()` went 1 -> null, a
  // static went 8 -> null, a setter's target went 10 -> NaN, and the key
  // variable took a NaN where a stable 0 stood. Reverted; the write is still
  // dropped, exactly as on base, and r3-3's single test262 row is given back.
  const ASSIGN_KEY_SOURCE = `
    let x = 0;
    let x3 = 0;
    class C { [x = "m"]() { return 1; } }
    class C8 { static [x3 = "s"]() { return 8; } }
    export function probe() {
      let ok = 0;
      if (new C().m() === 1) ok = ok + 1;
      if (new C()["m"]() === 1) ok = ok + 1;
      if (C8.s() === 8) ok = ok + 1;
      return ok === 3;
    }
  `;

  it("standalone: the member is reachable by its statically folded name", async () => {
    expect(await runStandalone(ASSIGN_KEY_SOURCE, "issue-5195-r3-review-f3.js")).toBe(1);
  });
});

describe("#5195 r3 review F4 — a DECLARED static `caller`/`arguments` accessor is not poisoned", () => {
  // `classObjectRestrictedProperty` looked the accessor surface up as
  // `<Class>_get_<prop>` / `<Class>_set_<prop>`, but both add sites in
  // class-bodies.ts write `<Class>_<prop>` — so a declared `static get
  // caller()` never matched and its read threw where node and base answer 1.
  const STATIC_ACCESSOR_SOURCE = `
    class V { static get caller() { return 1; } }
    class V3 { static get arguments() { return 2; } }
    class V4 extends V {}
    export function probe() {
      return V.caller === 1 && V3.arguments === 2 && V4.caller === 1;
    }
  `;

  it("standalone: the declared static getter shadows the poison, own and inherited", async () => {
    expect(await runStandalone(STATIC_ACCESSOR_SOURCE, "issue-5195-r3-review-f4.js")).toBe(1);
  });
});

describe("#5195 r3 review F5 — a heritage that is not provably a class declines the poison", () => {
  // The decline covered function DECLARATIONS only (`fnctorAncestorOfClass`
  // requires `topLevelFunctionNames` AND `funcMap`), so a class extending a
  // `var`-bound function EXPRESSION was poisoned: `K.caller` threw where node
  // answers `null` and base answers `undefined`. The decline now covers every
  // heritage the compiler cannot prove to be a class.
  const FN_EXPR_ANCESTOR_SOURCE = `
    var Fe = function () {};
    class K extends Fe {}
    function F() {}
    class G extends F {}
    class H extends G {}
    export function probe() {
      let threw = 0;
      try { let t = K.caller; } catch (e) { threw = threw + 1; }
      try { let t = H.caller; } catch (e) { threw = threw + 1; }
      return threw === 0;
    }
  `;

  it("standalone: a function-expression ancestor does not throw", async () => {
    expect(await runStandalone(FN_EXPR_ANCESTOR_SOURCE, "issue-5195-r3-review-f5.js")).toBe(1);
  });

  // …and the r3-7 win is kept for a chain that IS provably all classes.
  const POISON_KEPT_SOURCE = `
    class BaseClass {}
    class Sub extends BaseClass {}
    class Err extends Error {}
    export function probe() {
      let n = 0;
      try { let t = BaseClass.caller; } catch (e) { if (e instanceof TypeError) n = n + 1; }
      try { let t = Sub.arguments; } catch (e) { if (e instanceof TypeError) n = n + 1; }
      try { let t = Err.caller; } catch (e) { if (e instanceof TypeError) n = n + 1; }
      return n === 3;
    }
  `;

  it("standalone: a provably all-class chain is still poisoned", async () => {
    expect(await runStandalone(POISON_KEPT_SOURCE, "issue-5195-r3-review-f5b.js")).toBe(1);
  });
});
