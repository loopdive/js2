// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { analyzeAsyncBody, type AsyncCpsPlan, planAsyncCfg } from "./async-cps.js";
import type { CodegenContext } from "./context/types.js";

export interface SupportedAsyncGraphModulePlan {
  readonly decl: ts.FunctionDeclaration;
  readonly plan: AsyncCpsPlan;
}

/** Build the native graph plan only when its resume CFG can represent the body. */
export function supportedAsyncGraphModulePlan(
  ctx: CodegenContext,
  statements: readonly ts.Statement[],
): SupportedAsyncGraphModulePlan | null {
  const decl = ts.factory.createFunctionDeclaration(
    [ts.factory.createModifier(ts.SyntaxKind.AsyncKeyword)],
    undefined,
    "__v8x_graph_eval_body",
    undefined,
    [],
    undefined,
    ts.factory.createBlock([...statements], true),
  );
  const plan = analyzeAsyncBody(ctx, decl);
  const cfg = planAsyncCfg(ctx, decl, plan, {
    allowLoops: true,
    allowTryCatch: true,
    allowReturnInTry: true,
  });
  return cfg === null ? null : { decl, plan };
}
