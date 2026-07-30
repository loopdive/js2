// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1855 — Differential runner for generated programs.
 *
 * Runs a generated (UB-free) program through:
 *   - the **V8 reference oracle**: the same TS source evaluated as JS (the
 *     generator's subset is valid JS once the type annotations are stripped),
 *   - the **js2wasm WasmGC backend**: compile + instantiate + call.
 *
 * and reports agreement. Because the generator's output is reference-defined
 * (safe-integer domain, total expressions), any disagreement is a genuine
 * wrong-code bug in the compiler — exactly the signal #1855 exists to surface.
 *
 * The cross-backend (WasmGC vs linear) leg from #1854 is intentionally NOT
 * folded in here: the V8 oracle already pins each backend independently, so
 * oracle-agreement per backend ⇒ cross-backend agreement transitively, and the
 * WasmGC lane is the one the generated numeric subset reliably compiles.
 */
import { compile } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";
import type { GeneratedProgram } from "./generator.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

export type Outcome = "match" | "mismatch" | "compile_error" | "runtime_error" | "oracle_error";

export interface DiffResult {
  readonly outcome: Outcome;
  readonly oracle?: number;
  readonly wasm?: number;
  readonly error?: string;
}

/** Strip TS type annotations to get runnable JS for the V8 oracle. The
 *  generator only emits `: number` param annotations and `: number` returns,
 *  so a narrow strip is exact and avoids pulling in a TS transpiler. */
function toJs(source: string): string {
  return source
    .replace(/export function/g, "function")
    .replace(/: number/g, "")
    .replace(/\bp(\d+): number/g, "p$1");
}

/** Evaluate the program under V8 (the reference oracle). */
function runOracle(program: GeneratedProgram): { value?: number; error?: string } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(`${toJs(program.source)}\nreturn main;`);
    const main = factory() as (...a: number[]) => number;
    const value = main(...program.args);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { error: `oracle produced non-finite ${value}` };
    }
    return { value };
  } catch (e) {
    return { error: `oracle: ${(e as Error).message}` };
  }
}

/** Compile + run the program under the js2wasm WasmGC backend. */
async function runWasm(
  program: GeneratedProgram,
): Promise<{ value?: number; error?: string; phase: "compile" | "runtime" | "ok" }> {
  const r = await compile(program.source, { fileName: `fuzz-${program.seed}.ts` });
  if (!r.success) {
    return { error: `compile: ${r.errors[0]?.message ?? "unknown"}`, phase: "compile" };
  }
  try {
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, {
      env: built.env,
      string_constants: built.string_constants,
    });
    built.setInstance?.(instance);
    const main = (instance.exports as Record<string, unknown>).main;
    if (typeof main !== "function") return { error: "no main export", phase: "runtime" };
    const value = (main as (...a: number[]) => number)(...program.args);
    return { value, phase: "ok" };
  } catch (e) {
    return { error: `runtime: ${(e as Error).message}`, phase: "runtime" };
  }
}

/** Run both lanes and classify the outcome. */
export async function differentialRun(program: GeneratedProgram): Promise<DiffResult> {
  const oracle = runOracle(program);
  if (oracle.error || oracle.value === undefined) {
    // The generator is supposed to be UB-free; an oracle error means a
    // generator bug, not a compiler bug. Surface it distinctly.
    return { outcome: "oracle_error", error: oracle.error };
  }
  const wasm = await runWasm(program);
  if (wasm.error || wasm.value === undefined) {
    return {
      outcome: wasm.phase === "compile" ? "compile_error" : "runtime_error",
      oracle: oracle.value,
      error: wasm.error,
    };
  }
  // Integer-exact comparison (the subset guarantees integral results).
  if (Object.is(oracle.value, wasm.value)) {
    return { outcome: "match", oracle: oracle.value, wasm: wasm.value };
  }
  return { outcome: "mismatch", oracle: oracle.value, wasm: wasm.value };
}
