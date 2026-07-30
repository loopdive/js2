// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1854 — Cross-backend differential testing harness.
 *
 * The `tests/equivalence/` suite compiles-and-runs each program against a V8/TS
 * reference oracle — but only on ONE backend per test. We now have multiple
 * lowering paths (WasmGC `target:"gc"` and linear-memory `target:"linear"`),
 * and nothing asserted they agree with EACH OTHER. A backend-specific lowering
 * bug that produces wrong-but-not-crashing output can pass the single-oracle
 * test on whichever backend it happened to run.
 *
 * This harness closes that gap: every corpus program is compiled to BOTH
 * backends and their exported functions' return values are diffed. Because the
 * WasmGC lane already tracks the V8 oracle (the equivalence suite), agreement
 * between WasmGC and linear is transitively agreement with the oracle — so a
 * divergence here is a genuine cross-backend lowering bug.
 *
 * Observable surface = return value (NOT stdout): the linear backend has no
 * `console.log` host import (it silently drops console output), so its only
 * observable is the function return value — exactly what tests/linear-*.test.ts
 * assert. See tests/cross-backend/corpus.ts for the full rationale.
 *
 * The linear backend is incomplete, so many programs don't compile on it yet.
 * Those are marked `expectLinearUnsupported` and SKIPPED from the diff (the gap
 * is baselined, not gated) — but the harness still asserts they remain
 * unsupported, so the moment linear gains support the flag must be removed
 * (ratchet down). Only programs that compile on BOTH backends are diffed; a
 * divergence fails the test with a per-call repro pointer.
 *
 * Runtime is modest (compile each program twice + invoke a handful of calls),
 * so this runs in the normal vitest suite — no dedicated workflow needed.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";
import { CROSS_BACKEND_CORPUS, type CrossBackendProgram } from "./cross-backend/corpus.js";

type Backend = "gc" | "linear";

interface CompileRun {
  /** false when the backend did not compile the program. */
  ok: boolean;
  /** Compile-error message when `ok` is false. */
  error?: string;
  /** Exported functions, present when `ok`. */
  exports?: Record<string, (...a: unknown[]) => unknown>;
}

/** Compile + instantiate a program on one backend, ready to invoke exports. */
async function run(program: CrossBackendProgram, backend: Backend): Promise<CompileRun> {
  const result = await compile(program.source, backend === "linear" ? { target: "linear" } : {});
  if (!result.success) {
    return { ok: false, error: result.errors[0]?.message ?? "unknown compile error" };
  }
  try {
    if (backend === "linear") {
      // Linear modules are self-contained (no host imports).
      const { instance } = await WebAssembly.instantiate(result.binary);
      return { ok: true, exports: instance.exports as CompileRun["exports"] };
    }
    // WasmGC modules use js-string + host imports built by the runtime helper.
    const built = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
    built.setInstance?.(instance);
    return { ok: true, exports: instance.exports as CompileRun["exports"] };
  } catch (e) {
    return { ok: false, error: `instantiate/runtime: ${(e as Error).message ?? String(e)}` };
  }
}

/** Invoke `call` and capture its return value or a thrown-error marker. */
function invoke(exports: CompileRun["exports"], fn: string, args: readonly (number | boolean)[]): unknown {
  const f = exports?.[fn];
  if (typeof f !== "function") return `<no-export:${fn}>`;
  try {
    return f(...args);
  } catch (e) {
    return `<threw:${(e as Error).message ?? String(e)}>`;
  }
}

describe("#1854 cross-backend differential (WasmGC vs linear)", () => {
  for (const program of CROSS_BACKEND_CORPUS) {
    it(`${program.name}: WasmGC and linear agree on every call`, async () => {
      const gc = await run(program, "gc");
      // The WasmGC lane is the primary target; if it can't compile/run the
      // program the corpus entry itself is broken — fail loudly.
      expect(gc.ok, `WasmGC backend failed to compile/run ${program.name}: ${gc.error}`).toBe(true);

      const linear = await run(program, "linear");

      if (program.expectLinearUnsupported) {
        // The gap is baselined: linear is not expected to compile this yet, so
        // we skip the diff. But assert it STILL fails — if linear gained
        // support, this assertion flips and prompts removing the flag (so the
        // unsupported gap can only shrink, never silently grow).
        expect(
          linear.ok,
          `${program.name} is flagged expectLinearUnsupported but now compiles+runs on linear — ` +
            `remove the flag so this program is differentially gated.`,
        ).toBe(false);
        return;
      }

      // Not flagged ⇒ linear must compile and run. A new linear compile error
      // on a previously-supported program is itself a regression to surface.
      expect(linear.ok, `linear backend failed to compile/run ${program.name}: ${linear.error}`).toBe(true);

      for (const call of program.calls) {
        const argStr = `${call.fn}(${call.args.join(", ")})`;
        const gcVal = invoke(gc.exports, call.fn, call.args);
        const linVal = invoke(linear.exports, call.fn, call.args);
        expect(
          linVal,
          `Cross-backend DIVERGENCE in ${program.name} :: ${argStr} — ` +
            `WasmGC returned ${JSON.stringify(gcVal)} but linear returned ${JSON.stringify(linVal)}. ` +
            `One backend's lowering is wrong (the equivalence suite only runs one backend per test, so it missed this).`,
        ).toStrictEqual(gcVal);
      }
    });
  }

  it("corpus is non-empty and every program declares at least one call", () => {
    expect(CROSS_BACKEND_CORPUS.length).toBeGreaterThan(0);
    for (const p of CROSS_BACKEND_CORPUS) {
      expect(p.calls.length, `${p.name} has no calls`).toBeGreaterThan(0);
    }
  });
});
