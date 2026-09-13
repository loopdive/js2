// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6419) Make the host lane's canonical `undefined` externref producer
 * AVAILABLE before `canonicalUndefinedExternInstrs` is asked for it.
 *
 * `canonicalUndefinedExternInstrs` (any-helpers.ts) is deliberately a
 * READ-ONLY `funcMap` lookup — it must never register an import mid-body,
 * because that shifts func indices under whoever is emitting. Its host-lane
 * fallback when `__get_undefined` has not been registered yet is
 * `ref.null.extern`, which is JS **`null`**, not `undefined`.
 *
 * That fallback is silently wrong wherever the produced value is an ABSENT
 * slot, because §8.5.3 destructuring defaults fire on `=== undefined` only
 * (#1021) and the checker used is `__extern_is_undefined`, which correctly
 * answers `false` for a null. Measured on main: `let [a = "x"] = []` answers
 * `"x"` (the element carrier is a string, so the f64/string sentinel arm runs),
 * but as soon as the carrier is `externref` — `let [a = ({z:1} as any)] = []`,
 * or the TDZ probe `let [y = y] = []` — the padding is `ref.null.extern`, the
 * default never fires, and the binding is `null`. For `let [y = y] = []` that
 * also swallows the §13.3.1 ReferenceError the self-reference must throw
 * (`tests/issue-1128-dstr-tdz.test.ts`, red on main).
 *
 * Registering the import ahead of the read is the whole fix: the shift is
 * flushed immediately through the established `ensureLateImport` +
 * `flushLateImportShifts` pair (the same one the externref element-default arm
 * in `destructuring-params.ts` uses mid-expression), so already-emitted
 * indices are remapped and the wasm stack shape is untouched.
 */
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";

/**
 * Ensure `__get_undefined` is registered so a following
 * `canonicalUndefinedExternInstrs(ctx)` emits the real host `undefined`.
 *
 * No-op outside the JS-host lane (standalone / native-strings builds answer
 * from the `$AnyValue` undefined singleton, no import involved) and after the
 * #1984 index-space freeze, where registering anything is a producer bug — in
 * both cases the caller keeps whatever `canonicalUndefinedExternInstrs`
 * decides on its own.
 */
export function ensureCanonicalUndefinedExtern(ctx: CodegenContext, fctx: FunctionContext | null): void {
  if (ctx.standalone || ctx.nativeStrings) return;
  if (ctx.funcMap.get("__get_undefined") !== undefined) return;
  if (ctx.indexSpaceFrozen) return;
  if (ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]) !== undefined) {
    flushLateImportShifts(ctx, fctx);
  }
}
