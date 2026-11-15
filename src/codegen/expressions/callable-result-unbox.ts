// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7080) Host-free result bridge for a callable-value dispatch arm whose
 * funcref returns a boxed `externref` while the call site reads a number (or a
 * boolean).
 *
 * ```ts
 * function each(fn: (a: any) => number) { return fn("abc"); }
 * each((e) => e.length);   // 3 — standalone answered NaN
 * ```
 *
 * The arrow's body reads `.length` off an `any`, so its own lowered signature
 * returns `externref`; the parameter's declared type says `=> number`, so the
 * caller reads `f64`. The funcref ladder in `call-identifier.ts` reaches the
 * right arm (`ref.test` on the externref-returning wrapper type) and calls it —
 * then DROPPED the live result and pushed the undefined sentinel, because its
 * scalar bridge planner returns `null` on every host-free target (it was built
 * for the JS-host lane's `__box_number`/`__unbox_number` IMPORTS, where a
 * dead-arm late import would shift function indices).
 *
 * On standalone / WASI those two conversions are ordinary DEFINED functions
 * (the native union helpers). Calling one adds no import and shifts nothing,
 * so the live arm can keep its value: ToNumber of the boxed result for an `f64`
 * reader, ToBoolean for a boolean-branded `i32` reader. A helper that
 * resolved to an IMPORT is refused, keeping the historical placeholder.
 * {@link ensureHostFreeCallableResultHelper} registers the helper BEFORE the
 * detached arm list is built (the ladder always carries an externref-returning
 * candidate when the reader is not externref), so no index shifts under it.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { addUnionImportsViaRegistry, flushLateImportShifts } from "../shared.js";

/** The native union helpers this bridge calls (ToNumber / ToBoolean of a boxed value). */
const TO_NUMBER = "__unbox_number";
const TO_BOOLEAN = "__is_truthy";

function definedHelper(ctx: CodegenContext, name: string): number | undefined {
  const idx = ctx.funcMap.get(name);
  return idx !== undefined && idx >= ctx.numImportFuncs ? idx : undefined;
}

/** The pure-Wasm result conversion for a live arm, or `null` to keep the placeholder. */
export function hostFreeCallableResultBridge(ctx: CodegenContext, from: ValType, to: ValType): Instr[] | null {
  if (from.kind !== "externref") return null;
  if (to.kind === "f64" && to.undefSentinel !== true) {
    const unbox = definedHelper(ctx, TO_NUMBER);
    return unbox === undefined ? null : [{ op: "call", funcIdx: unbox }];
  }
  if (to.kind === "i32" && to.boolean === true) {
    const truthy = definedHelper(ctx, TO_BOOLEAN);
    return truthy === undefined ? null : [{ op: "call", funcIdx: truthy }];
  }
  return null;
}

/**
 * Register the native union helpers before the dispatch arms are built, when
 * this call site reads a number or a boolean on a host-free target.
 */
export function ensureHostFreeCallableResultHelper(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expectedReturn: ValType | null,
): void {
  if (expectedReturn === null) return;
  const wantsNumber = expectedReturn.kind === "f64" && expectedReturn.undefSentinel !== true;
  const wantsBoolean = expectedReturn.kind === "i32" && expectedReturn.boolean === true;
  if (!wantsNumber && !wantsBoolean) return;
  if (definedHelper(ctx, wantsNumber ? TO_NUMBER : TO_BOOLEAN) !== undefined) return;
  addUnionImportsViaRegistry(ctx);
  flushLateImportShifts(ctx, fctx);
}
