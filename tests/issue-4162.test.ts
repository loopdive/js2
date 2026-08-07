// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4162) LANE PARITY FOR THE IMPORT OBJECT.
//
// The defect this pins
// --------------------
// Three lanes execute a compiled test262 module: the sharded CI fork worker
// (`scripts/test262-worker.mjs`), the in-process fixture-graph lane
// (`tests/test262-shared.ts`), and `runTest262File`
// (`tests/test262-runner.ts` — used by `scripts/validate-test262-baseline.ts`,
// `scripts/detect-vacuity.ts`, `scripts/harness-flip-probe.ts` and every ad-hoc
// A/B measurement).
//
// Only the worker attached the `js2wasm:runtime-eval` namespace. So under the
// in-process runner any standalone module linking that namespace died at
// instantiation with
//
//     TypeError: WebAssembly.instantiate(): Import #0 module="js2wasm:runtime-eval":
//                module is not an object or function
//
// Why that is worse than "some tests fail": the link error OVERWRITES the
// test's real signature. A descriptor test that would have reported
// `Test262Error: Expected obj[0] to be writable` reports a link failure
// instead, so every bucket histogram, cluster label and A/B built on this lane
// measures the instrument's own gap and attributes it to the compiler.
//
// The trigger is broad rather than exotic, though NOT for the reason #4162
// first recorded. It is not `propertyHelper.js:31`'s
// `Function.prototype.call.bind(...)` — that construct compiles to zero
// imports, because `isGlobalFunctionValueReference` excludes a property-access
// parent. It is the runner's OWN `$262.evalScript` shim, `return
// eval(sourceText)`, which `assembleOriginalHarness` emits into every test.
// Measured on the L2 lever list: 82 of 162 files (exactly the count three
// independent agents reported on 2026-08-06, alongside 44/152 on a second lever
// and a third uncounted hit).
//
// This was the THIRD instance of one drift class (#3441 sandbox globals, #3613
// exception renderer — both since unified), so the remedy is structural: ONE
// shared `scripts/test262-import-object.mjs` that every lane calls, plus the
// routing guard below, rather than three copies kept in sync by discipline.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import {
  RUNTIME_EVAL_IMPORT_MODULE,
  buildRuntimeEvalRefusalProviderSource,
  computeCompilerBundleHash,
  defaultRuntimeEvalProviderCacheDir,
  readCachedRuntimeEvalProvider,
  runtimeEvalProviderCacheKey,
  runtimeEvalRefusalCachePath,
  writeCachedRuntimeEvalProvider,
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
} from "../scripts/runtime-eval-provider.mjs";
import {
  instantiateTest262Module,
  resetTest262RuntimeEvalProviderForTest,
  test262ImportNamespaceNames,
} from "../scripts/test262-import-object.mjs";
import { handleNegativeTest, parseMeta, runTest262File } from "./test262-runner.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";

const REPO_ROOT = join(__dirname, "..");
const HARNESS_AVAILABLE = existsSync(join(REPO_ROOT, "test262", "harness", "propertyHelper.js"));
if (!HARNESS_AVAILABLE && process.env.CI) {
  throw new Error("#4162: test262 harness inputs missing under CI — this file must not silently skip.");
}

/**
 * Reduced to the actual trigger: a first-class read of the global `Function`
 * VALUE (`isGlobalFunctionValueReference`, src/codegen/index.ts). Nothing here
 * calls dynamic code, which is the whole point — the import is MODULE-LEVEL, so
 * merely mentioning the boundary costs the file every assertion it has when the
 * namespace is unsupplied.
 *
 * Note for anyone re-deriving this: `Function.prototype.call.bind(...)` — the
 * construct #4162 originally named as the trigger, from propertyHelper.js:31 —
 * does NOT trip it. `isGlobalFunctionValueReference` explicitly excludes the
 * property-access parent. The real trigger in the assembled harness is the
 * runner's own `$262.evalScript` shim (`return eval(sourceText)`), which is
 * emitted for every test; the value form below is the smallest standalone
 * reproduction of the same module-level import.
 */
