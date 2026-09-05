// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Materialize a BigInt literal's decimal text as a genuine JS-host string. */
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addHostStringConstantGlobal } from "./registry/imports.js";
import { compileStringLiteral } from "./string-ops.js";

export function compileHostBigIntLiteralText(ctx: CodegenContext, fctx: FunctionContext, text: string): ValType | null {
  const globalIdx =
    ctx.nativeStrings && ctx.targetProfile.semanticProviders !== "native-first"
      ? addHostStringConstantGlobal(ctx, text)
      : undefined;
  if (globalIdx === undefined) return compileStringLiteral(ctx, fctx, text);
  fctx.body.push({ op: "global.get", index: globalIdx });
  return { kind: "externref" };
}
