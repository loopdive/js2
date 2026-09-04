// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5249 — `RuntimeError: unreachable` from an OPEN-RECEIVER `this.m(…)` call.
//
// "Open receiver" here means the base class calling `this.m(…)` does NOT
// declare `m` itself; every implementation lives on a subclass. Codegen answers
// that with a `__tag` cascade (`expressions/virtual-dispatch.ts`) whose terminal
// `else` is `unreachable`, so the candidate set IS the set of receivers that do
// not trap.
//
// ROOT CAUSE (measured, not inferred). The candidate walk in
// `expressions/call-receiver-method.ts` admitted only DIRECT children of the
// receiver class that DECLARE the method:
//
//     for (const [childClass, parentClass] of ctx.classParentMap)
//       if (parentClass === receiverClassName || parentClass === baseClass) …
//
// so two whole kinds of receiver got no arm and trapped:
//   * a GRANDCHILD that declares an override (`D extends B extends Base`);
//   * a DESCENDANT that inherits one (`C extends A`, `C` declares nothing) —
//     `C.m` resolves to `A_m` by ordinary prototype lookup, but there is no
//     `C_m` for the walk to find.
//
// Measured on `@js-temporal/polyfill@0.5.1`: `HelperBase.adjustCalendarDate`
// calls `this.monthsInYear(…)`; the emitted cascade carried arms for exactly
// the SEVEN direct `HelperBase` children that declare it and `unreachable` for
// the other 19 descendants (`GregoryHelper`, `RocHelper`, `JapaneseHelper`, the
// five `Islamic*` helpers, …). That is the whole 123-row test262 family.
//
// NOT FIXED HERE, stated rather than hidden: an instance of the BASE itself
// still reaches `unreachable` rather than a `TypeError: this.m is not a
// function`, because the base genuinely has no implementation to dispatch to.
// Turning that arm into a spec TypeError is a separate change to the cascade's
// terminal `else`; the polyfill never instantiates `HelperBase` directly, so it
// is not part of this family. Pinned as a control below so a future fix has a
// base reading.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

async function run(source: string): Promise<unknown> {
  const exports = await compileToWasm(source);
  return exports.test!();
}

// Mirrors the polyfill's shape: `Base` calls a method it does not declare;
// `A`/`B` declare it; `C` inherits A's; `D` is a grandchild that overrides.
const HIERARCHY = `
abstract class Base {
  abstract n(x: number): number;
  run(x) { return this.n(x); }
}
class A extends Base { n(x) { return x + 1; } }
class B extends Base { n(x) { return x + 2; } }
class C extends A {}
class D extends B { n(x) { return x + 4; } }
`;

describe("#5249 open-receiver dispatch covers every descendant", () => {
  it("dispatches an inheriting descendant and an overriding grandchild", async () => {
    // Base: `A,B` passed already; `C,D` were `RuntimeError: unreachable`.
    const source = `${HIERARCHY}
export function test() {
  const out: number[] = [];
  out.push(new A().run(10));
  out.push(new B().run(10));
  out.push(new C().run(10));
  out.push(new D().run(10));
  return out.join(",");
}
`;
    expect(await run(source)).toBe("11,12,11,14");
  });

  it("keeps dispatching through a base-typed variable, not the first candidate", async () => {
    // The cascade must read the RUNTIME tag: a single shared `Base`-typed
    // binding that is reassigned would otherwise answer with candidates[0].
    const source = `${HIERARCHY}
export function test() {
  const all = [new A(), new B(), new C(), new D()];
  let acc = "";
  for (const h of all) acc += h.run(100) + ";";
  return acc;
}
`;
    expect(await run(source)).toBe("101;102;101;104;");
  });

  it("still emits a DIRECT call when the whole hierarchy shares one body", async () => {
    // One implementation ⇒ no cascade is needed, and none is emitted: the
    // widening must not turn a working single-target call into N arms.
    const source = `
class Root { run(x) { return this.n(x); } }
class Only extends Root { n(x) { return x * 2; } }
class Sub1 extends Only {}
class Sub2 extends Sub1 {}
export function test() { return new Sub2().run(21) + "|" + new Only().run(21); }
`;
    const result = await compile(source, { fileName: "issue-5249.ts" });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    // `Root_run`'s body holds the call. With one implementation there is
    // nothing to compare, so no `__tag` read is emitted for this dispatch.
    expect(await run(source)).toBe("42|42");
  });

  it("dispatches a method declared only on a deep descendant", async () => {
    // Nothing at all on the direct children: the old walk found ZERO
    // candidates and fell through to a graceful miss.
    const source = `
class Top { run(x) { return this.n(x); } }
class Mid extends Top {}
class Leaf1 extends Mid { n(x) { return x + 1; } }
class Leaf2 extends Mid { n(x) { return x + 2; } }
export function test() { return new Leaf1().run(5) + "," + new Leaf2().run(5); }
`;
    expect(await run(source)).toBe("6,7");
  });

  it("leaves an override ON the receiver class alone (control)", async () => {
    // The other candidate branch — the method IS declared on the receiver
    // class — already walked full ancestry and must be unaffected.
    const source = `
class Base2 {
  n(x) { return x; }
  run(x) { return this.n(x); }
}
class A2 extends Base2 { n(x) { return x + 1; } }
class C2 extends A2 {}
class E2 extends Base2 {}
export function test() {
  return [new Base2(), new A2(), new C2(), new E2()].map((h) => h.run(10)).join(",");
}
`;
    expect(await run(source)).toBe("10,11,11,10");
  });
});
