// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import { compileExpression } from "./shared.js";
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addHostStringConstantGlobal, addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

/** Reserve imported key globals before deferred dispatchers capture module-global indices. */
export function registerHostPropertyKey(ctx: CodegenContext, value: string): number | undefined {
  return ctx.targetProfile.semanticProviders === "native-first" ? undefined : addHostStringConstantGlobal(ctx, value);
}

/** Static property keys crossing a host operation boundary; native lanes retain native carriers. */
export function staticHostPropertyKeyInstrs(ctx: CodegenContext, value: string): Instr[] {
  const hostIndex = registerHostPropertyKey(ctx, value);
  if (hostIndex !== undefined) return [{ op: "global.get", index: hostIndex }];
  addStringConstantGlobal(ctx, value);
  return stringConstantExternrefInstrs(ctx, value);
}

/** Only literal keys bypass expression compilation; evaluated keys retain their original evaluation. */
export function compileHostPropertyKey(ctx: CodegenContext, fctx: FunctionContext, key: ts.Expression): void {
  if (ts.isStringLiteralLike(key)) {
    fctx.body.push(...staticHostPropertyKeyInstrs(ctx, key.text));
  } else {
    compileExpression(ctx, fctx, key, { kind: "externref" });
  }
}
