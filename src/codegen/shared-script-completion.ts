// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { IR_CLOSURE_UNDEFINED } from "../ir/core/closure-invocation-callables.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { reserveApplyClosure } from "./object-runtime.js";
import { ensureSymbolCarrier } from "./symbol-native.js";

export function prepareScriptCompletionSink(ctx: CodegenContext): void {
  const sink = ctx.standaloneScriptCompletionImport;
  if (!sink || ctx.sourceIsModule) return;
  ensureLateImport(ctx, sink.name, [{ kind: "externref" }], [], sink.module);
  if (ctx.standaloneScriptGetExport) {
    ensureSymbolCarrier(ctx);
    ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  }
  flushLateImportShifts(ctx, null);
  if (ctx.standaloneScriptCallExport) reserveApplyClosure(ctx);
  if (ctx.standaloneScriptOwnNamesExport) {
    // The export is a reflection consumer even when the original Script has
    // no getOwnPropertyNames syntax for the source scanner to discover.
    ctx.vecOwnKeysDirty = true;
    ensureLateImport(ctx, "__getOwnPropertyNames", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, null);
  }
  if (ctx.standaloneScriptReflectionExports) {
    ensureLateImport(ctx, "__getOwnPropertySymbols", [{ kind: "externref" }], [{ kind: "externref" }]);
    ensureLateImport(
      ctx,
      "__getOwnPropertyDescriptor",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, null);
  }
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

/** Publish before dead elimination; reuse the getter after all shape fills. */
export function publishScriptGetter(ctx: CodegenContext): void {
  const name = ctx.standaloneScriptGetExport;
  if (!name) return;
  if (ctx.sourceIsModule) throw new Error("Native Script getter requires Script goal");
  if (ctx.mod.exports.some((entry) => entry.name === name)) throw new Error("Native Script getter export is occupied");
  const index = ctx.funcMap.get("__extern_get");
  if (index === undefined) throw new Error("Native Script getter was not reserved");
  ctx.mod.exports.push({ name, desc: { kind: "func", index } });
  // An unconditionally abrupt Script still implements the completion ABI.
  // Retain its sink through downstream DCE even if no normal path calls it.
  const sink = ctx.standaloneScriptCompletionImport;
  const sinkIndex = sink && ctx.funcMap.get(sink.name);
  if (sinkIndex === undefined) throw new Error("Native Script getter lacks completion sink");
  if (ctx.mod.exports.some((entry) => entry.name === "__script_completion_sink"))
    throw new Error("Native Script completion sink export is occupied");
  ctx.mod.exports.push({ name: "__script_completion_sink", desc: { kind: "func", index: sinkIndex } });
  const ownNames = ctx.standaloneScriptOwnNamesExport;
  if (ownNames) {
    if (ctx.mod.exports.some((entry) => entry.name === ownNames))
      throw new Error("Native Script own-names export is occupied");
    const index = ctx.funcMap.get("__getOwnPropertyNames");
    if (index === undefined) throw new Error("Native Script own-names helper was not reserved");
    ctx.mod.exports.push({ name: ownNames, desc: { kind: "func", index } });
  }
  const call = ctx.standaloneScriptCallExport;
  if (call) {
    if (ctx.mod.exports.some((entry) => entry.name === call)) throw new Error("Native Script call export is occupied");
    const index = ctx.funcMap.get("__apply_closure");
    if (index === undefined) throw new Error("Native Script call was not reserved");
    ctx.mod.exports.push({ name: call, desc: { kind: "func", index } });
  }
  const reflection = ctx.standaloneScriptReflectionExports;
  if (reflection) {
    for (const [name, helper] of [
      [reflection.ownSymbols, "__getOwnPropertySymbols"],
      [reflection.descriptor, "__getOwnPropertyDescriptor"],
    ]) {
      if (ctx.mod.exports.some((entry) => entry.name === name))
        throw new Error("Native Script reflection export is occupied");
      const index = ctx.funcMap.get(helper!);
      if (index === undefined) throw new Error("Native Script reflection helper was not reserved");
      ctx.mod.exports.push({ name: name!, desc: { kind: "func", index } });
    }
  }
}
