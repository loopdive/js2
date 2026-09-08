// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5335) The module-init pass-2 skip must not answer a number nobody wrote.
//
// `console.log(outer()()())` over two nested closures printed **0** instead of
// **3** on `main` from 2026-09-02 to 2026-09-05. It compiled, it validated, it
// did not trap. PR #5450 (#3523 gap-1b) began skipping the module-init pass-2
// recompile for populations that are call-bearing and closure-free — and judged
// "closure-free" on the population's OWN SYNTAX. `console.log(outer()()())`
// carries no closure syntax; `outer` mints two when called.
//
// Between the passes the compiler lifts the closures out of `outer`'s body into
// `ctx.closureInfoByTypeIdx`. That map is exactly what
// `matchClosureInfoBySignature` iterates to lower a call whose CALLEE is a
// value. At pass 1 it was empty, the "CallExpression as callee" arm in
// `call-tail-dispatch.ts` matched nothing, and the lowering fell through to a
// tail that evaluates both calls and pushes `ref.null extern` — which unboxes
// to 0. Pass 2 would have lowered a `call_ref`; pass 2 was skipped.
//
// Every assertion here therefore pins a VALUE. A test that only asserted "no
// trap" would have been green throughout the regression.
//
// Two things this file is deliberately shaped to prove:
//
//  * **The defect is not about nesting depth and not about direct callees.**
//    The one-level `mk()()` is wrong the same way (the issue report guessed it
//    was fine; measured on the parent commit, it prints 0 too), and the two-
//    and three-hop cases stay wrong when the DIRECT callee is syntactically
//    closure-free. That is what rules out the cheap "refuse on a call to a
//    local function whose own body mints a closure" repair.
//  * **The fast path was fixed, not deleted.** The last case pins that a
//    call-bearing, closure-free population in a module that lifts no closures
//    still reads `pass1=1, pass2=0`.
//
// Sources are untyped `.js` on purpose. Annotating them (`const v: any = …`)
// routes the call through a different arm of the dispatcher that never
// consulted the closure registry, and the whole file then passes identically
// with the fix reverted.

import { afterEach, describe, expect, it } from "vitest";

import { getCompileProfile, refreshCompileProfileConfig, resetCompileProfile } from "../src/compile-profile.js";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// Register the statement/expression delegates used by generateModule.
import "../src/codegen/expressions.js";

const PROFILE_ENV = "JS2WASM_COMPILE_PROFILE";
const FORCE_PASS2_ENV = "JS2WASM_TEST_FORCE_MODULE_INIT_PASS2";

const originalProfileMode = process.env[PROFILE_ENV];

afterEach(() => {
  if (originalProfileMode === undefined) Reflect.deleteProperty(process.env, PROFILE_ENV);
  else process.env[PROFILE_ENV] = originalProfileMode;
  Reflect.deleteProperty(process.env, FORCE_PASS2_ENV);
  refreshCompileProfileConfig();
  resetCompileProfile();
});

/**
 * Compile and run top-level code, capturing what `console.log` printed.
 *
 * `deferTopLevelInit` exports `__module_init` instead of running the statements
 * from the wasm `start` section, so the host imports are wired before top-level
 * code runs — the same arrangement `scripts/diff-test.ts` uses, which is the
 * harness the original report came from.
 */
async function printedBy(source: string, fileName: string): Promise<string> {
  const result: CompileResult = await compile(source, {
    fileName,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.errors.filter((e) => e.severity === "error").map((e) => e.message)).toEqual([]);
  expect(result.success, `${fileName} compiled`).toBe(true);
  expect(WebAssembly.validate(result.binary), `${fileName} validates`).toBe(true);

  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
  };
  try {
    const built = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
    built.setInstance?.(instance);
    const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
    if (typeof moduleInit === "function") (moduleInit as () => void)();
  } finally {
    console.log = realLog;
  }
  return lines.join("\n");
}

interface Case {
  readonly name: string;
  readonly source: string;
  /** What V8 prints. Re-check with `node` before changing one of these. */
  readonly prints: string;
}

/**
 * Shapes that the pass-2 skip miscompiled. Each was measured on the parent of
 * this fix; the "was" column is what `main` printed on 2026-09-05.
 */
const MISCOMPILED_BEFORE: readonly Case[] = [
  {
    // The reported program, verbatim from `tests/differential/corpus/closures/06-nested.js`.
    // was: 0
    name: "two-level-nesting",
    source: [
      "function outer() {",
      "  let a = 1;",
      "  return function () {",
      "    let b = 2;",
      "    return function () {",
      "      return a + b;",
      "    };",
      "  };",
      "}",
      "console.log(outer()()());",
      "",
    ].join("\n"),
    prints: "3",
  },
  {
    // The issue filed this as a control that "already worked". It did not.
    // was: 0
    name: "one-level-nesting",
    source: [
      "function mk() {",
      "  let a = 7;",
      "  return function () {",
      "    return a + 1;",
      "  };",
      "}",
      "console.log(mk()());",
      "",
    ].join("\n"),
    prints: "8",
  },
  {
    // was: 0 — the closure is minted by an arrow, not a function expression.
    name: "one-level-arrow",
    source: ["function mk() {", "  let a = 7;", "  return () => a + 1;", "}", "console.log(mk()());", ""].join("\n"),
    prints: "8",
  },
  {
    // was: 0 — the DIRECT callee `a` is syntactically closure-free. This is the
    // case that rules out a non-transitive repair.
    name: "two-hop-closure-free-direct-callee",
    source: [
      "function b() { let v = 5; return function () { return v; }; }",
      "function a() { return b(); }",
      "console.log(a()());",
      "",
    ].join("\n"),
    prints: "5",
  },
  {
    // was: 0
    name: "three-hop-closure-free-direct-callee",
    source: [
      "function c() { let v = 6; return function () { return v; }; }",
      "function b() { return c(); }",
      "function a() { return b(); }",
      "console.log(a()());",
      "",
    ].join("\n"),
    prints: "6",
  },
];

