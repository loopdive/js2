// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, ValType } from "../ir/types.js";
import type { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { noJsHost } from "./expressions/helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { coerceType, compileExpression } from "./shared.js";

/**
 * Test a native WasmGC builtin first, then fall back to host `instanceof`.
 * This lets JS-host modules recognize native Date structs without forcing a
 * standalone-only representation for host-backed builtins such as RegExp.
 */
export function emitHostOrNativeBuiltinInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  ctorName: string,
  typeIdxs: number[],
): ValType | null {
  if (noJsHost(ctx) || typeIdxs.length === 0) return null;
  const externref: ValType = { kind: "externref" };
  const instanceofIdx = ensureLateImport(ctx, "__instanceof", [externref, externref], [{ kind: "i32" }]);
  if (instanceofIdx === undefined) return null;
  addStringConstantGlobal(ctx, ctorName);
  flushLateImportShifts(ctx, fctx);

  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) fctx.body.push({ op: "ref.null.extern" });
  else if (leftType.kind === "i32" || leftType.kind === "f64" || leftType.kind === "i64") {
    fctx.body.push({ op: "drop" }, { op: "i32.const", value: 0 });
    return { kind: "i32" };
  } else if (leftType.kind !== "externref") coerceType(ctx, fctx, leftType, externref);

  const valueLocal = allocLocal(fctx, `__io_host_native_${fctx.locals.length}`, externref);
  const nativeAnyLocal = allocLocal(fctx, `__io_host_native_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push(
    { op: "local.set", index: valueLocal },
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "local.set", index: nativeAnyLocal },
  );

  const nativeTest: Instr[] = [
    { op: "local.get", index: nativeAnyLocal },
    { op: "ref.test", typeIdx: typeIdxs[0]! },
  ];
  for (let i = 1; i < typeIdxs.length; i++) {
    nativeTest.push(
      { op: "local.get", index: nativeAnyLocal },
      { op: "ref.test", typeIdx: typeIdxs[i]! },
      { op: "i32.or" },
    );
  }
  fctx.body.push(...nativeTest, {
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: 1 }],
    else: [
      { op: "local.get", index: valueLocal },
      ...stringConstantExternrefInstrs(ctx, ctorName),
      { op: "call", funcIdx: instanceofIdx },
    ],
  });
  return { kind: "i32" };
}
