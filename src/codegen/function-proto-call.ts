// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ensureObjectRuntime, ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
import { flushLateImportShifts } from "./shared.js";

/** Receiver-aware variadic ABI: self, callable this, complete call arguments. */
export function emitFunctionProtoCallBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  if (!ctx.standalone) return null;
  const argv = fctx.params[2]?.type;
  if (!argv || (argv.kind !== "ref" && argv.kind !== "ref_null")) return null;
  const arrayTypeIdx = getArrTypeIdxFromVec(ctx, argv.typeIdx);
  if (arrayTypeIdx < 0) return null;
  ensureObjectRuntime(ctx);
  ensureObjVecBuilders(ctx);
  reserveApplyClosure(ctx);
  const invalid = buildThrowJsErrorInstrs(ctx, "TypeError", "Function.prototype.call requires a callable receiver", {
    flush: fctx,
  });
  flushLateImportShifts(ctx, fctx);
  const isCallable = ctx.funcMap.get("__typeof_function");
  const undefinedValue = undefinedExternInstrs(ctx);
  if (isCallable === undefined || !undefinedValue) return null;
  const receiver = allocLocal(fctx, "call_this", { kind: "externref" });
  const args = allocLocal(fctx, "call_args", { kind: "externref" });
  const length = allocLocal(fctx, "call_length", { kind: "i32" });
  const index = allocLocal(fctx, "call_index", { kind: "i32" });
  const argAt = (position: Instr): Instr[] => [
    { op: "local.get", index: 2 },
    { op: "struct.get", typeIdx: argv.typeIdx, fieldIdx: 1 },
    position,
    { op: "array.get", typeIdx: arrayTypeIdx },
  ];
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: isCallable },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: invalid },
    ...undefinedValue,
    { op: "local.set", index: receiver },
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! },
    { op: "local.set", index: args },
    { op: "local.get", index: 2 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: [
        { op: "local.get", index: 2 },
        { op: "struct.get", typeIdx: argv.typeIdx, fieldIdx: 0 },
        { op: "local.tee", index: length },
        { op: "i32.const", value: 0 },
        { op: "i32.gt_u" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...argAt({ op: "i32.const", value: 0 }), { op: "local.set", index: receiver }],
        },
      ],
    },
    { op: "i32.const", value: 1 },
    { op: "local.set", index },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index },
            { op: "local.get", index: length },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: args },
            ...argAt({ op: "local.get", index }),
            { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
            { op: "local.get", index },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: 1 },
    { op: "local.get", index: receiver },
    { op: "local.get", index: args },
    { op: "call", funcIdx: ctx.funcMap.get("__apply_closure")! },
  );
  return { kind: "externref" };
}
