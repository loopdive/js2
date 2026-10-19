// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { canonicalUndefinedExternInstrs } from "../any-helpers.js";

/**
 * Native Object.assign value body for the canonical variadic builtin ABI.
 * Param 0 is self; param 1 is the complete externref argument vector.
 * Helpers and physical indices must already be reserved before body emission.
 */
export function emitObjectAssignValueBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecTypeIdx: number,
  arrTypeIdx: number,
): boolean {
  const newIdx = ctx.funcMap.get("__objvec_new");
  const pushIdx = ctx.funcMap.get("__objvec_push");
  const assignIdx = ctx.funcMap.get("__object_assign");
  if (newIdx === undefined || pushIdx === undefined || assignIdx === undefined || arrTypeIdx < 0) return false;
  const count = allocLocal(fctx, "assign_count", { kind: "i32" });
  const index = allocLocal(fctx, "assign_index", { kind: "i32" });
  const array = allocLocal(fctx, "assign_args", { kind: "ref_null", typeIdx: arrTypeIdx });
  const target = allocLocal(fctx, "assign_target", { kind: "externref" });
  const sources = allocLocal(fctx, "assign_sources", { kind: "externref" });
  const appendSources: Instr[] = [
    { op: "local.get", index },
    { op: "local.get", index: count },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: sources },
    { op: "local.get", index: array },
    { op: "ref.as_non_null" },
    { op: "local.get", index },
    { op: "array.get", typeIdx: arrTypeIdx },
    { op: "call", funcIdx: pushIdx },
    { op: "local.get", index },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index },
    { op: "br", depth: 0 },
  ];
  fctx.body.push(
    ...canonicalUndefinedExternInstrs(ctx),
    { op: "local.set", index: target },
    { op: "call", funcIdx: newIdx },
    { op: "local.set", index: sources },
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.tee", index: count },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
            { op: "local.tee", index: array },
            { op: "i32.const", value: 0 },
            { op: "array.get", typeIdx: arrTypeIdx },
            { op: "local.set", index: target },
            { op: "i32.const", value: 1 },
            { op: "local.set", index },
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [{ op: "loop", blockType: { kind: "empty" }, body: appendSources }],
            },
          ],
        },
      ],
    },
    { op: "local.get", index: target },
    { op: "local.get", index: sources },
    { op: "call", funcIdx: assignIdx },
  );
  return true;
}

/** Select the identity-backed boundary primitive or the existing native MOP. */
export function objectAssignSourceKeys(layout: {
  sourceLocal: number;
  firstLocal: number;
  admissionIdx: number | undefined;
  boundaryKeysIdx: number | undefined;
  proxyKeysIdx: number | undefined;
  objectKeysIdx: number;
}): {
  locals: { name: string; type: ValType }[];
  keyListLocal: number;
  keyListLengthLocal: number;
  keyIndexLocal: number;
  keyLocal: number;
  descriptorLocal: number;
  enumerableLocal: number;
  admissionTest: Instr[];
  keys: Instr[];
} {
  const keyListLocal = layout.firstLocal;
  const keyListLengthLocal = keyListLocal + 1;
  const keyIndexLocal = keyListLocal + 2;
  const keyLocal = keyListLocal + 3;
  const descriptorLocal = keyListLocal + 4;
  const enumerableLocal = keyListLocal + 5;
  const admittedLocal = keyListLocal + 6;
  const locals: { name: string; type: ValType }[] = [
    { name: "proxyKeys", type: { kind: "externref" } },
    { name: "proxyKeysLength", type: { kind: "i32" } },
    { name: "proxyKeyIndex", type: { kind: "i32" } },
    { name: "proxyKey", type: { kind: "externref" } },
    { name: "proxyDescriptor", type: { kind: "externref" } },
    { name: "proxyEnumerable", type: { kind: "externref" } },
  ];
  const slots = { locals, keyListLocal, keyListLengthLocal, keyIndexLocal, keyLocal, descriptorLocal, enumerableLocal };
  const nativeKeys = (): Instr[] => [
    { op: "local.get", index: layout.sourceLocal },
    ...(layout.proxyKeysIdx !== undefined
      ? ([{ op: "ref.null.extern" }, { op: "call", funcIdx: layout.proxyKeysIdx }] satisfies Instr[])
      : ([{ op: "call", funcIdx: layout.objectKeysIdx }] satisfies Instr[])),
  ];
  if (layout.admissionIdx === undefined || layout.boundaryKeysIdx === undefined) {
    return { ...slots, admissionTest: [], keys: nativeKeys() };
  }
  locals.push({ name: "sourceAdmitted", type: { kind: "i32" } });
  return {
    ...slots,
    admissionTest: [
      { op: "local.get", index: layout.sourceLocal },
      { op: "call", funcIdx: layout.admissionIdx },
      { op: "local.tee", index: admittedLocal },
      { op: "i32.or" },
    ],
    keys: [
      { op: "local.get", index: admittedLocal },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "local.get", index: layout.sourceLocal },
          { op: "call", funcIdx: layout.boundaryKeysIdx },
        ],
        else: nativeKeys(),
      },
    ],
  };
}
