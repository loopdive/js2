// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Standalone Array-prototype provenance for raw function-constructor instances.
 *
 * A reconstructed `new F()` can flow as a raw `__fnctor_F` carrier while the
 * live value assigned to `F.prototype` is held in a module global. These small
 * finalize-time builders let the method dispatcher and array-like readers agree
 * that an Array-valued prototype supplies Array methods and inherited indices.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Build the runtime predicate for a vec, ObjVec, or fnctor with an Array prototype. */
export function buildFnctorArrayHofTargetTest(
  ctx: CodegenContext,
  receiverAnyLocal: number,
  vecBaseTypeIdx: number,
  objVecTypeIdx: number,
): Instr[] {
  const test: Instr[] = [
    { op: "local.get", index: receiverAnyLocal },
    { op: "ref.test", typeIdx: vecBaseTypeIdx },
    { op: "local.get", index: receiverAnyLocal },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    { op: "i32.or" },
  ];
  for (const [fnctorName, protoGlobalIdx] of ctx.fnctorPrototypeObject) {
    const fnctorTypeIdx = ctx.structMap.get(`__fnctor_${fnctorName}`);
    if (fnctorTypeIdx === undefined) continue;
    test.push(
      { op: "local.get", index: receiverAnyLocal },
      { op: "ref.test", typeIdx: fnctorTypeIdx },
      { op: "global.get", index: protoGlobalIdx },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: vecBaseTypeIdx },
      { op: "global.get", index: protoGlobalIdx },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: objVecTypeIdx },
      { op: "i32.or" },
      { op: "i32.and" },
      { op: "i32.or" },
    );
  }
  return test;
}

/** Resolve `__fnctor_F` to the live `F.prototype` global, if one was materialized. */
export function fnctorPrototypeGlobalForStruct(ctx: CodegenContext, structName: string): number | undefined {
  return structName.startsWith("__fnctor_")
    ? ctx.fnctorPrototypeObject.get(structName.slice("__fnctor_".length))
    : undefined;
}

/** Read and box an own closed-struct index, or return the supplied undefined miss. */
export function closedStructIndexValue(
  receiverAnyLocal: number,
  typeIdx: number,
  fieldIdx: number,
  box: Instr[] | null,
  ordinaryMiss: Instr[],
): Instr[] {
  return box === null
    ? ordinaryMiss
    : [
        { op: "local.get", index: receiverAnyLocal },
        { op: "ref.cast", typeIdx },
        { op: "struct.get", typeIdx, fieldIdx },
        ...box,
      ];
}

/** Continue an indexed Get miss at the live fnctor prototype. */
export function fnctorGetIndexMiss(
  protoGlobalIdx: number | undefined,
  getIdxFuncIdx: number | undefined,
  indexLocal: number,
  ordinaryMiss: Instr[],
): Instr[] {
  return protoGlobalIdx !== undefined && getIdxFuncIdx !== undefined
    ? [
        { op: "global.get", index: protoGlobalIdx },
        { op: "local.get", index: indexLocal },
        { op: "call", funcIdx: getIdxFuncIdx },
      ]
    : ordinaryMiss;
}

/** Seed an indexed HasProperty result from the live fnctor prototype. */
export function fnctorHasIndexSeed(
  protoGlobalIdx: number | undefined,
  hasIdxFuncIdx: number | undefined,
  indexLocal: number,
): Instr[] {
  return protoGlobalIdx !== undefined && hasIdxFuncIdx !== undefined
    ? [
        { op: "global.get", index: protoGlobalIdx },
        { op: "local.get", index: indexLocal },
        { op: "call", funcIdx: hasIdxFuncIdx },
      ]
    : [{ op: "i32.const", value: 0 }];
}
