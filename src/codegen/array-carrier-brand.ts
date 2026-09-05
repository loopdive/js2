// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4556) §7.2.2 IsArray over ONE statically-known WasmGC struct type.
 *
 * The single-type companion to `collectStandaloneArrayCarrierTypeIdxs`
 * (object-runtime.ts), which answers the same question for the whole module at
 * finalize time and fills the runtime `__extern_is_array` predicate. Both apply
 * the identical exclusions, so the STATIC arm and the DYNAMIC arm cannot
 * disagree about what an Array is.
 *
 * The defect it closes: the compile-time `Array.isArray(x)` arm in
 * `call-builtin-static.ts` answered `ref`/`ref_null` ⇒ `true` — i.e. "any GC
 * reference is an array". In standalone every non-primitive is a GC ref, so
 * `Array.isArray("abc")`, `Array.isArray({0:12,length:2})` and
 * `Array.isArray(new Date(0))` all answered `true`.
 */
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { getArgumentsVecTypeIdx } from "./arguments-carrier-brand.js";
import { NON_ARRAY_BYTE_VEC_ELEM_KINDS } from "./object-runtime.js";

/** True when `t` is a reference to a struct that is a real Array carrier. */
export function isArrayCarrierValType(ctx: CodegenContext, t: ValType): boolean {
  if (t.kind !== "ref" && t.kind !== "ref_null") return false;
  const typeIdx = (t as { typeIdx: number }).typeIdx;
  if (typeIdx < 0) return false;
  // `arguments` uses a vec-compatible nominal subtype so indexed/length
  // lowering remains shared, but §7.2.2 IsArray must reject that brand.
  if (typeIdx === getArgumentsVecTypeIdx(ctx)) return false;
  if (ctx.objectRuntimeTypes && typeIdx === ctx.objectRuntimeTypes.objVecTypeIdx) return true;
  const typeDef = ctx.mod.types[typeIdx];
  if (!typeDef || typeDef.kind !== "struct") return false;
  const name = typeDef.name ?? "";
  if (name === "__vec_base") return false; // abstract supertype of EVERY vec
  // §7.2.2 — the packed byte carriers back ArrayBuffer / DataView /
  // Uint8Array / Int32Array, none of which is an Array.
  for (const elemKind of NON_ARRAY_BYTE_VEC_ELEM_KINDS) {
    if (name === `__vec_${elemKind}`) return false;
  }
  return name.startsWith("__vec_") || name === "__template_vec_externref";
}

/**
 * Normalize an `externref`-expected Array.isArray operand for the runtime
 * carrier test. Concrete GC references remain candidates; scalar values emit
 * the already-known false result and tell the caller not to run the test.
 */
export function retainArrayIsArrayExternrefCandidate(fctx: FunctionContext, type: ValType | null): boolean {
  if (type === null || type.kind === "externref") return true;
  if (type.kind === "ref" || type.kind === "ref_null" || type.kind === "anyref") {
    fctx.body.push({ op: "extern.convert_any" });
    return true;
  }
  fctx.body.push({ op: "drop" }, { op: "i32.const", value: 0 });
  return false;
}
