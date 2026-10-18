// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7020) Tuple structs are JS ARRAYS for standalone `Array.isArray`.
 *
 * A TypeScript tuple (`[string, string, string]`) lowers to an immutable
 * `__tuple_N` struct (`_0`, `_1`, …), not to a `__vec_*` carrier, so the
 * standalone `__extern_is_array` `ref.test` chain answered `false` for a tuple
 * read through `any` — while `length` and index reads on the same value already
 * worked. Measured on cookie's `stringify-cookie.spec.ts`: the upstream shim's
 * `it.each(Array<[string, string, string]>)` checks `Array.isArray(row)` to
 * decide whether to spread a row into the callback, so every row was wrapped
 * whole, `%s` printed `[object Object]` and the body received `undefined`.
 *
 * ## The one hazard: canonical type identity
 * WasmGC canonicalizes struct types STRUCTURALLY (field names do not exist in
 * the binary), so a `ref.test` against a tuple type also matches every other
 * struct with the same field layout — e.g. a one-field boolean box struct is
 * the same runtime type as a `[boolean]` tuple. A tuple type is admitted only
 * when NO non-tuple struct in the module has the same shallow layout (field
 * mutability + value kind, ref targets and super/final ignored). That key is a
 * sound over-approximation of canonical equality, so an admitted tuple can
 * never make a non-tuple value an array; a colliding tuple keeps today's
 * `false`.
 *
 * Tuple field types are immutable while every user object/fnctor/class field is
 * `mut`, so the guard practically never declines a tuple against a user shape;
 * it exists for the compiler's immutable runtime records.
 */
import type { StructTypeDef } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

function shallowLayoutKey(def: StructTypeDef): string {
  return def.fields.map((f) => `${f.mutable ? "m" : ""}${f.type.kind}`).join(",");
}

/** Tuple struct types that `__extern_is_array` may claim without aliasing a non-tuple. */
export function collectTupleArrayCarrierTypeIdxs(ctx: CodegenContext): number[] {
  if (ctx.tupleTypeMap.size === 0) return [];
  const tupleIdxs = new Set(ctx.tupleTypeMap.values());
  const foreignKeys = new Set<string>();
  for (let i = 0; i < ctx.mod.types.length; i++) {
    const def = ctx.mod.types[i];
    if (def?.kind !== "struct" || tupleIdxs.has(i)) continue;
    foreignKeys.add(shallowLayoutKey(def));
  }
  const out: number[] = [];
  for (const typeIdx of tupleIdxs) {
    const def = ctx.mod.types[typeIdx];
    if (def?.kind !== "struct" || def.fields.length === 0) continue;
    if (foreignKeys.has(shallowLayoutKey(def))) continue;
    out.push(typeIdx);
  }
  return out.sort((a, b) => a - b);
}
