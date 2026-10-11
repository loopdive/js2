// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6704) Let a callable-property dispatch arm pass a WasmGC reference
 * argument into the callee's `externref` formal, under `--target standalone`
 * / `wasi`.
 *
 * `obj.f(x)` dispatches on the stored closure's exact funcref type
 * (`calls-closures.ts` `emitRootFuncrefDispatch`). The candidate set is built
 * from the property's TypeScript signature, so a JSDoc `@param {string}
 * [s='']` gives the call site a native-string argument — while the compiled
 * body lowers that optional-with-default parameter to `externref`. With no
 * ref → externref crossing on the no-host lanes the callee's real funcref was
 * never admitted and the ladder fell to its TypeError terminal (lodash-es
 * `__pkgNs.words(input)` → null result → trap at `.length`).
 *
 * The crossing is the same one `coerceType` performs for any ref → externref
 * value on these lanes: `extern.convert_any`, identity-preserving and
 * import-free (every ladder arm must be — #2174). Two carriers keep their own
 * semantics: `$AnyValue` is a tagged box that needs its projection helper (not
 * admitted), and a null `$AnyString` is the compiler's "missing string"
 * sentinel whose public value is `undefined` (#4741) — so a padded optional
 * argument reaches the callee as `undefined`, not JavaScript `null`.
 *
 * The JS-host lane is untouched: it has its own bridge in the caller.
 */
import type { Instr, ValType } from "../../ir/types.js";
import { canonicalUndefinedExternInstrs } from "../any-helpers.js";
import type { CodegenContext } from "../context/types.js";

/** Admission + plain crossing for a no-host ref → externref argument. */
export function standaloneRefToExternBridge(ctx: CodegenContext, from: ValType, to: ValType): Instr[] | null {
  if (!(ctx.standalone || ctx.wasi)) return null;
  if (from.kind !== "ref" && from.kind !== "ref_null") return null;
  if (to.kind !== "externref") return null;
  if (from.typeIdx === ctx.anyValueTypeIdx) return null;
  return [{ op: "extern.convert_any" }];
}

/**
 * Read argument `argLocal` for an arm whose formal is `externref`, mapping the
 * missing-string sentinel to `undefined`. Null when the plain bridge applies.
 */
export function standaloneMissingStringArgRead(
  ctx: CodegenContext,
  argLocal: number,
  from: ValType,
  to: ValType,
): Instr[] | null {
  if (standaloneRefToExternBridge(ctx, from, to) === null) return null;
  if (from.kind !== "ref_null" || !ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return null;
  if (from.typeIdx !== ctx.anyStrTypeIdx) return null;
  return [
    { op: "local.get", index: argLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: canonicalUndefinedExternInstrs(ctx),
      else: [{ op: "local.get", index: argLocal }, { op: "extern.convert_any" }],
    },
  ];
}
