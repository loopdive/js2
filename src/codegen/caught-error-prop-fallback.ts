// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4394) Generic-read fallback for the #2077 catch-binding `.message`/`.name`/
 * `.stack` arm in property-access-dispatch.ts.
 *
 * That arm guards `e.<prop>` on a `catch (e)` binding with `ref.test
 * $Error_struct`. Its non-`$Error` else-arm used to produce a NULL string,
 * silently erasing the property on every caught value that is NOT an
 * `$Error_struct` — in particular a thrown user-fnctor instance (the literal
 * harness's `Test262Error`, sta.js), whose struct is reified to a plain
 * `$Object` at the throw boundary. Measured: `e["message"]` read the real
 * value while `e.message` answered null (rendered "[object Object]" through
 * string concat). This helper builds the else-arm as the ordinary dynamic
 * read — `__extern_get(recv, "<prop>")` — so the caught object's own property
 * is honored; a value with no such property still yields null/undefined
 * exactly as before.
 *
 * Kept as a leaf module so the dispatch god-file does not grow (#3102).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { coerceType } from "./type-coercion.js";

/**
 * Build the non-`$Error` else-arm instructions: read `tmpAny`'s property
 * `propName` through the generic `__extern_get`, coerced to `resultType`.
 * Falls back to a plain null of `resultType` when the object runtime is
 * unavailable (the pre-#4394 behaviour).
 */
export function buildCaughtErrorPropFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  tmpAny: number,
  propName: string,
  resultType: ValType,
): Instr[] {
  const externGetIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (externGetIdx === undefined) {
    return resultType.kind === "externref"
      ? [{ op: "ref.null.extern" }]
      : [{ op: "ref.null", typeIdx: (resultType as { typeIdx: number }).typeIdx }];
  }
  addStringConstantGlobal(ctx, propName);
  const saved = fctx.body;
  fctx.body = [];
  fctx.body.push({ op: "local.get", index: tmpAny });
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? externGetIdx });
  if (resultType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, resultType);
  const instrs = fctx.body;
  fctx.body = saved;
  return instrs;
}
