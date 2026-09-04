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

// ---------------------------------------------------------------------------
// Round 2 of the r3 review (2026-09-04). Three more findings of the SAME
// family: a "proof" that ignores a way the binding can be rebound, so a
// working program gets a spurious TypeError. Each control asserts the BASE
// tree's stable answer; all three FAIL on the pre-fix lane `6007e38442`.
// ---------------------------------------------------------------------------

describe("#5195 r3 review round 2, R1 — every write spelling defeats the heritage proof", () => {
  // `bindingIsUniqueAndNeverWritten` saw a write only as `BinaryExpression.left`
  // or a `++`/`--` operand. A for-of head, an array- or object-destructuring
  // target, and a parenthesised target all read as "never written", so
  // `var X = () => {}; for (X of [Base]) {}` was "proven" a non-constructor and
  // threw on a program node runs fine.
  const WRITE_SPELLINGS_SOURCE = `
    class Base { m() { return 1; } }
    var Xa = () => {}; for (Xa of [Base]) {}
    var Xb = () => {}; [Xb] = [Base];
    var Xc = () => {}; ({ Xc } = { Xc: Base });
    var Xd = () => {}; ({ q: Xd } = { q: Base });
    var Xe = () => {}; (Xe) = Base;
    var Xf = () => {}; for ([Xf] of [[Base]]) {}
    function fa() { class D extends Xa {} return new D(); }
    function fb() { class D extends Xb {} return new D(); }
    function fc() { class D extends Xc {} return new D(); }
    function fd() { class D extends Xd {} return new D(); }
    function fe() { class D extends Xe {} return new D(); }
    function ff() { class D extends Xf {} return new D(); }
    export function probe() {
      let threw = 0;
      try { fa(); } catch (e) { threw = threw + 1; }
      try { fb(); } catch (e) { threw = threw + 1; }
      try { fc(); } catch (e) { threw = threw + 1; }
      try { fd(); } catch (e) { threw = threw + 1; }
      try { fe(); } catch (e) { threw = threw + 1; }
      try { ff(); } catch (e) { threw = threw + 1; }
      return threw === 0;
    }
  `;

  it("standalone: a destructuring or loop-head write declines the check", async () => {
    expect(await runStandalone(WRITE_SPELLINGS_SOURCE, "issue-5195-r3-review-r1.js")).toBe(1);
  });

  // The r3-5 win is kept for the shapes that really are provable.
  const HERITAGE_WIN_KEPT_SOURCE = `
    var Arrow = () => {};
    function* Gen() {}
    export function probe() {
      let n = 0;
      try { class D extends Arrow {} new D(); } catch (e) { if (e instanceof TypeError) n = n + 1; }
      try { class D extends Gen {} new D(); } catch (e) { if (e instanceof TypeError) n = n + 1; }
      try { class D extends 42 {} new D(); } catch (e) { if (e instanceof TypeError) n = n + 1; }
      return n === 3;
    }
  `;

  it("standalone: a genuinely unwritten non-constructor heritage still throws", async () => {
    expect(await runStandalone(HERITAGE_WIN_KEPT_SOURCE, "issue-5195-r3-review-r1b.js")).toBe(1);
  });
});

describe("#5195 r3 review round 2, R2 — the poison chain resolves bindings, not names", () => {
  // `classChainIsProvablyAllClasses` matched heritage identifiers by TEXT
  // against `classSet`, so a function-scope shadow and a reassigned class name
  // both read as "provably a class" and poisoned `caller`/`arguments`, which
  // threw where node answers `null` and base answers `undefined`.
  const REBOUND_CHAIN_SOURCE = `
    class A { static am() { return 1; } }
    A = function () {};
    class K2 extends A {}
    var L = class {};
    L = function () {};
    class K3 extends L {}
    class B {}
    function f() { var B = function () {}; class K extends B {} return K; }
    export function probe() {
      let threw = 0;
      try { let t = K2.caller; } catch (e) { threw = threw + 1; }
      try { let t = K2.arguments; } catch (e) { threw = threw + 1; }
      try { let t = K3.caller; } catch (e) { threw = threw + 1; }
      try { let t = f().caller; } catch (e) { threw = threw + 1; }
      return threw === 0;
    }
  `;

  it("standalone: a shadowed or reassigned heritage name declines the poison", async () => {
    expect(await runStandalone(REBOUND_CHAIN_SOURCE, "issue-5195-r3-review-r2.js")).toBe(1);
  });
});

describe("#5195 r3 review round 2, R3 — an inline class heritage is walked, not assumed", () => {
  // `if (ts.isClassExpression(heritage)) return true;` ended the chain walk as
  // "proven all classes" without looking at the inline class's OWN heritage, so
  // `class K extends (class extends F {}) {}` was poisoned even though its
  // ancestor is a plain function.
  const INLINE_CLASS_HERITAGE_SOURCE = `
    function F() {}
    class K12 extends (class extends F {}) {}
    class K13 extends class extends F {} {}
    export function probe() {
      let threw = 0;
      try { let t = K12.caller; } catch (e) { threw = threw + 1; }
      try { let t = K12.arguments; } catch (e) { threw = threw + 1; }
      try { let t = K13.caller; } catch (e) { threw = threw + 1; }
      return threw === 0;
    }
  `;

  it("standalone: an inline class expression over a function ancestor declines", async () => {
    expect(await runStandalone(INLINE_CLASS_HERITAGE_SOURCE, "issue-5195-r3-review-r3.js")).toBe(1);
  });
});

