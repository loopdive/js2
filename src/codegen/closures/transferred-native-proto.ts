// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

export interface TransferredNativeReceiverEntry {
  typeIdx: number;
  funcTypeIdx: number;
}

/**
 * Native-prototype closures carry an internal receiver before user arguments.
 * Keep the residual arity-2 bridge exact to the substring metadata singleton.
 */
export function collectTransferredSubstringReceivers(
  ctx: CodegenContext,
  arity: number,
): TransferredNativeReceiverEntry[] {
  if (arity !== 2) return [];
  const entries: TransferredNativeReceiverEntry[] = [];
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (
      info.paramTypes.length === 3 &&
      ctx.nativeProtoReceiverClosureStructTypes?.has(typeIdx) &&
      ctx.builtinFnMetaByTypeIdx?.get(typeIdx)?.name === "substring"
    ) {
      entries.push({ typeIdx, funcTypeIdx: info.funcTypeIdx });
    }
  }
  return entries;
}

export function resolveClosureBaseWrapperTypeIdx(
  ctx: CodegenContext,
  arity: number,
  initial: number | undefined,
): number | undefined {
  if (initial !== undefined) return initial;
  for (const [typeIdx] of ctx.closureInfoByTypeIdx) {
    const typeDef = ctx.mod.types[typeIdx];
    if (typeDef && typeDef.kind === "struct" && typeDef.superTypeIdx === -1) return typeIdx;
  }
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.paramTypes.length === arity) return typeIdx;
  }
  return undefined;
}

/**
 * Build the special method-call arm that supplies `(self, thisVal, start, end)`.
 * The structural ref.test is only a family guard, so immutable bfnid is checked
 * before invocation. The saved current-this value is restored before return.
 */
export function buildTransferredSubstringCallInstrs(
  entries: TransferredNativeReceiverEntry[],
  anyLocal: number,
  resultSaveLocal: number,
  prevThisLocal: number,
  currentThisGlobalIdx: number,
): Instr[] {
  const body: Instr[] = [];
  for (const entry of entries) {
    body.push(
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: entry.typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: entry.typeIdx },
          { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: 3 },
          { op: "i32.const", value: entry.typeIdx },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: anyLocal },
              { op: "ref.cast", typeIdx: entry.typeIdx },
              { op: "local.get", index: 0 },
              { op: "local.get", index: 2 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: anyLocal },
              { op: "ref.cast", typeIdx: entry.typeIdx },
              { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: 0 },
              { op: "ref.cast", typeIdx: entry.funcTypeIdx },
              { op: "call_ref", typeIdx: entry.funcTypeIdx },
              { op: "local.set", index: resultSaveLocal },
              { op: "local.get", index: prevThisLocal },
              { op: "global.set", index: currentThisGlobalIdx },
              { op: "local.get", index: resultSaveLocal },
              { op: "return" },
            ],
          },
        ],
      },
    );
  }
  return body;
}
