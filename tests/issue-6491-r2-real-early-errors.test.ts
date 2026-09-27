// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6491 round 2 — five ECMA-262 early-error rules the compiler did not enforce.
//
// Round 1 established that 34 of the 36 `negative: {phase: parse|early}` rows in
// the parity bucket are honest-lane FALSE PASSES: the compiler detects none of
// them, and the honest whole-assembly only carries an
// `IR path failed for $DONOTEVALUATE … [IR-FALLBACK]` WARNING that the worker's
// lenient arm scores as a SyntaxError detection. The body-only linked unit has
// no such warning, so it fails. The only real fix is to detect the errors, so
// BOTH lanes pass for the right reason — which is what this file pins.
//
// Every case is a PAIR: the violating source must be rejected, and a sibling
// that is legal under the same rule must stay clean. The positive halves are
// the point — each rule here is gated on a goal or a context, and a rule that
// fires one notch too wide breaks valid product code rather than a test row.
//
// Measured with the real runner over the 36 rows: linked 1 → 21 pass, honest
// 36 → 36 (unchanged verdicts, now for the right reason — see the issue's
// Round 2 section for the honest `result.errors` evidence).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ts } from "../src/ts-api.js";
import { detectEarlyErrors } from "../src/compiler/early-errors/index.js";
import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6491-r2-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