describe("#5195 r3 review round 3, R4-A — the poison identifies its receiver by DECLARATION", () => {
  // The r3-7 poison matched its receiver by NAME: the read arm through
  // `classExprNameMap`/`classSet`, the write arm through a bare
  // `ctx.classSet.has(target.expression.text)` with no declaration lookup at
  // all. With a top-level `class A {}` anywhere in the module, EVERY
  // function-scope binding spelled `A` — a parameter, `var A = {caller: 5}`, a
  // destructured binding, a catch parameter, a `for (const A of …)` head, an
  // arrow parameter — had its `.caller` / `.arguments` READ and WRITE turned
  // into a TypeError. node and the base tree both return the real value.
  const SHADOWED_RECEIVER_SOURCE = `
    class A {}
    function rVar() { var A = { caller: 5 }; return A.caller; }
    function wVar() { var A = { caller: 5 }; A.caller = 6; return A.caller; }
    function rParam(A) { return A.caller; }
    function wParam(A) { A.caller = 1; return A.caller; }
    function rDestructured(o) { var { A } = o; return A.caller; }
    function rCatch() { try { throw { caller: 3 }; } catch (A) { return A.caller; } }
    function rForOf() { for (const A of [{ caller: 4 }]) return A.caller; return 0; }
    var rArrow = (A) => A.arguments;
    export function probe() {
      return rVar() === 5 && wVar() === 6 && rParam({ caller: 2 }) === 2 &&
        wParam({}) === 1 && rDestructured({ A: { caller: 9 } }) === 9 &&
        rCatch() === 3 && rForOf() === 4 && rArrow({ arguments: 7 }) === 7;
    }
  `;

  it("standalone: a shadowing binding named like a class keeps base's read and write", async () => {
    expect(await runStandalone(SHADOWED_RECEIVER_SOURCE, "issue-5195-r3-review-r4a.js")).toBe(1);
  });

  // Member-expression receivers were never the class object and must be left
  // alone in every position, including `this.A` and a getter named `A`.
  const MEMBER_RECEIVER_SOURCE = `
    class A {}
    function memberRecv() { var obj = { A: { caller: 3, arguments: 4 } }; return obj.A.caller + obj.A.arguments; }
    function thisRecv() {
      const o = { A: { caller: 2 }, read() { return this.A.caller; } };
      return o.read();
    }
    function getterRecv() { var o = { get A() { return { caller: 7 }; } }; return o.A.caller; }
    export function probe() { return memberRecv() === 7 && thisRecv() === 2 && getterRecv() === 7; }
  `;

  it("standalone: member-expression receivers named like a class are untouched", async () => {
    expect(await runStandalone(MEMBER_RECEIVER_SOURCE, "issue-5195-r3-review-r4a2.js")).toBe(1);
  });

  // The r3-7 win is kept where the receiver PROVABLY is the class object: a
  // uniquely-bound, never-written class declaration read from inside its own
  // static method still throws, as node does.
  const CLASS_RECEIVER_WIN_KEPT_SOURCE = `
    class C {
      static self() { let n = 0; try { let t = C.caller; } catch (e) { n = n + 1; } return n; }
    }
    export function probe() { return C.self(); }
  `;

  it("standalone: the class object itself still throws on caller", async () => {
    expect(await runStandalone(CLASS_RECEIVER_WIN_KEPT_SOURCE, "issue-5195-r3-review-r4a3.js")).toBe(1);
  });
});

describe("#5195 r3 review round 3, R4-B — the static-shadow walk follows the chain proof", () => {
  // The chain proof recurses into an INLINE class-expression parent and
  // answers "all classes", but the static-shadow walk followed
  // `ctx.classParentMap` BY NAME, which has no entry for an anonymous inline
  // parent. So `class K extends (class { static caller(){…} }) {}` was poisoned
  // on `K.caller` even though the declared static shadows the inherited
  // %ThrowTypeError% accessor — node returns the static, base returned a
  // stable `null`/`NaN`, the lane threw.
  const INLINE_PARENT_STATIC_SOURCE = `
    class F1 extends (class { static caller = 11; }) {}
    class F2 extends (class { static caller() { return 12; } }) {}
    class F3 extends (class { static get arguments() { return 13; } }) {}
    class F4 extends (class extends (class { static caller = 14; }) {}) {}
    class F5 extends (class { static ["cal" + "ler"] = 15; }) {}
    export function probe() {
      let threw = 0;
      try { let t = F1.caller; } catch (e) { threw = threw + 1; }
      try { let t = F2.caller; } catch (e) { threw = threw + 1; }
      try { let t = F3.arguments; } catch (e) { threw = threw + 1; }
      try { let t = F4.caller; } catch (e) { threw = threw + 1; }
      try { let t = F5.caller; } catch (e) { threw = threw + 1; }
      return threw === 0;
    }
  `;

  it("standalone: an inline parent declaring the restricted name declines the poison", async () => {
    expect(await runStandalone(INLINE_PARENT_STATIC_SOURCE, "issue-5195-r3-review-r4b.js")).toBe(1);
  });

  // …and the poison is kept where the inline parent declares something else.
  const INLINE_PARENT_UNRELATED_STATIC_SOURCE = `
    class F6 extends (class { static m() { return 0; } }) {}
    export function probe() {
      let threw = 0;
      try { let t = F6.caller; } catch (e) { threw = threw + 1; }
      return threw;
    }
  `;

  it("standalone: an inline parent with an unrelated static still throws", async () => {
    expect(await runStandalone(INLINE_PARENT_UNRELATED_STATIC_SOURCE, "issue-5195-r3-review-r4b2.js")).toBe(1);
  });
});
