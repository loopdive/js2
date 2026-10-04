// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { buildBigIntCarrierUpdateDefinition } from "../runtime/wasmgc/values/bigint-carrier-update.js";
import type { CodegenContext } from "./context/types.js";
import { addUnionImports } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";

/** Native exact +/-1 over a proven BigInt carrier, shared by update sites. */
export function ensureNativeBigIntCarrierUpdate(ctx: CodegenContext): number {
  const name = "__bigint_carrier_update";
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  addUnionImports(ctx);
  const narrow = ctx.nativeBigIntTypeIdx;
  const wide = ctx.nativeBigIntWideTypeIdx;
  const limbs = ctx.nativeBigIntLimbsTypeIdx;
  if (narrow < 0 || wide === undefined || limbs === undefined)
    throw new Error("Native BigInt update requires canonical carrier layouts");
  const definition = buildBigIntCarrierUpdateDefinition({ narrow, wide, limbs });
  const handle = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, handle);
  pushDefinedFunc(ctx, handle, {
    name,
    typeIdx: addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "externref" }]),
    ...definition,
    exported: false,
  });
  return handle;
}
