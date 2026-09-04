// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5195 r3-5 — ES §15.7.14 ClassDefinitionEvaluation step 5f: the superclass
// value is evaluated and `IsConstructor(superclass)` is checked before the
// class object exists. Standalone never performed that check, so
// `class D extends (() => {}) {}` compiled silently as a base class.
//
// Only the IsConstructor half landed; the step 5.g.ii "Get(superclass,
// 'prototype') is neither Object nor Null" half did not — see the issue file.
//
// The PREDICATE is what this file mostly pins. A new throw at class-definition
// time is only safe while it declines every heritage the compiler already
// lowers statically, so each declining shape gets its own control on both
// lanes.
//
// (r3 review F1, 2026-09-04) The predicate is now COMPILE-TIME PROOF ONLY: it
// admits a heritage only when the source shows it cannot be a constructor (a
// literal, an arrow, a generator/async function, a `.bind()` of one of those, a
// `new Proxy` over one of those, or a unique never-written binding of any of
// them). Everything else — a parameter, an alias, a conditional, a call result
// — is DECLINED and keeps the base tree's code. The first cut admitted those
// too and threw unconditionally on them, which broke the mixin-factory idiom;
// see `tests/issue-5195-r3-review.test.ts`.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

/**
 * The six rows r3-5 flips (all `fail` on base `91d4999050`).
 *
 * (r3 review F1, 2026-09-04) Two more rows —
 * `definition/constructable-but-no-prototype.js` and
 * `definition/prototype-setter.js` — were listed here after the first cut, but
 * only ever "passed" because that cut threw on ANY heritage it could not
 * trace. Both use `function () {}.bind()`, which IS a constructor; their
 * TypeError comes from the §15.7.14 step 5.g.ii `prototype` lookup, the half
 * this module deliberately does not implement. They are given back, and fail
 * exactly as they do on base.
 */
const R3_5_ROWS = [
  "language/expressions/class/heritage-arrow-function.js",
  "language/expressions/class/heritage-async-arrow-function.js",
  "language/statements/class/subclass/superclass-arrow-function.js",
  "language/statements/class/subclass/superclass-async-function.js",
  "language/statements/class/subclass/superclass-async-generator-function.js",
  "language/statements/class/subclass/superclass-generator-function.js",
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

describe("#5195 r3-5 — a non-constructor heritage throws TypeError in standalone", () => {
  for (const relativePath of R3_5_ROWS) {
    const file = resolve(process.cwd(), "test262", "test", relativePath);
    it.skipIf(!existsSync(file))(
      `r3-5: ${relativePath} passes in standalone`,
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

  // Three non-constructor shapes, each at a different call site: a nested class
  // DECLARATION (`compileNestedClassDeclaration`), a `var`-bound class
  // EXPRESSION (`variables.ts`, whose splice must put the check AHEAD of the
  // class value's materialization), and a numeric heritage that never reaches
  // an externref at all.
  const THROWS_SOURCE = `
    var arrow = () => {};
    function gen() {}
    export function probe() {
      let n = 0;
      try { class A extends arrow {} } catch (e) { if (e instanceof TypeError) n = n + 1; }
      try { var B = class extends (() => {}) {}; } catch (e) { if (e instanceof TypeError) n = n + 1; }
      try { class C extends 42 {} } catch (e) { if (e instanceof TypeError) n = n + 1; }
      return n === 3;
    }
  `;

  it("standalone: all three non-constructor heritage shapes throw TypeError", async () => {
    expect(await runStandalone(THROWS_SOURCE, "probe", "issue-5195-r3-heritage-throws.js")).toBe(1);
  });
});

describe("#5195 r3-5 — every statically-lowered heritage keeps its lane", () => {
  // `extends null` is legal (§15.7.14 step 5e) and must not throw. A class
  // parent, a plain-function parent and a builtin parent are all declined by
  // the predicate, so they keep exactly the code they had. (The fnctor
  // parent's PROTOTYPE chain — `new G(4).k` reaching `F.prototype.k` — is a
  // separate pre-existing standalone gap, `undefined` on the base tree too, so
  // only the class identity is asserted for it.)
  const DECLINED_SOURCE = `
    class Base { v() { return 7; } }
    function F(a) { this.a = a; }
    export function probe() {
      let ok = 0;
      class N extends null {}
      if (typeof N === "function") ok = ok + 1;
      class D extends Base {}
      if (new D().v() === 7) ok = ok + 1;
      class G extends F {}
      if (typeof G === "function") ok = ok + 1;
      class E extends Error {}
      if (new E("m").message === "m") ok = ok + 1;
      return ok === 4;
    }
  `;

  it("standalone: null, class, function and builtin parents are untouched", async () => {
    expect(await runStandalone(DECLINED_SOURCE, "probe", "issue-5195-r3-heritage-declined.js")).toBe(1);
  });

  it("host lane agrees", () => {
    expect(runHost(DECLINED_SOURCE, "probe")).toBe(true);
  });

  // A CALL heritage must stay DECLINED. `__reflect_is_constructor` does not
  // recognise a compiled class object, so checking `class D extends (pick()) {}`
  // — where `pick()` returns a class — answered "not a constructor" and threw,
  // turning a value the base tree produced into an exception. What this pins is
  // that it does NOT throw; `calls` staying 0 is the base tree's (wrong, but
  // unchanged) answer for a top-level call heritage, and is deliberately not
  // asserted as correct here.
  const CALL_HERITAGE_SOURCE = `
    class Base { v() { return 5; } }
    function pick() { return Base; }
    export function probe() {
      let threw = false;
      try { class D extends (pick()) {} } catch (e) { threw = true; }
      return threw === false;
    }
  `;

  it("standalone: a call heritage is declined, not thrown on", async () => {
    expect(await runStandalone(CALL_HERITAGE_SOURCE, "probe", "issue-5195-r3-heritage-call.js")).toBe(1);
  });

  it("host lane agrees the call heritage does not throw", () => {
    expect(runHost(CALL_HERITAGE_SOURCE, "probe")).toBe(true);
  });
});