/** Errors (not warnings) the early-error pass reports for a source. */
function errorsFor(source: string, moduleGoal = false): string[] {
  const sf = ts.createSourceFile("t.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return detectEarlyErrors(sf, { moduleGoal })
    .filter((e) => e.severity !== "warning")
    .map((e) => e.message);
}

const rejects = (source: string, moduleGoal = false): boolean => errorsFor(source, moduleGoal).length > 0;

describe("#6491 r2 — module code is strict (§11.2.2)", () => {
  it("applies strict-mode rules at a module top level with no directive", () => {
    // `early-strict-mode.js`: `public` is a FutureReservedWord in strict code.
    expect(rejects("var public;", true)).toBe(true);
    // …and stays legal in a Script, which is the whole reason `isStrictMode`
    // refused to infer strictness from the module indicator.
    expect(rejects("var public;", false)).toBe(false);
  });

  it("rejects an ImportedBinding named eval/arguments, but not the export's name", () => {
    // `early-import-{as-,}{eval,arguments}.js` — an ImportedBinding is a
    // BindingIdentifier (§16.2.2) and module code is strict.
    expect(rejects('import { eval } from "./m.js";', true)).toBe(true);
    expect(rejects('import { arguments } from "./m.js";', true)).toBe(true);
    expect(rejects('import { x as eval } from "./m.js";', true)).toBe(true);
    expect(rejects('import eval from "./m.js";', true)).toBe(true);
    expect(rejects('import * as arguments from "./m.js";', true)).toBe(true);
    // The OTHER module's export name may be anything — only the local binding
    // is a BindingIdentifier.
    expect(rejects('import { eval as ok } from "./m.js";', true)).toBe(false);
    expect(rejects('import { x as ok } from "./m.js";', true)).toBe(false);
  });
});

describe("#6491 r2 — `let` as a BindingIdentifier in strict code (§13.1.1)", () => {
  it("rejects `let` as a name in strict code and as a class name anywhere", () => {
    expect(rejects('"use strict"; var let = 1;')).toBe(true);
    // A class's name is always strict code, directive or not.
    expect(rejects("class let {}")).toBe(true);
    expect(rejects("var C = class let {};")).toBe(true);
    // Sloppy Script: `var let` is legal.
    expect(rejects("var let = 1;")).toBe(false);
  });

  it("leaves `let` declarations and property names alone", () => {
    // A `let` DECLARATION is a keyword, never an Identifier node.
    expect(rejects('"use strict"; let x = 1; x = 2;')).toBe(false);
    expect(rejects('"use strict"; var o = { let: 1 }; o.let = 2;')).toBe(false);
  });
});

describe("#6491 r2 — an accessor's own `use strict` prologue", () => {
  it("makes the accessor body strict code", () => {
    // `{getter,setter}-body-strict-inside.js`: the body IS strict, so `public`
    // is reserved there.
    expect(rejects('void { get x() { "use strict"; public = 42; } };')).toBe(true);
    expect(rejects('void { set x(v) { "use strict"; public = 42; } };')).toBe(true);
    // Without the directive the accessor body is sloppy and `public` is a name.
    expect(rejects("void { get x() { public = 42; } };")).toBe(false);
  });
});

describe("#6491 r2 — `await` inside a non-async function in a Module", () => {
  it("rejects it one function deep, where the old depth-2 heuristic did not", () => {
    expect(rejects("function fn() { await 0; }", true)).toBe(true);
    expect(rejects("function fn(x = await 1) { return x; }", true)).toBe(true);
    expect(rejects("0, function () { await 1; };", true)).toBe(true);
  });

  it("keeps top-level await and async functions legal", () => {
    // No enclosing function: this is top-level await, the fixture's premise.
    expect(rejects("await 1;", true)).toBe(false);
    expect(rejects("async function fn() { await 1; }", true)).toBe(false);
    expect(rejects("(async () => { await 1; })();", true)).toBe(false);
  });
});

describe("#6491 r2 — a MetaProperty is never an assignment target (§13.15.1)", () => {
  it("rejects import.meta in every destructuring position", () => {
    expect(rejects("[import.meta] = [];", true)).toBe(true);
    expect(rejects("[...import.meta] = [];", true)).toBe(true);
    expect(rejects("({a: import.meta} = {});", true)).toBe(true);
    expect(rejects("({...import.meta} = {});", true)).toBe(true);
  });

  it("leaves ordinary destructuring patterns alone", () => {
    expect(rejects("[a, b] = [];", true)).toBe(false);
    expect(rejects("[a = 1, ...rest] = [];", true)).toBe(false);
    expect(rejects("({x, y: z, ...rest} = {});", true)).toBe(false);
    expect(rejects("[o.p, o[k]] = [];", true)).toBe(false);
  });
});

describe("#6491 r2 — LexicallyDeclaredNames ∩ VarDeclaredNames in a Module (§16.2.1.1)", () => {
  it("rejects a top-level function colliding with a `var` of the same name", () => {
    // `parse-err-hoist-lex-{fun,gen}.js`. Order-independent, and a `var` nested
    // in a block still contributes a VarDeclaredName.
    expect(rejects("var f; function f() {}", true)).toBe(true);
    expect(rejects("var g; function* g() {}", true)).toBe(true);
    expect(rejects("function f() {} var f;", true)).toBe(true);
    expect(rejects("{ var f; } function f() {}", true)).toBe(true);
  });

  it("keeps the Script rule intact — there a top-level function is var-scoped", () => {
    expect(rejects("var f; function f() {}", false)).toBe(false);
    expect(rejects("function f() {} var f;", false)).toBe(false);
    // A `var` inside a nested FUNCTION is a different var scope.
    expect(rejects("function outer() { var f; } function f() {}", true)).toBe(false);
  });
});

describe("#6491 r2 — the same rules fire on the LINKED body-only unit", () => {
  // The bucket exists because the linked unit is compiled on its own, so the
  // rules have to reach it through `compileHarnessLinkedBody`, not only through
  // the single-source path the unit cases above exercise.
  async function linkedErrors(body: string, moduleGoal: boolean): Promise<string[]> {
    const source = `/*---\ndescription: r2\n---*/\n${body}`;
    const assembly = assembleLinkedHarness(source, parseMeta(source));
    const provider = await buildHarnessProvider({
      harnessPrefix: assembly.harnessPrefix,
      cacheDir: CACHE,
      compileOptions: { allowJs: true, emitWat: false, skipSemanticDiagnostics: true },
    });
    const result = await compileHarnessLinkedBody(provider, assembly.primary.body, {
      allowJs: true,
      fileName: "test.js",
      emitWat: false,
      skipSemanticDiagnostics: true,
      enforceJsEarlyErrors: true,
      inferModuleStrictArguments: moduleGoal,
      strict: assembly.primary.strict,
    } as never);
    return (result.errors ?? []).filter((e) => e.severity !== "warning").map((e) => e.message);
  }

  it("rejects a module-goal violation and accepts its legal sibling", async () => {
    expect((await linkedErrors("var public;", true)).length).toBeGreaterThan(0);
    expect(await linkedErrors("var publicish;", true)).toEqual([]);
  }, 600_000);

  it("rejects `class let {}` on the linked unit too", async () => {
    expect((await linkedErrors("class let {}", false)).length).toBeGreaterThan(0);
    expect(await linkedErrors("class Ok {}", false)).toEqual([]);
  }, 600_000);
});
