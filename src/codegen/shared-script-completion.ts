// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

export function prepareScriptCompletionSink(ctx: CodegenContext): void {
  const sink = ctx.standaloneScriptCompletionImport;
  if (!sink || ctx.sourceIsModule) return;
  ensureLateImport(ctx, sink.name, [{ kind: "externref" }], [], sink.module);
  flushLateImportShifts(ctx, null);
}

export function beginScriptCompletion(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!ctx.standaloneScriptCompletionImport || ctx.sourceIsModule) return;
  const local = allocLocal(fctx, "__script_completion", { kind: "externref" });
  emitUndefined(ctx, fctx);
  fctx.body.push({ op: "local.set", index: local });
  fctx.evalCompletionLocal = local;
}

export function publishScriptCompletion(ctx: CodegenContext, fctx: FunctionContext): void {
  const sink = ctx.standaloneScriptCompletionImport;
  if (!sink || fctx.evalCompletionLocal === undefined) return;
  const index = ensureLateImport(ctx, sink.name, [{ kind: "externref" }], [], sink.module);
  flushLateImportShifts(ctx, fctx);
  if (index === undefined) throw new Error("Missing Script completion sink");
  fctx.body.push(
    { op: "local.get", index: fctx.evalCompletionLocal },
    { op: "call", funcIdx: ctx.funcMap.get(sink.name) ?? index },
  );
}