/** Shapes that were already correct — they must stay correct. */
const CORRECT_BEFORE: readonly Case[] = [
  {
    // The same closures, reached through module bindings instead of a chained
    // call. The untyped binding routes through the dynamic call ladder, which
    // never consulted the closure registry, so this one was always right.
    name: "nesting-through-module-bindings",
    source: [
      "function outer() {",
      "  let a = 1;",
      "  return function () {",
      "    let b = 2;",
      "    return function () {",
      "      return a + b;",
      "    };",
      "  };",
      "}",
      "var m = outer();",
      "var i = m();",
      "console.log(i());",
      "",
    ].join("\n"),
    prints: "3",
  },
  {
    name: "method-on-returned-object",
    source: ["function mk() { return { v: function () { return 5; } }; }", "console.log(mk().v());", ""].join("\n"),
    prints: "5",
  },
  {
    name: "plain-call-no-closure-anywhere",
    source: ["function f() { return 41; }", "console.log(f() + 1);", ""].join("\n"),
    prints: "42",
  },
];

describe("#5335 — the module-init pass-2 skip must not silently answer 0", () => {
  for (const c of [...MISCOMPILED_BEFORE, ...CORRECT_BEFORE]) {
    it(`prints ${c.prints} for ${c.name}`, async () => {
      expect(await printedBy(c.source, `issue-5335-${c.name}.js`)).toBe(c.prints);
    }, 60_000);
  }

  it("agrees with the unconditional two-pass build on every shape", async () => {
    // The skip's contract is "pass 2 could only reproduce pass 1". Forcing the
    // recompile must therefore change nothing observable. Before the fix this
    // was the WORKAROUND, and the gap between the two columns was the bug.
    for (const c of [...MISCOMPILED_BEFORE, ...CORRECT_BEFORE]) {
      process.env[FORCE_PASS2_ENV] = "1";
      let forced: string;
      try {
        forced = await printedBy(c.source, `issue-5335-forced-${c.name}.js`);
      } finally {
        Reflect.deleteProperty(process.env, FORCE_PASS2_ENV);
      }
      expect(forced, `${c.name} under the forced two-pass build`).toBe(c.prints);
    }
  }, 180_000);

  it("keeps the fast path: a module that lifts no closures still skips pass 2", async () => {
    // The fix must not be "run pass 2 always" wearing a predicate. This
    // population is call-bearing and closure-free, and nothing in the module
    // moves `ctx.closureInfoByTypeIdx` between the passes — so the guard is
    // satisfied and the recompile is still skipped.
    //
    // Measured on this branch when the guard landed: on the 120-program
    // differential corpus the skip fires 105 times before and 97 after
    // (92.4 % retained); across the 651 module-init populations in lodash's
    // 1048 real modules, 579 before and 526 after (90.8 %).
    process.env[PROFILE_ENV] = "1";
    refreshCompileProfileConfig();
    resetCompileProfile();
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean =>
      typeof chunk === "string" && chunk.startsWith("[js2:profile]")
        ? true
        : (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stderr.write;
    let census: { pass1: number; pass2: number };
    let printed: string;
    try {
      printed = await printedBy(
        ["function f() { return 41; }", "var z = f();", "console.log(z + 1);", ""].join("\n"),
        "issue-5335-fast-path-still-fires.js",
      );
      const rows = getCompileProfile();
      const calls = (suffix: string): number =>
        rows
          .filter((row) => row.path === suffix || row.path.endsWith(`/${suffix}`))
          .reduce((sum, row) => sum + row.calls, 0);
      census = { pass1: calls("module-init-pass1"), pass2: calls("module-init-pass2") };
    } finally {
      process.stderr.write = realWrite;
    }
    expect(printed).toBe("42");
    expect(census).toEqual({ pass1: 1, pass2: 0 });
  }, 60_000);

  it("takes the second pass for the shape that needed it", async () => {
    // The counterpart of the census above: the reported program now costs a
    // recompile, and that is the whole price of the fix.
    process.env[PROFILE_ENV] = "1";
    refreshCompileProfileConfig();
    resetCompileProfile();
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean =>
      typeof chunk === "string" && chunk.startsWith("[js2:profile]")
        ? true
        : (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stderr.write;
    let census: { pass1: number; pass2: number };
    try {
      await printedBy(MISCOMPILED_BEFORE[0]!.source, "issue-5335-two-pass-census.js");
      const rows = getCompileProfile();
      const calls = (suffix: string): number =>
        rows
          .filter((row) => row.path === suffix || row.path.endsWith(`/${suffix}`))
          .reduce((sum, row) => sum + row.calls, 0);
      census = { pass1: calls("module-init-pass1"), pass2: calls("module-init-pass2") };
    } finally {
      process.stderr.write = realWrite;
    }
    expect(census).toEqual({ pass1: 1, pass2: 1 });
  }, 60_000);
});
