// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5195 r3-7 — §10.2.4 AddRestrictedFunctionProperties on a CLASS OBJECT.
//
// A class object is a strict function, so `C.caller` / `C.arguments` resolve to
// the %ThrowTypeError% accessor inherited from %Function.prototype%: reading
// AND writing throw a TypeError. Standalone has no %Function.prototype%
// accessor to inherit, so the class-static read/write bands answer the throw
// directly — gated on `ctx.standalone`, which is why only the standalone lane
// is pinned for the throwing shape (the JS-host lane still answers silently;
// that gap is not this step's).
//
// The order-preservation half is the second describe block: a class that
// DECLARES a static member named `caller`/`arguments` shadows the inherited
// accessor and keeps its value on BOTH lanes.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

/** The two Test262 rows r3-7 flips (base `91d4999050`: both fail at L14). */
const R3_7_ROWS = [
  "language/statements/class/restricted-properties.js",
  "language/expressions/class/restricted-properties.js",
] as const;

async function runStandalone(source: string, exportName: string, fileName: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  expect(result.imports, "#5195 standalone controls must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, () => unknown>)[exportName]!();
}

function runHost(source: string, exportName: string): unknown {
  const hostSource = source.replace(/\bexport\s+/g, "");
  return (new Function(`${hostSource}\nreturn ${exportName};`)() as () => unknown)();
}

describe("#5195 r3-7 — `caller`/`arguments` on a class object throw in standalone", () => {
  for (const relativePath of R3_7_ROWS) {
    const file = resolve(process.cwd(), "test262", "test", relativePath);
    it.skipIf(!existsSync(file))(
      `r3-7: ${relativePath} passes in standalone`,
      async () => {
        try {
          const standalone = await runTest262File(file, "issue-5195-r3", 60_000, "standalone");
          expect({ status: standalone.status, error: standalone.error }).toEqual({
            status: "pass",
            error: undefined,
          });
        } finally {
          restoreHostBuiltins();
        }
      },
      300_000,
    );
  }

  // Five throwing sites: read + write on a base class, read on a SUBCLASS
  // (the inherited-band case — `resolvedClass` is the subclass, which declares
  // nothing of the name either).
  const POISON_SOURCE = `
    class BaseClass {}
    class Sub extends BaseClass {}
    export function probe() {
      let n = 0;
      try { let t = BaseClass.caller; } catch (e) { if (e instanceof TypeError) n = n + 1; }
      try { let t = BaseClass.arguments; } catch (e) { if (e instanceof TypeError) n = n + 1; }
      try { let t = Sub.caller; } catch (e) { if (e instanceof TypeError) n = n + 1; }
      try { BaseClass.caller = 1; } catch (e) { if (e instanceof TypeError) n = n + 1; }
      try { BaseClass.arguments = 1; } catch (e) { if (e instanceof TypeError) n = n + 1; }
      return n === 5;
    }
  `;

  it("standalone: five restricted-property accesses each throw TypeError", async () => {
    expect(await runStandalone(POISON_SOURCE, "probe", "issue-5195-r3-poison.js")).toBe(1);
  });
});

describe("#5195 r3-7 — a DECLARED static `caller`/`arguments` keeps its value", () => {
  const DECLARED_SOURCE = `
    class W { static caller = 1; }
    class V { static arguments() { return 2; } }
    export function probe() {
      return W.caller === 1 && V.arguments() === 2;
    }
  `;

  it("standalone: the declaration shadows the inherited accessor", async () => {
    expect(await runStandalone(DECLARED_SOURCE, "probe", "issue-5195-r3-declared.js")).toBe(1);
  });

  it("host lane agrees", () => {
    expect(runHost(DECLARED_SOURCE, "probe")).toBe(true);
  });

  // Statics are inherited, so an ANCESTOR's `static caller` shadows the
  // %ThrowTypeError% accessor for every descendant as well. The predicate
  // walks the whole chain over all four declaration surfaces (field, method,
  // getter, setter) — testing only the own class and then the FIELD half of
  // the ancestors would poison `B.caller` here.
  const INHERITED_SOURCE = `
    class A { static caller() { return 1; } }
    class B extends A {}
    class P { static arguments = 5; }
    class Q extends P {}
    export function probe() {
      return B.caller() === 1 && Q.arguments === 5;
    }
  `;

  it("standalone: an ancestor's static declaration shadows it too", async () => {
    expect(await runStandalone(INHERITED_SOURCE, "probe", "issue-5195-r3-inherited.js")).toBe(1);
  });

  it("host lane agrees on the inherited declaration", () => {
    expect(runHost(INHERITED_SOURCE, "probe")).toBe(true);
  });

  // A plain FUNCTION ancestor is the one chain that must NOT be poisoned:
  // `function F(){}` is sloppy, so V8 gives it own `caller`/`arguments` data
  // properties valued `null`, and `class G extends F {}` inherits them —
  // node answers `null`, not a throw. Standalone still answers `undefined`
  // there (wrong the same way as before this step), so the invariant this
  // pins is the one the step must not break: reading it does not THROW.
  // (The derived instance FIELD of a function ancestor is a separate,
  // pre-existing standalone gap — `new G(3).a` is `undefined` on the base tree
  // too — so it is deliberately not asserted here.)
  const FNCTOR_SOURCE = `
    function F(a) { this.a = a; }
    class G extends F {}
    export function probe() {
      let threw = false;
      try { let t = G.caller; } catch (e) { threw = true; }
      return threw === false;
    }
  `;

  it("standalone: a plain-function ancestor is not poisoned", async () => {
    expect(await runStandalone(FNCTOR_SOURCE, "probe", "issue-5195-r3-fnctor.js")).toBe(1);
  });

  it("host lane agrees that the function ancestor does not throw", () => {
    expect(runHost(FNCTOR_SOURCE, "probe")).toBe(true);
  });
});
