// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { buildStandardTryTable } from "../../ir/try-table.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { ensureExnTag } from "../registry/imports.js";
import { ensureHostStrictSpreadDispatch, ensureNativeStrictSpreadRuntime } from "../iterator-native.js";
import { isStrictContext } from "../helpers/is-strict-function.js";
import { findUnresolvableInArrayPattern } from "./unresolvable-assign.js";
import { coerceType } from "../shared.js";
import { emitThrowReferenceError } from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

export function prepareStrictSingleArrayWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ArrayLiteralExpression,
  value: ts.Expression,
): boolean {
  const singleUnresolved =
    target.elements.length === 1 &&
    ts.isIdentifier(target.elements[0]!) &&
    !(ts.isArrayLiteralExpression(value) && !ctx.arrayIteratorMaybeOverridden) &&
    isStrictContext(target, ctx.inferModuleStrictArguments) &&
    Boolean(findUnresolvableInArrayPattern(ctx, fctx, target));
  if (singleUnresolved) {
    // Register literal dispatch before compiling the RHS allocations.
    if (ctx.standalone || ctx.wasi) ensureNativeStrictSpreadRuntime(ctx);
    else ensureHostStrictSpreadDispatch(ctx);
  }
  return singleUnresolved;
}

export function emitStrictSingleArrayWrite(ctx: CodegenContext, fctx: FunctionContext, resultType: ValType): ValType {
  // A single unresolved identifier still performs IteratorStepValue before
  // PutValue. In particular, a throwing next/done/value must win over the
  // ReferenceError and must not close the iterator. Do not materialize here:
  // that would close with a normal completion before the failing PutValue.
  coerceType(ctx, fctx, resultType, { kind: "externref" });
  ensureLateImport(ctx, "__iterator_strict", [{ kind: "externref" }], [{ kind: "externref" }]);
  ensureLateImport(ctx, "__iterator_next_strict", [{ kind: "externref" }], [{ kind: "i32" }, { kind: "externref" }]);
  ensureLateImport(ctx, "__iterator_return", [{ kind: "externref" }], []);
  flushLateImportShifts(ctx, fctx);
  const iterLocal = allocLocal(fctx, `__unresolved_assign_iter_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__iterator_strict")! });
  fctx.body.push({ op: "local.tee", index: iterLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__iterator_next_strict")! });
  fctx.body.push({ op: "drop" }); // value; the unresolved PutValue always throws
  fctx.body.push({ op: "i32.eqz" }); // only close an iterator which is not done
  const closeBody: Instr[] = [
    { op: "local.get", index: iterLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__iterator_return")! },
  ];
  const closeOnThrow: Instr =
    ctx.standalone || ctx.wasi
      ? buildStandardTryTable({ kind: "empty" }, closeBody, [
          {
            kind: "catch",
            tagIdx: ensureExnTag(ctx),
            payloadType: { kind: "externref" },
            body: [{ op: "drop" }],
          },
        ])
      : { op: "try", blockType: { kind: "empty" }, body: closeBody, catches: [], catchAll: [] };
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [closeOnThrow], // IteratorClose preserves the pending ReferenceError
    else: [],
  });
  emitThrowReferenceError(ctx, fctx, "assignment to undeclared variable");
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

export function emitEarlyStrictArrayWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ArrayLiteralExpression,
): boolean {
  // §6.2.4 PutValue: strict-mode assignment to unresolvable reference throws.
  // Nested patterns must observe a nullish element before PutValue resolves
  // their leaf targets. In `[[x]] = []`, the missing outer element therefore
  // throws the required TypeError before strict-mode's unresolved `x` check
  // (#4719). Leaf-only patterns retain the existing early ReferenceError path.
  const hasNestedPattern = target.elements.some(
    (element) => ts.isArrayLiteralExpression(element) || ts.isObjectLiteralExpression(element),
  );
  if (
    isStrictContext(target, ctx.inferModuleStrictArguments) &&
    findUnresolvableInArrayPattern(ctx, fctx, target) &&
    !hasNestedPattern
  ) {
    fctx.body.push({ op: "drop" });
    emitThrowReferenceError(ctx, fctx, "assignment to undeclared variable");
    fctx.body.push({ op: "ref.null.extern" });
    return true;
  }

  return false;
}
