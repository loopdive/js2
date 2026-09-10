// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ensureObjectRuntime, ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";

/** Receiver-aware variadic ABI: self=0, callable=1, complete argument vector=2. */
export function emitFunctionProtoCallBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  const vector = fctx.params[2]?.type;
  if (!vector || (vector.kind !== "ref" && vector.kind !== "ref_null")) return null;
  const array = getArrTypeIdxFromVec(ctx, vector.typeIdx);
  const definition = ctx.mod.types[array];
  if (definition?.kind !== "array" || definition.element.kind !== "externref") return null;
  ensureObjectRuntime(ctx);
  const apply = reserveApplyClosure(ctx);
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const callable = ctx.funcMap.get("__typeof_function");
  if (callable === undefined) return null;
  const receiver = allocLocal(fctx, "__call_receiver", { kind: "externref" });
  const list = allocLocal(fctx, "__call_list", { kind: "externref" });
  const count = allocLocal(fctx, "__call_count", { kind: "i32" });
  const index = allocLocal(fctx, "__call_index", { kind: "i32" });
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: callable },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "TypeError", "Function.prototype.call target is not callable", {
        flush: fctx,
      }),
    },
    ...canonicalUndefinedExternInstrs(ctx),
    { op: "local.set", index: receiver },
    { op: "call", funcIdx: newIdx },
    { op: "local.set", index: list },
    { op: "local.get", index: 2 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: [
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: vector.typeIdx, fieldIdx: 0 },
        { op: "local.set", index: count },
        { op: "local.get", index: count },
        { op: "i32.const", value: 0 },
        { op: "i32.gt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 2 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: vector.typeIdx, fieldIdx: 1 },
            { op: "i32.const", value: 0 },
            { op: "array.get", typeIdx: array },
            { op: "local.set", index: receiver },
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
                { op: "local.get", index: count },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: list },
                { op: "local.get", index: 2 },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: vector.typeIdx, fieldIdx: 1 },
                { op: "local.get", index },
                { op: "array.get", typeIdx: array },
                { op: "call", funcIdx: pushIdx },
                { op: "local.get", index },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    { op: "local.get", index: 1 },
    { op: "local.get", index: receiver },
    { op: "local.get", index: list },
    { op: "call", funcIdx: apply },
  );
  return { kind: "externref" };
}
