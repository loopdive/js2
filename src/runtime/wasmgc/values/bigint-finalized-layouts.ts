// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { StructTypeDef } from "../../../wasm/model/module-records.js";
import type { NativeDeclaredType } from "./native-resource-declaration-types.js";
import { buildWideBigIntType, declareWideBigIntType } from "./bigint-carrier-layouts.js";

/**
 * The standalone emitted ABI after legacy leaf finalization and ref widening.
 * The raw donor declaration remains separate. Canonical constructors always
 * install a real magnitude array; nullable storage does not authorize null
 * magnitudes or a general BigInt producer. This concrete leaf cannot be extended.
 */
export function buildFinalizedWideBigIntType(baseTypeIdx: number, limbsTypeIdx: number): StructTypeDef {
  const raw = buildWideBigIntType(baseTypeIdx, limbsTypeIdx);
  return {
    ...raw,
    final: true,
    fields: [raw.fields[0]!, raw.fields[1]!, { ...raw.fields[2]!, type: { kind: "ref_null", typeIdx: limbsTypeIdx } }],
  };
}

/** The same finalized shape bound to the actual issued base and array keys. */
export function declareFinalizedWideBigIntType(baseKey: string, limbsKey: string): NativeDeclaredType {
  const raw = declareWideBigIntType(baseKey, limbsKey);
  if (raw.kind !== "struct") throw new Error("BigInt wide declaration is not a struct");
  return {
    ...raw,
    final: true,
    fields: [raw.fields[0]!, raw.fields[1]!, { ...raw.fields[2]!, type: { kind: "ref_null", typeKey: limbsKey } }],
  };
}
