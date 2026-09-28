// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Generator ABI registration, shared by legacy and IR host providers. */
import type { ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { ensureLateImport, flushLateImportShifts } from "../shared.js";

/**
 * Register the generator host imports if not already registered.
 *
 * The legacy generator codegen (eager-buffer model) uses these imports to
 * push yielded values into a JS array on the host side, then wrap that
 * buffer with `__create_generator` (or `__create_async_generator`) to
 * produce a Generator-like / AsyncGenerator-like object. The IR path
 * (slice 7 — #1169f) reuses the same set of imports — extracting this
 * registration out of `declarations.ts:1014-1062` into a standalone
 * exported helper so both legacy and IR can call it without duplicating
 * the import-shape declarations.
 *
 * Imports registered (all under `env`):
 *   - `__gen_create_buffer`   () → externref
 *   - `__gen_push_f64`        (externref, f64) → ()
 *   - `__gen_push_i32`        (externref, i32) → ()
 *   - `__gen_push_ref`        (externref, externref) → ()
 *   - `__gen_yield_star`      (externref, externref) → ()  (same shape as push_ref)
 *   - `__create_generator`    (externref, externref) → externref  (buf, pendingThrow)
 *   - `__create_async_generator` (externref, externref) → externref  (same shape)
 *   - `__gen_next`            (externref) → externref
 *   - `__gen_return`          (externref, externref) → externref
 *   - `__gen_throw`           (externref, externref) → externref
 *   - `__gen_result_value`    (externref) → externref
 *   - `__gen_result_value_f64` (externref) → f64
 *   - `__gen_result_done`     (externref) → i32
 *   - `__get_caught_exception` () → externref  (for the body's try/catch wrapper)
 */
export function addGeneratorCompletionImport(ctx: CodegenContext): void {
  const ER: ValType = { kind: "externref" };
  ensureLateImport(ctx, "__gen_yield_star_result", [ER, ER], [ER]);
  flushLateImportShifts(ctx, ctx.currentFunc);
}

export function addGeneratorImports(ctx: CodegenContext, options?: { allowNoJsHost?: boolean }): void {
  if ((ctx.standalone || ctx.wasi) && !options?.allowNoJsHost) return;
  // Guard: only register once
  if (ctx.funcMap.has("__gen_create_buffer")) return;

  // (#2689) Batch + immediate flush — see addIteratorImports for the rationale.
  // Can be registered lazily (IR-path generator claim / body compilation) after
  // other functions baked their funcIdx; raw addImport would desync them. The
  // `__gen_*` / `__create_*` / `__get_caught_exception` names are not in any
  // standalone-refusal / native-helper set, so the `allowNoJsHost` fallback
  // behaves exactly as the previous raw additions did.
  const ER: ValType = { kind: "externref" };
  ensureLateImport(ctx, "__gen_create_buffer", [], [ER]);
  ensureLateImport(ctx, "__gen_push_f64", [ER, { kind: "f64" }], []);
  ensureLateImport(ctx, "__gen_push_i32", [ER, { kind: "i32" }], []);
  ensureLateImport(ctx, "__gen_push_ref", [ER, ER], []);
  // __gen_yield_star: (externref, externref) → void  (iterates inner iterable, pushes all values into outer buffer)
  ensureLateImport(ctx, "__gen_yield_star", [ER, ER], []);
  // __gen_set_return: (externref, externref) → void  (#2035 — stashes the
  // generator's `return` value on the buffer instead of pushing it as a yield)
  ensureLateImport(ctx, "__gen_set_return", [ER, ER], []);
  // __create_generator: (buf: externref, pendingThrow: externref) -> externref
  // Takes a buffer of yielded values and an optional pending exception,
  // returns a Generator-like object that defers the throw to the first next() call.
  ensureLateImport(ctx, "__create_generator", [ER, ER], [ER]);
  // __create_async_generator: same Wasm signature as __create_generator, but .next()/.return()/.throw()
  // return Promise-wrapped results as required by the ES spec for async generators.
  ensureLateImport(ctx, "__create_async_generator", [ER, ER], [ER]);
  ensureLateImport(ctx, "__gen_next", [ER], [ER]);
  ensureLateImport(ctx, "__gen_return", [ER, ER], [ER]);
  ensureLateImport(ctx, "__gen_throw", [ER, ER], [ER]);
  ensureLateImport(ctx, "__gen_result_value", [ER], [ER]);
  ensureLateImport(ctx, "__gen_result_value_f64", [ER], [{ kind: "f64" }]);
  ensureLateImport(ctx, "__gen_result_done", [ER], [{ kind: "i32" }]);
  // Ensure __get_caught_exception is available for generator body try/catch wrappers
  ensureLateImport(ctx, "__get_caught_exception", [], [ER]);
  flushLateImportShifts(ctx, ctx.currentFunc);
}
