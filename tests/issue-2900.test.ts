// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2900 — the in-process FIXTURE lane must defer top-level init, like every
// other execution lane.
//
// The issue was filed as "module indirect default-export binding update returns
// wrong value" and closed on 2026-07-02 by the #2930/#2931/#2932 stack. That
// module-binding work is CORRECT — but the target test still failed, with a
// completely different error:
//
//     test/language/module-code/eval-gtbndng-indirect-update-dflt.js
//     fail — TypeError: sameValue is not a function   (reached_test: false)
//
// Root cause: `tests/test262-shared.ts`'s multi-module FIXTURE branch compiled
// WITHOUT `deferTopLevelInit`, so the whole original-harness assembly ran in the
// wasm `(start)` section — i.e. BEFORE `setExports(instance.exports)` wired the
// runtime. `assert` is a FUNCTION object and `assert.sameValue` is an own
// property assigned onto it; those reads need the wired runtime, so every
// `assert.*` call in a fixture test threw "… is not a function" and the test
// body was never reached. The 204 fixture-graph tests were the ONLY lane still
// running undeferred: `scripts/test262-worker.mjs` defers on both its
// single-file and its fixture-graph path, and the FYI runner defers too (#3505).
//
// The historical reason for the omission — compileMulti emitting a SECOND
// `__module_init` export (V8 "Duplicate export name '__module_init'", the
// #2835/#2839 queue park) — was fixed by #3505, which made the progressively
// accumulated dependency-order initializers retain only the FINAL export.
//
// Measured effect of deferring: 31 fail→pass, 0 pass→fail, identical
// compile_error set across all 204 fixture-graph tests.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { parseMeta, createTestSandbox } from "./test262-runner.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { discoverFixtureGraph } from "../scripts/test262-fixture-graph.mjs";

const ROOT = join(__dirname, "..");
const TEST262_ROOT = join(ROOT, "test262");

/**
 * Compile + run a test262 fixture-graph test with the EXACT recipe the
 * in-process FIXTURE branch of `tests/test262-shared.ts` uses. `defer` is the
 * one knob under test. Completing the literal harness assembly without throwing
 * IS the conformance verdict, so this returns the thrown error or null.
 */
async function runFixtureTest(rel: string, defer: boolean): Promise<string | null> {
  const filePath = join(TEST262_ROOT, rel);
  const source = readFileSync(filePath, "utf-8");
  const meta = parseMeta(source);
  const assembly = assembleOriginalHarness(source, meta);
  const graph = discoverFixtureGraph(rel.replace(/^test\//, ""), source);
  expect(Object.keys(graph.fixtureFiles).length).toBeGreaterThan(0);
  const result = await compileMulti(
    { ...graph.fixtureFiles, [graph.entryFile]: assembly.primary.source },
    graph.entryFile,
    {
      skipSemanticDiagnostics: true,
      inferModuleStrictArguments: true,
      allowJs: true,
      ...(defer ? { deferTopLevelInit: true } : {}),
    } as never,
  );
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const logs: string[] = [];
  const consoleProxy = {
    log: (...v: unknown[]) => logs.push(v.map(String).join(" ")),
    error: (...v: unknown[]) => logs.push(v.map(String).join(" ")),
    warn: () => {},
  };
  const imports = buildImports(result.imports, { console: consoleProxy } as unknown as never, result.stringPool, {
    globalSandbox: createTestSandbox(consoleProxy as unknown as Console),
  } as never);
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
    (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
      instance.exports as Record<string, Function>,
    );
    const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
    if (typeof moduleInit === "function") (moduleInit as () => void)();
    return null;
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

describe("#2900 — fixture lane defers top-level init", () => {
  it("the shared runner's FIXTURE compile passes deferTopLevelInit", () => {
    const shared = readFileSync(join(ROOT, "tests/test262-shared.ts"), "utf-8");
    const fixtureCall = shared.slice(
      shared.indexOf("const multiCompile = await getCompileMulti();"),
      shared.indexOf("const compileRecordMetadata"),
    );
    expect(fixtureCall.length).toBeGreaterThan(0);
    expect(fixtureCall).toContain("deferTopLevelInit: true");
    // The `.js` fixture roots must still reach codegen (#2932).
    expect(fixtureCall).toContain("allowJs: !isNegative");
  });

  it("the target test passes — and fails without the defer", async () => {
    const rel = "test/language/module-code/eval-gtbndng-indirect-update-dflt.js";
    // The regression this issue was reopened for: `assert.sameValue` unreadable
    // because the harness ran before setExports.
    expect(await runFixtureTest(rel, false)).toContain("sameValue is not a function");
    // With the defer, the test's own module-binding assertions
    // (`assert.sameValue(val(), 1)` / `assert.sameValue(val, 2)`) are actually
    // reached — and they pass, which is what proves #2930/#2931/#2932 were
    // right all along.
    expect(await runFixtureTest(rel, true)).toBeNull();
  }, 180_000);

  it("deferring emits exactly one __module_init export (the #2835/#2839 park)", async () => {
    const rel = "test/language/module-code/eval-gtbndng-indirect-update-dflt.js";
    const source = readFileSync(join(TEST262_ROOT, rel), "utf-8");
    const assembly = assembleOriginalHarness(source, parseMeta(source));
    const graph = discoverFixtureGraph(rel.replace(/^test\//, ""), source);
    const result = await compileMulti(
      { ...graph.fixtureFiles, [graph.entryFile]: assembly.primary.source },
      graph.entryFile,
      {
        skipSemanticDiagnostics: true,
        inferModuleStrictArguments: true,
        allowJs: true,
        deferTopLevelInit: true,
      } as never,
    );
    expect(result.success).toBe(true);
    // A duplicate export would make WebAssembly.compile itself reject.
    const module = await WebAssembly.compile(result.binary as unknown as BufferSource);
    const initExports = WebAssembly.Module.exports(module).filter((e) => e.name === "__module_init");
    expect(initExports).toHaveLength(1);
  }, 120_000);
});
