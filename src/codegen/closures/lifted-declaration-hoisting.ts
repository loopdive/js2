// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { reifyCurrentDirectEvalBindings } from "../direct-eval-environment.js";
import { liftedFrameHoistableStatements } from "../function-declaration-observation.js";
import { hoistLetConstWithTdz } from "../index.js";
import { hoistFunctionDeclarations } from "../statements.js";

/** Prepare declarations in a lifted function-expression/callback frame. */
export function prepareLiftedFrameDeclarations(
  ctx: CodegenContext,
  fctx: FunctionContext,
  body: ts.ConciseBody,
  reifyDirectEval: boolean,
  hoistFunctions = true,
): void {
  if (!ts.isBlock(body)) return;
  hoistLetConstWithTdz(ctx, fctx, body.statements);
  if (reifyDirectEval) reifyCurrentDirectEvalBindings(ctx, fctx);
  if (hoistFunctions) {
    hoistFunctionDeclarations(ctx, fctx, liftedFrameHoistableStatements(ctx, fctx, body.statements));
  }
}
