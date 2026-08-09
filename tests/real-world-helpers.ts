import { compile, type CompileOptions, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * Shared helpers for the `real-world-*.test.ts` suites (#1575-adjacent).
 *
 * These tests cover code patterns that test262 (the ECMAScript conformance
 * suite) does **not** exercise: ES module import/export wiring, host Web APIs
 * (`fetch`, `URL`, `TextEncoder`, …), runtime APIs (WASI / Node / Deno), and
 * popular frameworks (Hono, React, Express). The point is to lock in that
 * idiomatic real-world source *compiles to a valid Wasm module* and wires up
 * the expected host-import boundary — not to re-run the JS engine semantics
 * that test262 already covers.
 *
 * This module deliberately does NOT import `vitest`, so it can be imported
 * from any test file (and re-used from probes) without tripping vitest's
 * "internal state" guard.
 */

/** Compile real-world TS source with a `.ts` virtual filename (enables the
 *  npm/Node import-resolver paths). Returns the raw {@link CompileResult}. */
export function compileReal(source: string, opts: CompileOptions = {}): Promise<CompileResult> {
  return compile(source, { fileName: "test.ts", ...opts });
}

/** Compile and assert the module is producible and the binary validates.
 *  Throws with the compiler diagnostics on failure so the test message is
 *  actionable. Returns the {@link CompileResult} for further assertions on
 *  `.wat` / `.imports`. */
export async function compileValid(source: string, opts: CompileOptions = {}): Promise<CompileResult> {
  const result = await compileReal(source, opts);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  if (!WebAssembly.validate(result.binary)) {
    throw new Error(`WebAssembly.validate() rejected the binary\nWAT:\n${result.wat}`);
  }
  return result;
}

/** Names of the host (`env.*`) imports the module requests — handy for
 *  asserting that a real-world snippet lowered to the expected host boundary
 *  (e.g. `fetch` -> `env.fetch`, `crypto.randomUUID()` -> `env.__crypto_random_uuid`). */
export function hostImportNames(result: CompileResult): string[] {
  return (result.imports ?? []).filter((i) => i.module === "env").map((i) => i.name);
}

/** Compile, instantiate with the faithful runtime host imports, and return
 *  the exports. `deps` supplies host globals (e.g. `{ crypto }`, a mock
 *  `document`) that the runtime resolves opaque externref calls against. */
export async function instantiate(
  source: string,
  deps: Record<string, unknown> = {},
  opts: CompileOptions = {},
): Promise<Record<string, Function>> {
  const result = await compileValid(source, opts);
  const imports = buildImports(result.imports, deps, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setInstance?.(instance);
  return instance.exports as Record<string, Function>;
}
