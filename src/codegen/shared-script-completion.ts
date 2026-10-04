// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { IR_CLOSURE_UNDEFINED } from "../ir/core/closure-invocation-callables.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

export function prepareScriptCompletionSink(ctx: CodegenContext): void {
  const sink = ctx.standaloneScriptCompletionImport;
  if (!sink || ctx.sourceIsModule) return;
  ensureLateImport(ctx, sink.name, [{ kind: "externref" }], [], sink.module);
  flushLateImportShifts(ctx, null);
  if (ctx.funcMap.has(IR_CLOSURE_UNDEFINED)) throw new Error("Script completion undefined provider name is occupied");
  const frame: FunctionContext = {
    name: IR_CLOSURE_UNDEFINED,
    params: [],
    locals: [],
    localMap: new Map(),
    returnType: { kind: "externref" },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  const previous = ctx.currentFunc;
  ctx.currentFunc = frame;
  try {
    emitUndefined(ctx, frame);
  } finally {
    ctx.currentFunc = previous;
  }
  const handle = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, handle, {
    name: frame.name,
    typeIdx: addFuncType(ctx, [], [{ kind: "externref" }]),
    locals: frame.locals,
    body: frame.body,
    exported: false,
  });
  ctx.funcMap.set(IR_CLOSURE_UNDEFINED, handle);
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
