// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";

/** Pure representation check. Compatible user arrays can also reach this ABI. */
export function packedFunctionCallLayout(ctx: CodegenContext, fctx: FunctionContext) {
  if (ctx.targetProfile.target !== "standalone" || ctx.exportsConsumedByWasm || ctx.linkedNamespaces.size !== 0) {
    return undefined;
  }
  if (fctx.params.length !== 3 || fctx.params[0]?.type.kind !== "ref" || fctx.params[1]?.type.kind !== "externref") {
    return undefined;
  }
  const argv = fctx.params[2]?.type;
  if (!argv || (argv.kind !== "ref" && argv.kind !== "ref_null")) return undefined;
  if (argv.typeIdx !== ctx.vecTypeMap.get("externref")) return undefined;
  const arrayTypeIdx = getArrTypeIdxFromVec(ctx, argv.typeIdx);
  if (arrayTypeIdx < 0) return undefined;
  const vec = ctx.mod.types[argv.typeIdx];
  const array = ctx.mod.types[arrayTypeIdx];
  if (vec.kind !== "struct" || vec.fields[0]?.type.kind !== "i32") return undefined;
  if (array.kind !== "array" || array.element.kind !== "externref") return undefined;
  return { vecTypeIdx: argv.typeIdx };
}

/** Retained packed-vector body; its caller owns preparation and IsCallable. */
export function emitFunctionProtoCallBody(
  fctx: FunctionContext,
  layout: NonNullable<ReturnType<typeof packedFunctionCallLayout>>,
  prepared: { newIdx: number; pushIdx: number; applyIdx: number; getIdx: number; undefinedValue: Instr[] },
): ValType {
  const { vecTypeIdx } = layout;
  const { newIdx, pushIdx, applyIdx, getIdx, undefinedValue } = prepared;
  const receiver = allocLocal(fctx, "call_this", { kind: "externref" });
  const args = allocLocal(fctx, "call_args", { kind: "externref" });
  const length = allocLocal(fctx, "call_length", { kind: "i32" });
  const index = allocLocal(fctx, "call_index", { kind: "i32" });
  const argAt = (position: Instr): Instr[] => [
    { op: "local.get", index: 2 },
    { op: "extern.convert_any" },
    position,
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: getIdx },
  ];
  fctx.body.push(
    ...undefinedValue,
    { op: "local.set", index: receiver },
    { op: "call", funcIdx: newIdx },
    { op: "local.set", index: args },
    { op: "local.get", index: 2 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: [
        { op: "local.get", index: 2 },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.tee", index: length },
        { op: "i32.const", value: 0 },
        // Match main's signed header conversion, including its high-bit limitation.
        { op: "i32.gt_s" },
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
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: args },
            ...argAt({ op: "local.get", index }),
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
    { op: "local.get", index: 1 },
    { op: "local.get", index: receiver },
    { op: "local.get", index: args },
    { op: "call", funcIdx: applyIdx },
  );
  return { kind: "externref" };
}
