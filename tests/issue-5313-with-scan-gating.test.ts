// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5313 — the two `with`-target scans in
// `src/codegen/declarations/object-shape-widening.ts` ran UNCONDITIONALLY:
// `markRealmGlobalWithTargets` inside `collectGrowableObjectLiterals`, and the
// `visit` inside `collectRedeclaredWithTargetObjects`. Both exist only to find
// `ts.WithStatement` nodes, and each cost a full pass over the source — 7,838
// of the #3437 harness compile-work budget on a fixture containing no `with`,
// which is ~40 % of the 2026-08-20 → 2026-09-04 drift bisected in #5306.
//
// Both are now gated on the memoized `sourceContainsWithStatement` predicate.
// These tests lock in the three things that can break:
//   • the predicate's soundness — the `sourceFile.text` pre-filter may only
//     ever say "no", never "yes" (`withDefaults()` must NOT read as a `with`),
//   • that the gate is a pure SKIP, not a semantic narrowing — a `with` source
//     still gets both scans and still emits/behaves identically,
//   • that the traversal saving is real and still there.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";
import { ts, enableForEachChildMeter, disableForEachChildMeter, readForEachChildCalls } from "../src/ts-api.js";
import { sourceContainsWithStatement } from "../src/codegen/source-scan-predicates.js";
import { buildRepresentativeAssembly } from "../scripts/check-harness-compile-budget.js";

/** The figure measured on `origin/main` immediately before this change (#5306's rebank). */
const PRE_5313_MEASURED = 150_774;
/** One full pass over the #3437 fixture, per #5306's per-caller attribution. */
const ONE_FIXTURE_PASS = 3_919;

const BUDGET = JSON.parse(readFileSync(resolve(__dirname, "../scripts/harness-compile-budget.json"), "utf-8")) as {
  forEachChildCalls: number;
  marginPct: number;
  fixtureCallSites: number;
};

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile("t.ts", text, ts.ScriptTarget.Latest, true);
}

/** Shared-`forEachChild` invocations performed by `fn`. */
function traversals(fn: () => void): number {
  enableForEachChildMeter();
  try {
    fn();
    return readForEachChildCalls();
  } finally {
    disableForEachChildMeter();
  }
}

async function meterCompile(source: string): Promise<number> {
  enableForEachChildMeter();
  try {
    // The assembly need not compile cleanly — the WORK is what is measured.
    await compile(source, { fileName: "harness-budget-fixture.ts" });
    return readForEachChildCalls();
  } finally {
    disableForEachChildMeter();
  }
}

async function runModule(pre: string, ret: string, target?: "standalone"): Promise<any> {
  const src = `${pre}\nexport function test(): any { return ${ret}; }`;
  const result: any = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    ...(target ? { target } : {}),
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  (instance.exports as any).__module_init?.();
  const exp = wrapExports(instance.exports, { signatures: result.exportSignatures });
  return exp.test();
}

describe("#5313 sourceContainsWithStatement — the AST walk is the authority", () => {
  it("answers false for `with`-shaped identifiers and property names", () => {
    const sf = parse(
      [
        "function withDefaults(o) { return o; }",
        "const withering = { writable: true, withCredentials: false };",
        "const bandwidth = withDefaults(withering);",
        "// a comment mentioning with (o) { } that is not a with statement",
        'const s = "with (o) { }";',
      ].join("\n"),
    );
    expect(sf.text.includes("with")).toBe(true); // the pre-filter says "maybe"
    expect(sourceContainsWithStatement(sf)).toBe(false); // the AST walk says no
  });

  it("answers true for a real `with`, wherever it sits", () => {
    expect(sourceContainsWithStatement(parse("var o = { z: 1 };\nwith (o) { z = 2; }"))).toBe(true);
    expect(sourceContainsWithStatement(parse("function f(o) { with (o) { return z; } }"))).toBe(true);
    expect(sourceContainsWithStatement(parse("var o = {};\nfor (var k in o) { with (o) { p = 1; } }"))).toBe(true);
    expect(sourceContainsWithStatement(parse("var o = {};\nwith ((o) || null) { p = 1; }"))).toBe(true);
  });

  it("costs ZERO traversals when the source has no `with` substring at all", () => {
    const sf = parse("var obj = { a: 1 };\nvar obj = { b: 2 };\nobj.b = 3;");
    expect(sf.text.includes("with")).toBe(false);
    expect(traversals(() => expect(sourceContainsWithStatement(sf)).toBe(false))).toBe(0);
  });

  it("memoizes per source file — a second call re-walks nothing", () => {
    // Deliberately the lookalike: the pre-filter cannot short-circuit it, so
    // the FIRST call must really walk. That is what makes the second call's
    // zero meaningful rather than an artefact of the pre-filter.
    const sf = parse("function withDefaults(o) { return o; }\nconst x = withDefaults({ a: 1 });");
    const first = traversals(() => expect(sourceContainsWithStatement(sf)).toBe(false));
    expect(first).toBeGreaterThan(0);
    const second = traversals(() => expect(sourceContainsWithStatement(sf)).toBe(false));
    expect(second).toBe(0);
  });

  it("memoizes the positive answer too, and short-circuits on the first hit", () => {
    const sf = parse("var o = { z: 1 };\nwith (o) { z = 2; }\n" + "var pad = 1;\n".repeat(200));
    const first = traversals(() => expect(sourceContainsWithStatement(sf)).toBe(true));
    expect(first).toBeGreaterThan(0);
    // Short-circuit: finding the `with` early must not cost a full walk of the
    // 200 trailing statements.
    expect(first).toBeLessThan(50);
    expect(traversals(() => expect(sourceContainsWithStatement(sf)).toBe(true))).toBe(0);
  });
});

