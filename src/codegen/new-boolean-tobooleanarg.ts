// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4619) `new Boolean(<non-numeric>)` — the [[BooleanData]] slot must hold
 * §7.1.2 ToBoolean(x).
 *
 * ## The defect
 *
 * The wrapper-constructor arm (`expressions/new-builtin-globals.ts`) coerced
 * the argument to `f64` and handed that to `__new_Boolean`. For an object, an
 * array or a string that coercion is not merely lossy, it INVERTS the answer.
 * Measured on base `2937ca57a`, standalone:
 *
 * | expression                              | base    | §7.1.2 |
 * | --------------------------------------- | ------- | ------ |
 * | `new Boolean(new Object()).valueOf()`   | `false` | `true` |
 * | `new Boolean([]).valueOf()`             | `false` | `true` |
 * | `new Boolean("0").valueOf()`            | `false` | `true` |
 * | `Boolean(new Object())`                 | `true`  | `true` |
 *
 * The last row is the point: the FUNCTION spelling already has the full
 * §7.1.2 lowering (`expressions/call-identifier.ts`), so the module contained
 * two answers for one value — the failure shape this campaign treats as worse
 * than a refusal. It blocked `built-ins/Boolean/prototype/toString/
 * S15.6.4.2_A1_T1` (`(new Boolean(new Object())).toString()` must be `"true"`)
 * even after #4619's `toString` body landed, and `S15.6.2.1_A3` /
 * `prototype/valueOf/S15.6.4.3_A1_T{1,2}` independently.
 *
 * ## Why it is narrow, and stays narrow
 *
 * It fires ONLY for an argument the oracle places as `object` or `string`.
 * Every numeric spelling keeps the existing f64 path byte-for-byte — that path
 * is correct for numbers and cheaper — and an argument the oracle cannot place
 * keeps it too, so an unresolved type can never be turned into a wrong answer
 * by this arm. Symbol arguments are handled before it, by the caller.
 */
import type { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addUnionImports } from "./index.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { coerceType, compileExpression } from "./shared.js";

/**
 * Emit ToBoolean(`arg`) as the `f64` `__new_Boolean` expects, or return `false`
 * having emitted NOTHING so the caller keeps its existing f64 coercion.
 */
export function emitNewBooleanToBooleanArg(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): boolean {
  const jsType = ctx.oracle.staticJsTypeOf(arg);
  if (jsType !== "object" && jsType !== "string") return false;

  const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
  if (argType === null) {
    fctx.body.push({ op: "f64.const", value: 0 });
    return true;
  }
  if (argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });

  // `__is_truthy` is the native standalone union helper (#2915); `__to_boolean`
  // the host import. The same choice, on the same condition, the FUNCTION
  // spelling makes — so the two cannot drift apart again.
  const useNativeTruthy = ctx.standalone;
  if (useNativeTruthy) addUnionImports(ctx);
  const helper = useNativeTruthy ? "__is_truthy" : "__to_boolean";
  const toBoolIdx = ensureLateImport(ctx, helper, [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  if (toBoolIdx === undefined) {
    // No helper: "a non-null reference is truthy" — right for every object, and
    // wrong only for the empty string, which is still strictly closer than the
    // f64 coercion this replaces.
    fctx.body.push({ op: "ref.is_null" }, { op: "i32.eqz" }, { op: "f64.convert_i32_u" });
    return true;
  }
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(helper) ?? toBoolIdx }, { op: "f64.convert_i32_u" });
  return true;
}
