// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext } from "./context/types.js";
import type { Instr, ValType } from "../ir/types.js";
import { addFuncType, getOrRegisterVecBaseType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";

export const VEC_PROJECTION_ROOT = "__vec_projection_root";
export const VEC_PROJECTION_ALIAS = "__vec_projection_alias";

/** Fresh physical projections retain the source's ordinary-property identity. */
export function ensureVecProjectionIdentity(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(VEC_PROJECTION_ALIAS);
  if (existing !== undefined) return existing;
  const base = getOrRegisterVecBaseType(ctx);
  const entry = ctx.mod.types.length;
  const entryRef: ValType = { kind: "ref_null", typeIdx: entry };
  const extern: ValType = { kind: "externref" };
  ctx.mod.types.push({
    kind: "struct",
    name: "$VecProjectionIdentity",
    fields: [
      { name: "next", type: entryRef, mutable: false },
      { name: "view", type: { kind: "eqref" }, mutable: false },
      { name: "root", type: extern, mutable: false },
    ],
  });
  const head = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "$vec_projection_head",
    type: entryRef,
    mutable: true,
    init: [{ op: "ref.null", typeIdx: entry }],
  });
  const add = (
    name: string,
    params: ValType[],
    results: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ): number => {
    const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
    const index = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, index, { name, typeIdx, locals, body, exported: false });
    ctx.funcMap.set(name, index);
    return index;
  };
  const root = add(
    VEC_PROJECTION_ROOT,
    [extern],
    [extern],
    [{ name: "entry", type: entryRef }],
    [
      { op: "global.get", index: head },
      { op: "local.set", index: 1 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 1 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 1 },
              { op: "struct.get", typeIdx: entry, fieldIdx: 1 },
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: base },
              { op: "ref.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 1 },
                  { op: "struct.get", typeIdx: entry, fieldIdx: 2 },
                  { op: "return" },
                ],
              },
              { op: "local.get", index: 1 },
              { op: "struct.get", typeIdx: entry, fieldIdx: 0 },
              { op: "local.set", index: 1 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 0 },
    ],
  );
  // Destination is a fresh vec, so no previous identity can be overwritten.
  // Resolve the source now: aliases form a flat map, never chains or cycles.
  return add(
    VEC_PROJECTION_ALIAS,
    [extern, extern],
    [],
    [],
    [
      // Non-array array-likes materialize a new array, not an identity view.
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: base },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      { op: "global.get", index: head },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: base },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: root },
      { op: "struct.new", typeIdx: entry },
      { op: "global.set", index: head },
    ],
  );
}
