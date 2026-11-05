// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { asVal, type IrType } from "../../ir/nodes.js";
import type { IrUnitId } from "../../ir/identity.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { nativeDynamicExternrefAvailable } from "./ir-dynamic-parameter-abi.js";
import { getOrRegisterVecType } from "../registry/types.js";
import { samePhysicalValType } from "../struct-hierarchy-layout.js";

interface PreparedSignatureOptions {
  readonly allowOpaqueExternrefValue?: boolean;
  readonly allowDynamicExternrefValue?: boolean;
}

/** Admission vocabulary; the allocated Program ABI slot remains the final proof. */
export function preparedSignatureOptions(ctx: CodegenContext, isGenerator: boolean): PreparedSignatureOptions {
  return {
    allowOpaqueExternrefValue: isGenerator,
    allowDynamicExternrefValue: nativeDynamicExternrefAvailable(ctx),
  };
}

export function r2StableSignatureType(type: IrType | null, options?: PreparedSignatureOptions): boolean {
  if (type === null || type.kind === "string") return true;
  if (type.kind === "dynamic") return options?.allowDynamicExternrefValue === true;
  // #2951 generator owners — the source return contract of a `function*` is the
  // opaque generator object, which both front-ends project to the same physical
  // `externref`. Only the generator admission path opts in; every other owner
  // keeps the narrower vocabulary so an unproven reference contract cannot
  // silently enter preparation.
  if (options?.allowOpaqueExternrefValue === true && asVal(type)?.kind === "externref") return true;
  // #3522 returned-closure ownership — an exact callable source boundary is
  // the same canonical externref contract in both backends. Admit the owner to
  // prepare-before-emit so its inventoried lifted literal is allocated inside
  // the sealed component instead of relying on a direct-body closure slot.
  if (type.kind === "callable") return true;
  // #3522 Builtins retirement — opaque host-class contracts have one
  // backend-independent physical representation in the JS-host lane:
  // externref. Admission is still fail-closed because
  // r2SignatureMatchesAllocatedSlot compares that projection with the exact
  // Program ABI slot before preparation can replace the direct body.
  if (type.kind === "extern") return true;
  if (type.kind === "vec") {
    const element = asVal(type.elementType);
    return element?.kind === "f64" || element?.kind === "i32";
  }
  const val = asVal(type);
  return val?.kind === "f64" || val?.kind === "i32";
}

function r2StableValType(ctx: CodegenContext, type: IrType, options?: PreparedSignatureOptions): ValType | undefined {
  if (type.kind === "extern" || type.kind === "callable") return { kind: "externref" };
  if (type.kind === "dynamic" && options?.allowDynamicExternrefValue) return { kind: "externref" };
  if (options?.allowOpaqueExternrefValue === true && asVal(type)?.kind === "externref") {
    return { kind: "externref" };
  }
  if (type.kind === "string") {
    if (!ctx.nativeStrings) return { kind: "externref" };
    return ctx.anyStrTypeIdx >= 0 ? { kind: "ref", typeIdx: ctx.anyStrTypeIdx } : undefined;
  }
  if (type.kind === "vec") {
    const element = asVal(type.elementType);
    if (!element || (element.kind !== "f64" && element.kind !== "i32")) return undefined;
    const vecTypeIdx = getOrRegisterVecType(ctx, element.kind, element);
    return { kind: type.nullable ? "ref_null" : "ref", typeIdx: vecTypeIdx };
  }
  const val = asVal(type);
  return val?.kind === "f64" || val?.kind === "i32" ? val : undefined;
}

/**
 * Preparation may replace an empty declaration slot before direct emission,
 * but it must not change that slot's already allocated callable ABI. The
 * Program ABI registry observes the allocation contract, and later direct
 * callers/exports can already depend on it even when the body is still empty.
 */
export function r2SignatureMatchesAllocatedSlot(
  ctx: CodegenContext,
  unitId: IrUnitId,
  override: { readonly params: readonly IrType[]; readonly returnType: IrType | null },
  options?: PreparedSignatureOptions,
): boolean {
  const func = ctx.programAbiSourceCallables?.functionForUnit(unitId);
  const signature = func === undefined ? undefined : ctx.mod.types[func.typeIdx];
  if (!signature || signature.kind !== "func") return false;
  const params = override.params.map((type) => r2StableValType(ctx, type, options));
  const result = override.returnType === null ? null : r2StableValType(ctx, override.returnType, options);
  if (
    params.some((type) => type === undefined) ||
    result === undefined ||
    signature.params.length !== params.length ||
    signature.results.length !== (override.returnType === null ? 0 : 1)
  ) {
    return false;
  }
  return (
    signature.params.every((type, index) => samePhysicalValType(type, params[index]!)) &&
    (result === null || samePhysicalValType(signature.results[0]!, result))
  );
}
