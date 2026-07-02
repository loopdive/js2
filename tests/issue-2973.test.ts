// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2973 — eval-shim sub-compiles must opt out of JS2WASM_IR_FIRST.
//
// The dynamic eval path (`runtime-eval.ts`) compiles eval strings in-process
// as `export function __eval_result() { return (<src>); }` — a claimable
// top-level FunctionDeclaration. That sub-compile inherited the ambient
// `JS2WASM_IR_FIRST=1` env flag: the wrapper's legacy body was skipped
// (#2138), a claim-partial residual in the eval'd expression hard-errored
// post-claim (fail-loud, correct), but the shim's `catch`/`!success` arms
// treat compile failure as a recoverable fast-path miss and swallowed it —
// yielding `undefined` instead of the eval result. This was the ONLY silent
// fail-loud violation in #2138's full Slice-3 measurement (test262
// S12.4_A2_T2: expected 7, got undefined).
//
// Fix under test: `CompileOptions.disableIrFirst` (threaded through
// buildCodegenOptions → CodegenOptions → generateModule's irFirst gate),
// set by both eval-shim compileSourceSync sites. Structural, options-based —
// no ambient env mutation.
import { describe, expect, it, vi } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// `x` arrives as a runtime PARAM so the eval must take the DYNAMIC path
// (runtime-eval.ts sub-compile) — a literal/const arg could be folded by the
// compile-time eval-inline fast path (#2923) and never exercise the shim.
// The expression mirrors test262 S12.4_A2_T2: 5+1|(0===0) → 6|1 → 7, with a
// mixed f64/i32 `|` that is a claim-partial residual in the IR — exactly the
// shape that hard-errors post-claim on a skipped slot.
const SRC = `
export function test(x: string): number {
  return eval(x) as number;
}
`;

async function runEval(irFirst: boolean): Promise<unknown> {
  vi.stubEnv("JS2WASM_IR_FIRST", irFirst ? "1" : "");
  try {
    const r: CompileResult = await compile(SRC, { fileName: "issue-2973.ts" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    // The eval SUB-compile happens here, at call time — still under the
    // stubbed env, which is the point: the shim must opt out on its own.
    return (instance.exports as Record<string, Function>).test!("5+1|0===0");
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("#2973 eval sub-compile opts out of JS2WASM_IR_FIRST", () => {
  it("flag OFF: dynamic eval returns 7 (S12.4_A2_T2 shape)", async () => {
    expect(await runEval(false)).toBe(7);
  });

  it("flag ON: dynamic eval STILL returns 7 — no silent undefined", async () => {
    // Pre-fix this returned undefined (sub-compile inherited the flag, the
    // skipped-slot hard error was swallowed by the shim's catch arms).
    expect(await runEval(true)).toBe(7);
  });

  it("flag ON equals flag OFF for the statement-form wrapper too", async () => {
    const stmtSrc = `
export function test(x: string): number {
  eval(x);
  return 1;
}
`;
    for (const on of [false, true]) {
      vi.stubEnv("JS2WASM_IR_FIRST", on ? "1" : "");
      try {
        const r = await compile(stmtSrc, { fileName: "issue-2973.ts" });
        expect(r.success).toBe(true);
        const imports = buildImports(r.imports, undefined, r.stringPool);
        const { instance } = await WebAssembly.instantiate(r.binary, imports);
        imports.setExports?.(instance.exports as Record<string, Function>);
        // `var y = 5+1|0===0` is statement-form (eval → undefined) — must
        // not throw or diverge under the flag.
        expect((instance.exports as Record<string, Function>).test!("var y = 5+1|0===0")).toBe(1);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });
});
