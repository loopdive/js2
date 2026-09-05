// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Shared lowering for an assignment whose identifier may be shadowed by direct eval. */
import { ts } from "../../ts-api.js";
import { allocLocal } from "../context/locals.js";
import { popBody, pushBody } from "../context/bodies.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  emitRefreshRuntimeEvalBindingValueCellForWrite,
  emitRuntimeEvalBindingCellWrite,
  type RuntimeEvalBindingValueCell,
} from "../global-environment.js";
import { emitRuntimeEvalAotCallableAdapter } from "../runtime-eval-callable.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression } from "../shared.js";
import { reportError } from "../context/errors.js";

interface RuntimeEvalAssignmentHelpers {
  isStaticallyCallableExpression: (ctx: CodegenContext, value: ts.Expression) => boolean;
  tryEmitAmbientIdentifierGlobalWriteFromLocal: (
    ctx: CodegenContext,
    fctx: FunctionContext,
    id: ts.Identifier,
    rhsLocalIdx: number,
  ) => boolean;
  emitIdentifierWriteFromLocal: (
    ctx: CodegenContext,
    fctx: FunctionContext,
    id: ts.Identifier,
    rhsLocalIdx: number,
  ) => void;
}

/** Compile a direct-eval-shadowable assignment with its LHS decision captured before the RHS. */
export function compileRuntimeEvalShadowedAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  id: ts.Identifier,
  name: string,
  runtimeBinding: RuntimeEvalBindingValueCell,
  helpers: RuntimeEvalAssignmentHelpers,
): InnerResult {
  const runtimeBindingPresent = allocLocal(fctx, `__runtime_eval_binding_present_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push(
    { op: "local.get", index: runtimeBinding.valueCellLocal },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "local.set", index: runtimeBindingPresent },
  );

  const wrapRuntimeEvalCallable = helpers.isStaticallyCallableExpression(ctx, expr.right);
  const rhsLocal = allocLocal(fctx, `__runtime_eval_shadow_rhs_${fctx.locals.length}`, {
    kind: "externref",
  });

  // Build the pre-RHS miss arm while fctx still names the outer capture. A
  // direct eval in the RHS may otherwise mutate the binding maps before this
  // original Reference is lowered.
  const savedMiss = pushBody(fctx);
  if (!helpers.tryEmitAmbientIdentifierGlobalWriteFromLocal(ctx, fctx, id, rhsLocal)) {
    helpers.emitIdentifierWriteFromLocal(ctx, fctx, id, rhsLocal);
  }
  const missBody = fctx.body;
  popBody(fctx, savedMiss);

  const rhsType = compileExpression(ctx, fctx, expr.right, wrapRuntimeEvalCallable ? undefined : { kind: "externref" });
  if (!rhsType) {
    reportError(ctx, expr, "Failed to compile runtime-eval-shadowed assignment value");
    return null;
  }
  if (rhsType.kind !== "externref") coerceType(ctx, fctx, rhsType, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: rhsLocal });

  const savedPresent = pushBody(fctx);
  let cellValueLocal = rhsLocal;
  if (wrapRuntimeEvalCallable) {
    fctx.body.push({ op: "local.get", index: rhsLocal });
    emitRuntimeEvalAotCallableAdapter(ctx, fctx);
    cellValueLocal = allocLocal(fctx, `__runtime_eval_shadow_cell_value_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: cellValueLocal });
  }
  const refreshedBinding = emitRefreshRuntimeEvalBindingValueCellForWrite(ctx, fctx, name, runtimeBinding);
  emitRuntimeEvalBindingCellWrite(fctx, refreshedBinding ?? runtimeBinding, cellValueLocal);
  const presentBody = fctx.body;
  popBody(fctx, savedPresent);

  fctx.body.push(
    { op: "local.get", index: runtimeBindingPresent },
    { op: "if", blockType: { kind: "empty" }, then: presentBody, else: missBody },
    { op: "local.get", index: rhsLocal },
  );
  return { kind: "externref" };
}