describe("#5313 the gate is a pure skip, not a semantic narrowing", () => {
  // The two shapes the gated scans exist for, plus their `with`-free twins.
  const REDECLARED_WITH_TARGET = [
    "var obj: any = { a: 1 };",
    "with (obj) { a = 10; }",
    "var obj: any = { b: 2 };",
    "with (obj) { b = 20; }",
  ].join("\n");
  const WITH_FREE_LOOKALIKE = [
    "function withDefaults(o: any): any { return o; }",
    "const withering = { writable: true };",
    "const bandwidth: any = withDefaults(withering);",
  ].join("\n");

  it.each(["gc", "standalone", "wasi"] as const)("emits deterministic bytes on %s", async (target) => {
    for (const src of [REDECLARED_WITH_TARGET, WITH_FREE_LOOKALIKE]) {
      const a: any = await compile(src + "\nexport function test(): any { return 1; }", {
        fileName: "test.ts",
        skipSemanticDiagnostics: true,
        inferModuleStrictArguments: false,
        target,
      } as any);
      const b: any = await compile(src + "\nexport function test(): any { return 1; }", {
        fileName: "test.ts",
        skipSemanticDiagnostics: true,
        inferModuleStrictArguments: false,
        target,
      } as any);
      expect(a.binary?.length).toBeGreaterThan(0);
      // The predicate memo is keyed on `ts.SourceFile` identity, so a second
      // compile builds a fresh AST and re-answers from scratch. Identical bytes
      // prove the memo introduces no cross-compile order dependence.
      expect(Buffer.from(b.binary).equals(Buffer.from(a.binary))).toBe(true);
    }
  });

  it("still widens a redeclared `with`-target object (standalone)", async () => {
    // The exact shape `collectRedeclaredWithTargetObjects` exists for: one
    // binding, two differently shaped literals, each used as a `with` target.
    // The later literal's key must survive — a skipped scan here would lose it.
    expect(await runModule(REDECLARED_WITH_TARGET, "obj.b", "standalone")).toBe(20);
  });

  it("still executes an ordinary top-level `with` (standalone)", async () => {
    expect(await runModule("var s: any = { z: 9 };\nwith (s) { z = 44; }", "(s as any).z", "standalone")).toBe(44);
  });

  it("does not confuse a `withDefaults` call for a `with` statement", async () => {
    expect(await runModule(WITH_FREE_LOOKALIKE, "bandwidth.writable ? 1 : 0")).toBe(1);
  });
});

describe("#5313 harness compile-work budget", () => {
  it("drops below the pre-#5313 figure and holds the banked budget", async () => {
    const measured = await meterCompile(buildRepresentativeAssembly(BUDGET.fixtureCallSites));
    expect(measured).toBeLessThan(PRE_5313_MEASURED);
    // Two full fixture passes are what the gate refunds.
    expect(PRE_5313_MEASURED - measured).toBeGreaterThanOrEqual(2 * ONE_FIXTURE_PASS);
    expect(measured).toBeLessThanOrEqual(Math.ceil(BUDGET.forEachChildCalls * (1 + BUDGET.marginPct / 100)));
  });

  it("still pays for both scans when the source DOES contain `with`", async () => {
    const free = buildRepresentativeAssembly(BUDGET.fixtureCallSites);
    const withed = free + "var wt = { q: 1 };\nwith (wt) { q = 2; }\n";
    const freeCount = await meterCompile(free);
    const withCount = await meterCompile(withed);
    // Adding one `with` re-admits both gated walks (2 × 3,919) plus the
    // `with`-only analysis downstream. Measured delta 2026-09-04: +20,267.
    expect(withCount - freeCount).toBeGreaterThan(2 * ONE_FIXTURE_PASS);
  });
});