const RUNTIME_EVAL_LINKING_SOURCE = `
  var F: any = Function;
  export function probe(): number {
    return typeof F === "function" ? 42 : -1;
  }
`;

async function compileStandalone(source: string, fileName: string): Promise<Uint8Array> {
  const r = await compile(source, { target: "standalone", fileName, skipSemanticDiagnostics: true });
  expect(r.success, (r.errors ?? []).map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  return r.binary!;
}

/**
 * Make the refusal provider available in the shared cache, compiling it if the
 * prebuild step has not run in this checkout. Cache-keyed and idempotent — the
 * same write `scripts/build-runtime-eval-provider.mjs --refusal-only` performs.
 */
async function ensureRefusalProviderCached(): Promise<void> {
  const source = buildRuntimeEvalRefusalProviderSource();
  const key = runtimeEvalProviderCacheKey(source, computeCompilerBundleHash());
  const dir = defaultRuntimeEvalProviderCacheDir();
  if (readCachedRuntimeEvalProvider(dir, key, runtimeEvalRefusalCachePath)) return;
  const r = await compile(source, RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS);
  expect(r.success, "refusal provider must compile").toBe(true);
  writeCachedRuntimeEvalProvider(dir, key, r.binary!, runtimeEvalRefusalCachePath);
  resetTest262RuntimeEvalProviderForTest();
}

describe("#4162 the shared import object supplies js2wasm:runtime-eval", () => {
  it(
    "a runtime-eval-linking standalone module is unlinkable bare and linkable through the shared seam",
    { timeout: 600_000 },
    async () => {
      const binary = await compileStandalone(RUNTIME_EVAL_LINKING_SOURCE, "runtime-eval-linking.ts");
      const wasmModule = new WebAssembly.Module(binary);

      // Reading the global `Function` — and nothing else — is enough to carry
      // the module-level import. If this stops holding the lever is gone and
      // the rest of this file proves nothing.
      expect(WebAssembly.Module.imports(wasmModule).map((i) => i.module)).toContain(RUNTIME_EVAL_IMPORT_MODULE);

      // CONTROL: the failure being fixed is real, and it is an instantiation
      // artifact — the module never runs, so its own assertions never report.
      expect(() => new WebAssembly.Instance(wasmModule, {})).toThrow(/js2wasm:runtime-eval/);

      await ensureRefusalProviderCached();
      const imports: Record<string, unknown> = {};
      const instance = await instantiateTest262Module(binary, imports, { target: "standalone" });
      // The REAL value, not merely "did not throw": the module ran.
      expect((instance.exports as Record<string, () => number>).probe()).toBe(42);
      expect(Object.keys(imports)).toContain(RUNTIME_EVAL_IMPORT_MODULE);
    },
  );

  it("both lanes derive the SAME namespace set from the same binary", { timeout: 600_000 }, async () => {
    await ensureRefusalProviderCached();
    const binary = await compileStandalone(RUNTIME_EVAL_LINKING_SOURCE, "runtime-eval-linking.ts");

    // Two independently constructed base import objects — standing in for the
    // worker's and the in-process runner's — must end up supplying the same
    // namespaces for one binary. This is the assertion that would have caught
    // the drift.
    const workerLike = test262ImportNamespaceNames(binary, {}, { providerLabel: "test262-worker" });
    const inProcessLike = test262ImportNamespaceNames(binary, {}, { providerLabel: "test262-in-process" });
    expect(inProcessLike).toEqual(workerLike);
    expect(workerLike).toContain(RUNTIME_EVAL_IMPORT_MODULE);
  });

  it("host-lane binaries are untouched — no namespace is invented for them", async () => {
    const r = await compile(`export function probe(): number { return 7; }`, { fileName: "host.ts" });
    expect(r.success).toBe(true);
    const imports = buildImports(r.imports, undefined, r.stringPool) as unknown as Record<string, unknown>;
    const instance = await instantiateTest262Module(r.binary!, imports, { target: undefined });
    expect((instance.exports as Record<string, () => number>).probe()).toBe(7);
    expect(Object.keys(imports)).not.toContain(RUNTIME_EVAL_IMPORT_MODULE);
  });
});

describe("#4162 every test262 lane routes through the one shared seam", () => {
  // Structural, because behavioural parity between lanes that already share an
  // implementation is tautological. What actually prevents a FOURTH instance of
  // this drift class is that a lane cannot grow its own instantiate again.
  const LANES = ["scripts/test262-worker.mjs", "tests/test262-shared.ts", "tests/test262-runner.ts"] as const;

  it.each(LANES)("%s imports the shared import-object module", async (lane) => {
    const src = await readFile(join(REPO_ROOT, lane), "utf8");
    expect(src).toMatch(/from "(\.\.\/scripts|\.)\/test262-import-object\.mjs"/);
  });

  it.each(LANES)("%s never calls WebAssembly.instantiate on a test binary itself", async (lane) => {
    const src = await readFile(join(REPO_ROOT, lane), "utf8");
    const offenders = src
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      // Comments are allowed to name the API; only live calls are the hazard.
      .filter(([, line]) => /(?:^|[^.\w])WebAssembly\.instantiate\s*\(/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));
    expect(offenders.map(([n, l]) => `${lane}:${n}: ${l.trim()}`)).toEqual([]);
  });
});

describe("#4162 handleNegativeTest no longer passes vacuously", () => {
  // Found while fixing the above, same defect class: the parse/early/resolution
  // branch referenced an UNBOUND `target` identifier while building its compile
  // options, inside the `try` whose `catch` reports `status: "pass"`. The
  // ReferenceError was laundered into a conformance pass for EVERY test on that
  // branch, without compiling anything.
  it("scores valid code as a FAIL and actually compiles it", async () => {
    const meta = parseMeta("/*---\nnegative:\n  phase: parse\n  type: SyntaxError\n---*/\nvar x = 1;\n");
    const r = await handleNegativeTest("var x = 1;", meta, "probe.js", "probe");
    restoreHostBuiltins();
    expect(r).not.toBeNull();
    // Valid code compiles ⇒ the expected SyntaxError never happened ⇒ fail.
    expect(r!.status).toBe("fail");
    // And the verdict is EARNED: a vacuous pass reported compileMs ≈ 0.05
    // because the throw happened before `compile()` was ever called.
    expect(r!.timing!.compileMs).toBeGreaterThan(1);
  });

  it("still passes genuinely invalid syntax", async () => {
    const meta = parseMeta("/*---\nnegative:\n  phase: parse\n  type: SyntaxError\n---*/\nvar var var;\n");
    const r = await handleNegativeTest("var var var;", meta, "probe.js", "probe");
    restoreHostBuiltins();
    expect(r!.status).toBe("pass");
  });
});

const runIfHarness = HARNESS_AVAILABLE ? describe : describe.skip;

runIfHarness("#4162 end-to-end: runTest262File reports the real status", () => {
  const CASES = ["test/built-ins/Array/prototype/push/length.js", "test/built-ins/Array/prototype/push/prop-desc.js"];

  it.each(CASES)("%s does not die at instantiate", { timeout: 600_000 }, async (rel) => {
    await ensureRefusalProviderCached();
    const full = join(REPO_ROOT, "test262", rel);
    const r = await runTest262File(full, "built-ins", 30_000, "standalone");
    restoreHostBuiltins();
    // Whether the test passes is the compiler's business and will change. What
    // must never come back is the instrument reporting its own link failure in
    // place of the test's verdict.
    expect(`${r.status}: ${r.error ?? ""}`).not.toMatch(/js2wasm:runtime-eval/);
  });
});
